#!/usr/bin/env node
// Supply-chain inspection for the T-009 candidate workspaces (plan §3).
//
// The question this answers: can each SDK closure be installed and used WITHOUT executing any
// lifecycle hook or native build — and does anything in the closure even ask for one?
//
// Order matters, and it is the whole design:
//
//   1. Read the workspace lockfile — the record of intent.
//   2. FETCH every locked tarball and VERIFY its integrity digest against the lockfile before
//      unpacking. A lockfile names content; an unverified download is not that content.
//   3. Unpack into OS scratch and inspect EVERY manifest in the closure, plus tarball-only
//      files (`binding.gyp`) that `npm view` and `pack --dry-run` cannot see. Nothing fetched
//      is ever executed.
//   4. Only after that does anyone run `npm ci --ignore-scripts` — and the installed tree is
//      then rescanned BY PATH (T-008's traversal; keying by name collapses versions and skips
//      nested copies).
//
// Inspection here means reading bytes. There is no `npm install` of the fetched artifacts, no
// `require()` of them, no child process from their contents.

import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(join(HERE, "..", ".."));

// The hooks the gate prohibits. `prepare`/`prepack` are absent on purpose: they do not run for
// registry consumers, and this repo itself requires them.
export const FORBIDDEN_SCRIPTS = ["preinstall", "install", "postinstall"];

/** Every dependency entry of a v3 lockfile: name, version, resolved URL, integrity digest. */
export function lockEntries(lockfilePath) {
  const lock = JSON.parse(readFileSync(lockfilePath, "utf8"));
  const entries = [];
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue; // the workspace itself
    if (!info.resolved || !info.integrity) {
      throw new Error(`lockfile entry ${path} has no resolved+integrity — cannot verify`);
    }
    entries.push({
      path,
      name: path.replace(/^.*node_modules\//, ""),
      version: info.version,
      resolved: info.resolved,
      integrity: info.integrity,
    });
  }
  if (entries.length === 0) throw new Error(`lockfile ${lockfilePath} resolves nothing`);
  return entries;
}

/** sha512-BASE64 / sha256-BASE64 verification of raw tarball bytes. */
export function verifyIntegrity(buf, integrity) {
  const [algo, expected] = integrity.split("-", 2);
  if (!["sha512", "sha256", "sha1"].includes(algo)) {
    throw new Error(`unsupported integrity algorithm ${algo}`);
  }
  const actual = createHash(algo).update(buf).digest("base64");
  return actual === expected;
}

/**
 * Inspect one UNPACKED package directory for anything that would execute at install time:
 * forbidden lifecycle scripts, a gypfile flag, or a `binding.gyp` on disk — the last being a
 * tarball fact, not a manifest fact, which is why fetching was necessary at all.
 */
export function inspectUnpacked(dir, label) {
  const violations = [];
  const manifestPath = join(dir, "package", "package.json");
  if (!existsSync(manifestPath)) {
    // A package with no manifest cannot declare itself harmless; that is a violation, not a skip.
    return [{ package: label, kind: "missing-manifest" }];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const hook of FORBIDDEN_SCRIPTS) {
    if (manifest.scripts?.[hook] !== undefined) {
      violations.push({ package: label, kind: `script:${hook}` });
    }
  }
  if (manifest.gypfile) violations.push({ package: label, kind: "gypfile-flag" });
  if (existsSync(join(dir, "package", "binding.gyp"))) {
    violations.push({ package: label, kind: "binding.gyp" });
  }
  return violations;
}

/**
 * Fetch + verify + unpack + inspect one closure. `fetchTarball` is injectable so the corrupted-
 * digest fixture can prove verification fails without a network round trip; production passes
 * nothing and gets real HTTPS fetches.
 */
export async function inspectClosure(lockfilePath, { fetchTarball } = {}) {
  const entries = lockEntries(lockfilePath);
  const scratch = mkdtempSync(join(tmpdir(), "mcp-supply-"));
  chmodSync(scratch, 0o700);
  // The scratch invariant the plan requires, asserted rather than assumed.
  if (realpathSync(scratch).startsWith(REPO + "/")) {
    throw new Error("scratch resolved inside the repository");
  }
  const fetchOne =
    fetchTarball ??
    (async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });

  try {
    const violations = [];
    let verified = 0;
    for (const entry of entries) {
      const buf = await fetchOne(entry.resolved, entry);
      if (!verifyIntegrity(buf, entry.integrity)) {
        throw new Error(
          `integrity mismatch for ${entry.name}@${entry.version} — refusing to unpack`,
        );
      }
      verified++;
      const dest = join(scratch, `${verified}`);
      mkdirSync(dest);
      const tarPath = join(dest, "pkg.tgz");
      writeFileSync(tarPath, buf);
      const t = spawnSync("tar", ["-xzf", tarPath, "-C", dest], { encoding: "utf8" });
      if (t.status !== 0) throw new Error(`tar failed for ${entry.name}: ${t.stderr}`);
      violations.push(...inspectUnpacked(dest, `${entry.name}@${entry.version}`));
    }
    return { packages: entries.length, verified, violations };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const results = {};
  for (const candidate of ["v1", "v2"]) {
    const lockfile = join(HERE, "candidates", candidate, "package-lock.json");
    const r = await inspectClosure(lockfile);
    results[candidate] = r;
    const status = r.violations.length === 0 ? "clean" : "VIOLATIONS";
    process.stderr.write(
      `${candidate}: ${r.packages} packages fetched, ${r.verified} integrity-verified, ${status}\n`,
    );
    for (const v of r.violations) process.stderr.write(`  ${v.package}: ${v.kind}\n`);
  }
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  const bad = Object.values(results).some((r) => r.violations.length > 0);
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
