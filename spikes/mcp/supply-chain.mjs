#!/usr/bin/env node
// Supply-chain inspection for the T-009 candidate workspaces (plan §3).
//
// The question this answers: can each SDK closure be installed and used WITHOUT executing any
// lifecycle hook or native build — and does anything in the closure even ask for one?
//
// Order matters, and it is the whole design:
//
//   1. Read the workspace lockfile — the record of intent. Every resolved URL must be HTTPS
//      to an allowlisted registry host, with redirects refused: a tampered lockfile must not
//      be able to point CI at internal or link-local services (review round 1).
//   2. FETCH every locked tarball (bounded in time and bytes) and VERIFY its integrity digest
//      against the lockfile before anything touches its contents. A lockfile names content;
//      an unverified download is not that content.
//   3. VALIDATE the archive's members — paths confined under package/, regular files and
//      directories only, bounded counts and expanded size — then unpack into OS scratch and
//      inspect EVERY manifest in the closure, plus tarball-only files (`binding.gyp`) that
//      `npm view` and `pack --dry-run` cannot see. Integrity proves the bytes match the
//      lockfile, not that the archive is safe to extract; a malicious lockfile can name a
//      malicious archive, so members are checked before tar writes anything (review round 1).
//      Nothing fetched is ever executed.
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
import { join, dirname, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(join(HERE, "..", ".."));

// The hooks the gate prohibits. `prepare`/`prepack` are absent on purpose: they do not run for
// registry consumers, and this repo itself requires them.
export const FORBIDDEN_SCRIPTS = ["preinstall", "install", "postinstall"];

// Where locked tarballs are allowed to come from. Everything else — other hosts, plain HTTP,
// or a redirect (refused wholesale rather than validated hop-by-hop) — is a hard error.
export const REGISTRY_HOSTS = ["registry.npmjs.org"];

// Bounds. A slow response, an oversized download, or an archive bomb must fail the gate, not
// hang it or exhaust the machine. The expanded-size bound reads gzip's trailing ISIZE field —
// a liar's value only delays failure to the extraction timeout, so it is a first line, not
// the only one.
export const FETCH_TIMEOUT_MS = 60_000;
export const MAX_TARBALL_BYTES = 30_000_000;
export const MAX_ARCHIVE_MEMBERS = 10_000;
export const MAX_EXPANDED_BYTES = 200_000_000;
const EXTRACT_TIMEOUT_MS = 120_000;

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

/** HTTPS to an allowlisted registry host, or refusal. Runs BEFORE any fetch — including an
 *  injected one, so the fixtures exercise the same boundary production does. */
export function validateResolvedUrl(resolved, label) {
  let url;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error(`${label}: lockfile resolved URL is unparseable`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label}: refusing non-HTTPS resolved URL (${url.protocol})`);
  }
  if (!REGISTRY_HOSTS.includes(url.hostname)) {
    throw new Error(`${label}: refusing resolved URL host ${url.hostname} — not an allowlisted registry`);
  }
  return url;
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

/** One archive member path: confined under package/, no absolute paths, no `..` escapes. */
export function checkMemberPath(memberPath, label) {
  if (memberPath.startsWith("/")) {
    throw new Error(`${label}: absolute archive member path refused`);
  }
  const segments = memberPath.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new Error(`${label}: archive member path escapes via '..' — refused`);
  }
  if (segments[0] !== "package") {
    throw new Error(`${label}: archive member outside package/ refused`);
  }
}

/**
 * Validate archive members BEFORE extraction, from tar's own listings: `-tf` for exact paths,
 * `-tvf` (same order) for member types. Regular files and directories only — a symlink,
 * hardlink, device or FIFO in a package tarball is an escape vector, not a package.
 */
function validateArchiveMembers(tarPath, label) {
  const list = (flags) =>
    spawnSync("tar", [flags, tarPath], { encoding: "utf8", timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const paths = list("-tf");
  const details = list("-tvf");
  if (paths.status !== 0 || details.status !== 0) {
    throw new Error(`${label}: tar listing failed: ${paths.stderr || details.stderr}`);
  }
  const pathLines = paths.stdout.split("\n").filter((l) => l !== "");
  const detailLines = details.stdout.split("\n").filter((l) => l !== "");
  if (pathLines.length !== detailLines.length) {
    throw new Error(`${label}: tar listings disagree (${pathLines.length} vs ${detailLines.length} members)`);
  }
  if (pathLines.length > MAX_ARCHIVE_MEMBERS) {
    throw new Error(`${label}: archive has ${pathLines.length} members (limit ${MAX_ARCHIVE_MEMBERS})`);
  }
  for (let i = 0; i < pathLines.length; i++) {
    const type = detailLines[i][0];
    if (type !== "-" && type !== "d") {
      throw new Error(`${label}: archive member of type '${type}' refused — regular files and directories only`);
    }
    if (detailLines[i].includes(" -> ") || detailLines[i].includes(" link to ")) {
      throw new Error(`${label}: linked archive member refused`);
    }
    checkMemberPath(pathLines[i].replace(/\/$/, ""), label);
  }
}

/** gzip's trailing ISIZE (expanded size mod 2^32) as a first-line bomb check. */
function checkExpandedSize(buf, label) {
  if (buf.length >= 18 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const isize = buf.readUInt32LE(buf.length - 4);
    if (isize > MAX_EXPANDED_BYTES) {
      throw new Error(`${label}: archive claims ${isize} expanded bytes (limit ${MAX_EXPANDED_BYTES})`);
    }
  }
}

/** The extraction stage: validate members, then unpack under a timeout. Injectable in tests
 *  so ordering (verify-then-extract) is provable at this exact boundary. */
function defaultExtract(tarPath, dest, label) {
  validateArchiveMembers(tarPath, label);
  const t = spawnSync("tar", ["-xzf", tarPath, "-C", dest], { encoding: "utf8", timeout: EXTRACT_TIMEOUT_MS });
  if (t.error) throw new Error(`${label}: tar extraction ${t.error.code === "ETIMEDOUT" ? "timed out" : `failed: ${t.error.message}`}`);
  if (t.status !== 0) throw new Error(`${label}: tar failed: ${t.stderr}`);
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
 * Fetch + verify + validate + unpack + inspect one closure. `fetchTarball` is injectable so
 * the corrupted-digest fixture can prove verification fails without a network round trip;
 * `extract` is injectable so the verify-BEFORE-extract ordering is provable. Production
 * passes neither and gets bounded HTTPS fetches plus the validating extractor.
 */
export async function inspectClosure(lockfilePath, { fetchTarball, extract } = {}) {
  const entries = lockEntries(lockfilePath);
  const fetchOne =
    fetchTarball ??
    (async (url) => {
      const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const parts = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TARBALL_BYTES) throw new Error(`fetch ${url}: exceeds ${MAX_TARBALL_BYTES} bytes`);
        parts.push(Buffer.from(value));
      }
      return Buffer.concat(parts);
    });
  const extractOne = extract ?? defaultExtract;

  const scratch = mkdtempSync(join(tmpdir(), "mcp-supply-"));
  try {
    // Everything after creation sits inside the guarded lifecycle: a failing chmod or a
    // scratch that resolves into the repository still gets cleaned up (review round 1).
    chmodSync(scratch, 0o700);
    const scratchReal = realpathSync(scratch);
    if (scratchReal === REPO || scratchReal.startsWith(REPO + sep)) {
      throw new Error("scratch resolved inside the repository");
    }
    const violations = [];
    let verified = 0;
    for (const entry of entries) {
      const label = `${entry.name}@${entry.version}`;
      validateResolvedUrl(entry.resolved, label);
      const buf = await fetchOne(entry.resolved, entry);
      if (buf.length > MAX_TARBALL_BYTES) {
        throw new Error(`${label}: tarball exceeds ${MAX_TARBALL_BYTES} bytes — refusing`);
      }
      if (!verifyIntegrity(buf, entry.integrity)) {
        throw new Error(`integrity mismatch for ${label} — refusing to unpack`);
      }
      checkExpandedSize(buf, label);
      verified++;
      const dest = join(scratch, `${verified}`);
      mkdirSync(dest);
      const tarPath = join(dest, "pkg.tgz");
      writeFileSync(tarPath, buf);
      extractOne(tarPath, dest, label);
      violations.push(...inspectUnpacked(dest, label));
    }
    return { packages: entries.length, verified, violations };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  // No short-circuiting between candidates (§1): an error inspecting v1 is v1's recorded
  // result, and v2 still runs — losing an independently runnable candidate's evidence to a
  // sibling's failure was a review-round-1 defect.
  const results = {};
  let bad = false;
  for (const candidate of ["v1", "v2"]) {
    const lockfile = join(HERE, "candidates", candidate, "package-lock.json");
    try {
      const r = await inspectClosure(lockfile);
      results[candidate] = r;
      if (r.violations.length > 0) bad = true;
      const status = r.violations.length === 0 ? "clean" : "VIOLATIONS";
      process.stderr.write(
        `${candidate}: ${r.packages} packages fetched, ${r.verified} integrity-verified, ${status}\n`,
      );
      for (const v of r.violations) process.stderr.write(`  ${v.package}: ${v.kind}\n`);
    } catch (error) {
      results[candidate] = { error: String(error?.message ?? error) };
      bad = true;
      process.stderr.write(`${candidate}: ERROR — ${results[candidate].error}\n`);
    }
  }
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
