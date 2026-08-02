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
  readdirSync,
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
import { createGunzip } from "node:zlib";
import { isDirectEntry } from "../../scripts/direct-entry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(join(HERE, "..", ".."));

// The hooks the gate prohibits. `prepare`/`prepack` are absent on purpose: they do not run for
// registry consumers, and this repo itself requires them.
export const FORBIDDEN_SCRIPTS = ["preinstall", "install", "postinstall"];

// Where locked tarballs are allowed to come from. Everything else — other hosts, plain HTTP,
// or a redirect (refused wholesale rather than validated hop-by-hop) — is a hard error.
export const REGISTRY_HOSTS = ["registry.npmjs.org"];

// Integrity algorithms this gate will verify, STRONGEST FIRST. sha1 is deliberately absent:
// it is collision-broken, so a lockfile naming a sha1 digest names bytes an attacker can
// choose. Both real candidate lockfiles are sha512 throughout, so refusing sha1 costs nothing
// here and removes the option of downgrading to it (review round 2, chunk 13).
export const SRI_ALGORITHMS = ["sha512", "sha384", "sha256"];

// Entries that legitimately appear inside a node_modules directory without being a package.
// Anything else hidden there is recorded rather than skipped: the previous walk skipped every
// dot-directory silently, which is a place to hide a package from the scan.
export const KNOWN_METADATA_ENTRIES = new Set([".bin", ".cache", ".package-lock.json", ".modules.yaml"]);

// Bounds. A slow response, an oversized download, or an archive bomb must fail the gate, not
// hang it or exhaust the machine. The expanded-size bound is MEASURED by decompressing the
// archive through a counter that aborts the moment it is exceeded — nothing is written to disk
// to find out. It used to read gzip's trailing ISIZE field, which is the last member's size
// modulo 2^32: concatenating a 5 MB member with a 1-byte member reported 1 (demonstrated in
// review round 2, chunk 13), and the only remaining line of defence was an extraction timeout,
// which bounds seconds and not bytes.
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

/**
 * HTTPS to an allowlisted registry ORIGIN, or refusal. Runs BEFORE any fetch — including an
 * injected one, so the fixtures exercise the same boundary production does.
 *
 * Origin, not hostname (review round 2, chunk 13). Checking `url.hostname` alone accepted
 * `https://registry.npmjs.org:8443/...`, which is a different service on the same name, and it
 * accepted a URL carrying userinfo — a username and password written before the host — which
 * hands credentials out of a lockfile-controlled string to whatever answers. Neither is "the
 * npm registry"; both passed.
 */
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
  if (url.port !== "" && url.port !== "443") {
    throw new Error(`${label}: refusing resolved URL port ${url.port} — the registry is reached on 443`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label}: refusing resolved URL carrying credentials`);
  }
  if (url.hash !== "") {
    throw new Error(`${label}: refusing resolved URL carrying a fragment`);
  }
  return url;
}

/**
 * Verify raw tarball bytes against a Subresource Integrity string.
 *
 * `integrity` is an SRI list, not one digest: npm may emit several whitespace-separated
 * entries, each `algorithm-base64` with optional `?options`. The previous implementation was
 * `integrity.split("-", 2)`, which meant a legitimate multi-digest string failed as an
 * "integrity mismatch" — pointing an operator at tampered bytes when the real cause was an
 * unparsed list — and, worse, accepted `sha1`, whose collisions are constructible. Contract
 * now: parse every token, refuse anything unparseable, pick the STRONGEST algorithm actually
 * present, and require a digest of that strength to match. A weaker digest sitting beside a
 * stronger one can never be the one that decides.
 */
export function verifyIntegrity(buf, integrity) {
  if (typeof integrity !== "string" || integrity.trim() === "") {
    throw new Error("integrity string is empty — there is nothing to verify against");
  }
  const digests = integrity
    .trim()
    .split(/\s+/)
    .map((token) => {
      const m = /^([A-Za-z0-9]+)-([A-Za-z0-9+/]+={0,2})(\?[\x21-\x7e]*)?$/.exec(token);
      if (!m) throw new Error(`unparseable integrity token '${token}'`);
      return { algo: m[1].toLowerCase(), expected: m[2] };
    });
  const strongest = SRI_ALGORITHMS.find((a) => digests.some((d) => d.algo === a));
  if (!strongest) {
    const seen = [...new Set(digests.map((d) => d.algo))].join(", ");
    throw new Error(`unsupported integrity algorithm(s) ${seen} — supported: ${SRI_ALGORITHMS.join(", ")}`);
  }
  const actual = createHash(strongest).update(buf).digest("base64");
  return digests.some((d) => d.algo === strongest && d.expected === actual);
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

/**
 * MEASURE the expanded size by decompressing through a counter that aborts the instant the
 * bound is crossed. Nothing is written to disk and nothing accumulates in memory: each chunk
 * is counted and dropped, so a bomb costs decompression time and nothing else.
 *
 * This replaces a check that read gzip's trailing ISIZE field. ISIZE is the LAST member's
 * uncompressed size modulo 2^32, so a 5 MB member concatenated with a 1-byte member reported
 * 1 — and the comment beside it claimed the extraction timeout was a second line of defence,
 * when a timeout bounds seconds and tar writes bytes (review round 2, chunk 13).
 */
export async function measureExpandedBytes(buf, label) {
  if (!(buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
    throw new Error(`${label}: not a gzip archive — refusing`);
  }
  return await new Promise((resolve, reject) => {
    let total = 0;
    const gunzip = createGunzip();
    gunzip.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_EXPANDED_BYTES) {
        gunzip.destroy(new Error(`${label}: archive expands past ${MAX_EXPANDED_BYTES} bytes — refusing`));
      }
    });
    gunzip.on("end", () => resolve(total));
    gunzip.on("error", (error) => reject(error));
    gunzip.end(buf);
  });
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
 * The predicate itself, over ONE manifest: forbidden lifecycle hooks and the native-build
 * flag. Shared by the tarball inspection and the installed-tree rescan so the two can never
 * drift apart — they are supposed to be asking the same question of different bytes.
 *
 * A manifest that will not parse is a violation, not an exception. Throwing aborted the whole
 * closure (and, through the matrix, the candidate) with a bare SyntaxError naming no package.
 */
export function inspectManifest(manifestPath, label) {
  const violations = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [{ package: label, kind: "malformed-manifest", detail: String(error?.message ?? error).slice(0, 200) }];
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ package: label, kind: "malformed-manifest", detail: "manifest is not a JSON object" }];
  }
  for (const hook of FORBIDDEN_SCRIPTS) {
    if (manifest.scripts?.[hook] !== undefined) violations.push({ package: label, kind: `script:${hook}` });
  }
  if (manifest.gypfile) violations.push({ package: label, kind: "gypfile-flag" });
  return violations;
}

/**
 * Inspect one UNPACKED package directory for anything that would execute at install time:
 * forbidden lifecycle scripts, a gypfile flag, or a `binding.gyp` on disk — the last being a
 * tarball fact, not a manifest fact, which is why fetching was necessary at all.
 *
 * The walk is RECURSIVE over the whole extracted tree (review round 2, chunk 13). It used to
 * read exactly `package/package.json` and `package/binding.gyp`, so a tarball bundling its own
 * `package/node_modules/evil` — with a postinstall hook, a gypfile flag and a binding.gyp —
 * was reported as having no violations at all. Bundled dependencies install with the package;
 * inspecting only its outermost manifest is inspecting the cover of the book. A symlink
 * surviving into the extracted tree is itself recorded: member validation refuses links before
 * extraction, so one here means that check did not run.
 */
export function inspectUnpacked(dir, label) {
  const root = join(dir, "package");
  if (!existsSync(join(root, "package.json"))) {
    // A package with no manifest cannot declare itself harmless; that is a violation, not a skip.
    return [{ package: label, kind: "missing-manifest" }];
  }
  const violations = [];
  // Nested findings are labelled with their path inside the tarball; the outermost manifest
  // keeps the bare package label, because that is the thing the operator was told about.
  const at = (rel) => (rel === "" ? label : `${label}:package/${rel}`);
  const walk = (currentDir, rel) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const child = join(currentDir, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        violations.push({ package: at(childRel), kind: "symlink-in-tree" });
        continue;
      }
      if (entry.isDirectory()) {
        walk(child, childRel);
        continue;
      }
      if (!entry.isFile()) {
        violations.push({ package: at(childRel), kind: "irregular-file" });
        continue;
      }
      // Both are labelled by their CONTAINING directory: a violation names a package position,
      // not a filename, and the outermost position is the package the operator asked about.
      if (entry.name === "binding.gyp") violations.push({ package: at(rel), kind: "binding.gyp" });
      if (entry.name === "package.json") violations.push(...inspectManifest(child, at(rel)));
    }
  };
  walk(root, "");
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
    let expandedBytes = 0;
    for (const entry of entries) {
      const label = `${entry.name}@${entry.version}`;
      // Fetch the URL VALIDATION returned, not the lockfile's original string: whatever the
      // policy above normalised away must not come back through the back door.
      const url = validateResolvedUrl(entry.resolved, label);
      const buf = await fetchOne(url.href, entry);
      if (buf.length > MAX_TARBALL_BYTES) {
        throw new Error(`${label}: tarball exceeds ${MAX_TARBALL_BYTES} bytes — refusing`);
      }
      if (!verifyIntegrity(buf, entry.integrity)) {
        throw new Error(`integrity mismatch for ${label} — refusing to unpack`);
      }
      expandedBytes += await measureExpandedBytes(buf, label);
      verified++;
      const dest = join(scratch, `${verified}`);
      mkdirSync(dest);
      const tarPath = join(dest, "pkg.tgz");
      writeFileSync(tarPath, buf);
      extractOne(tarPath, dest, label);
      violations.push(...inspectUnpacked(dest, label));
    }
    return { packages: entries.length, verified, expandedBytes, violations };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Rescan an INSTALLED tree by path (plan step 4): every package.json anywhere under
 * node_modules — nested copies included, which is why the walk is by path and never keyed by
 * name — checked with the same forbidden-hook/native-build predicate as the fetched tarballs.
 * This is what binds the tree the conformance cases actually execute against to the same
 * no-hooks contract the tarball inspection proved about the lockfile's content.
 */
export function scanInstalledTree(workspaceDir) {
  const rootModules = join(workspaceDir, "node_modules");
  if (!existsSync(rootModules)) {
    throw new Error(`no node_modules under ${workspaceDir} — nothing was installed`);
  }
  const violations = [];
  let packagesScanned = 0;
  const rel = (p) => p.slice(workspaceDir.length + 1);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      // Dot-entries first, and by allowlist. `.bin` and the lock sidecar are npm's own
      // bookkeeping; every OTHER hidden directory is recorded, because "starts with a dot" was
      // a way to put a package where the scan would not look (review round 2, chunk 13).
      if (entry.name.startsWith(".")) {
        if (!KNOWN_METADATA_ENTRIES.has(entry.name)) {
          violations.push({ package: rel(child), kind: "hidden-entry" });
        }
        continue;
      }
      // A SYMLINK is not a directory to `Dirent.isDirectory()`, so the old walk skipped
      // symlinked packages in silence — and npm installs `file:`, `link:` and workspace
      // dependencies exactly that way. A tree of one honest package plus a symlink to a
      // package carrying `postinstall` and `gypfile` was reported as one package scanned, zero
      // violations: a clean bill of health for a tree the scan never looked at. Recorded now,
      // never followed: following it would take the walk outside the tree being judged.
      if (entry.isSymbolicLink()) {
        violations.push({ package: rel(child), kind: "symlinked-package" });
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        walk(child);
        continue;
      }
      const manifestPath = join(child, "package.json");
      if (existsSync(manifestPath)) {
        packagesScanned++;
        violations.push(...inspectManifest(manifestPath, rel(manifestPath)));
        if (existsSync(join(child, "binding.gyp"))) {
          violations.push({ package: rel(manifestPath), kind: "binding.gyp" });
        }
      } else {
        // A directory sitting in a package position with no manifest is not a package this
        // scan can vouch for. Node will still resolve `require('name/file.js')` out of it.
        violations.push({ package: rel(child), kind: "missing-manifest" });
      }
      const nested = join(child, "node_modules");
      if (existsSync(nested)) walk(nested);
    }
  };
  walk(rootModules);
  if (packagesScanned === 0) throw new Error(`installed-tree rescan found zero packages under ${rootModules}`);
  return { packagesScanned, violations };
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

if (isDirectEntry(import.meta.url)) {
  await main();
}
