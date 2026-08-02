#!/usr/bin/env node
// Commit wrapper (T-024 criterion 5b): the gate autonomous workflows go through to commit.
//
//   node scripts/guarded-commit.mjs -m "message" [git commit args...]
//
// It runs the privacy scanner in INDEX mode — the prospective committed tree — and refuses the
// commit on any finding. The properties that matter, and what each one cost to make true:
//
//   * It scans the index, not the working tree. At this point the change is already staged, and
//     the index is what the commit would contain. A dirty worktree file that is not staged is
//     not about to be committed and must not block one (T-009.json's tool-written claim fields
//     live in exactly that state between releases).
//   * IT COMMITS THE TREE IT SCANNED. Scanning the index and then handing arbitrary arguments to
//     `git commit` is not a gate at all: `-a`, `--include`, `--only` and a bare pathspec all make
//     git build the commit from worktree content the scan never saw (review round 1, chunk 15).
//     So the accepted arguments are an ALLOWLIST of options that cannot change what is committed,
//     the index tree is pinned before and after the scan, and the tree that actually landed is
//     compared against it afterwards.
//   * It fails CLOSED. A scanner that could not be launched at all reports `status: null`, and
//     `process.exit(null)` exits ZERO — the guard's one job, failed silently (review round 1,
//     chunk 15). Every spawn is now checked for its error before its status.
//
// HONESTY CLAUSE, recorded here because the guard must not overclaim: this wrapper protects the
// workflows that use it. `git commit` run directly, `--no-verify`, another worktree, or a tool
// writing its own commits all bypass it. The CI audit workflow exists to DETECT what this cannot
// prevent; nothing in this repository claims prevention without a server-side check.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectEntry } from "./direct-entry.mjs";

// SPENDBAR_GUARD_REPO exists so tests can point the whole wrapper at a fixture repository and
// observe the refusal end-to-end. Unset — every real use — it guards this repository.
const HERE = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPO = process.env.SPENDBAR_GUARD_REPO ?? HERE;
// SPENDBAR_GUARD_SCANNER likewise exists only so a test can substitute a scanner that behaves
// badly on purpose — one that exits 0 having done nothing — and prove this wrapper refuses it.
const SCANNER = process.env.SPENDBAR_GUARD_SCANNER ?? join(HERE, "scripts", "privacy-scan.mjs");

/**
 * Options that describe the commit without changing WHAT is committed. Anything else — including
 * every positional pathspec and `--` — is refused, because the guarantee this wrapper sells is
 * that the committed tree is the tree it scanned, and an allowlist is the only form of that
 * check which stays true as git grows new options.
 */
const METADATA_ONLY = new Set([
  "--amend", // rewrites the parent, not the content: the tree is still the index
  "--allow-empty",
  "--allow-empty-message",
  "--author",
  "--cleanup",
  "--date",
  "--file",
  "--gpg-sign",
  "--message",
  "--no-edit",
  "--no-gpg-sign",
  "--no-signoff",
  "--quiet",
  "--signoff",
  "-F",
  "-S",
  "-m",
  "-q",
  "-s",
]);
/** Of those, the ones whose value is a separate argument. */
const TAKES_VALUE = new Set(["--author", "--cleanup", "--date", "--file", "--message", "-F", "-m"]);

/** Returns null if every argument is metadata-only, or the first argument that is not. */
export function firstContentChangingArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "--") return arg; // a pathspec, or the end of options
    const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!METADATA_ONLY.has(name)) return arg;
    if (TAKES_VALUE.has(name) && name === arg) i += 1; // consume the separate value
  }
  return null;
}

const fail = (code, message) => {
  process.stderr.write(`guarded-commit: ${message}\n`);
  process.exit(code);
};

/** Run git, failing closed on a spawn error rather than reading a null status as success. */
function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8", ...options });
  if (result.error) fail(2, `git ${args[0]} could not run (${result.error.message})`);
  return result;
}

function main(args) {
  if (args.length === 0) fail(2, 'pass git commit arguments, e.g. -m "message"');

  const offending = firstContentChangingArg(args);
  if (offending !== null) {
    fail(
      2,
      `REFUSED — '${offending}' can commit content the scan never saw. This wrapper commits the ` +
        "staged index and nothing else; stage the change first, then commit with metadata options only.",
    );
  }

  // Nothing staged is an error, not a pass: the caller thought they were committing something.
  // `--amend` is the exception — amending metadata on an existing commit stages nothing.
  const staged = git(["diff", "--cached", "--quiet"]);
  if (staged.status === 0 && !args.includes("--amend")) fail(2, "nothing is staged");

  // The tree the scan is about to judge, named before it runs.
  const treeBefore = git(["write-tree"]);
  if (treeBefore.status !== 0) fail(2, `could not write the index tree\n${treeBefore.stderr}`);
  const scannedTree = treeBefore.stdout.trim();

  const scan = spawnSync(process.execPath, [SCANNER, "--mode=index", `--repo=${REPO}`], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (scan.error) fail(2, `REFUSED — the scanner could not be launched (${scan.error.message})`);
  if (scan.status !== 0) {
    // Findings (1) and scanner failure (2) both refuse — fail closed — but say which happened. A
    // null status means the scanner was killed by a signal, which is a failure, never a pass.
    const why = scan.status === 1 ? "the index contains personal data" : "the scanner could not run";
    process.stderr.write(`guarded-commit: REFUSED — ${why}\n${scan.stderr}${scan.stdout}`);
    process.exit(scan.status ?? 2);
  }

  // Exit 0 is not evidence that anything was scanned. A module whose direct-entry guard does not
  // fire runs no main() and exits 0 having read nothing, which is byte-for-byte the same signal
  // as a clean scan (review round 2 found exactly that bug in the guard idiom this repository
  // used everywhere). So the scanner must SAY what it did, and the count must be non-zero: this
  // wrapper trusts a report of work, never a bare exit code.
  const proof = /^privacy-scan: .*?, (\d+) text files, clean$/m.exec(scan.stdout ?? "");
  if (!proof || Number(proof[1]) === 0) {
    fail(
      2,
      "REFUSED — the scanner exited 0 without reporting a completed scan. An exit code alone " +
        `cannot distinguish "scanned everything, found nothing" from "never ran".\n${scan.stdout ?? ""}`,
    );
  }

  // Still the same tree? Something else staging a change while the scan ran would otherwise commit
  // content that was never examined.
  const treeAfter = git(["write-tree"]);
  if (treeAfter.status !== 0 || treeAfter.stdout.trim() !== scannedTree) {
    fail(2, "REFUSED — the index changed while it was being scanned");
  }

  // `--no-verify`: a pre-commit hook runs between our scan and the commit and can stage whatever it
  // likes, which would put unscanned content into the very commit this wrapper is vouching for.
  // This wrapper IS the pre-commit verification, so it declines to be raced by another one.
  const committed = git(["commit", "--no-verify", ...args], { stdio: "inherit", encoding: undefined });
  if (committed.status !== 0) process.exit(committed.status ?? 1);

  // What landed must be what was scanned. With an unchanged index this is trivially true; it is
  // asserted anyway, because "the commit contains the scanned tree" is the whole claim, and an
  // assertion that only ever passes still fails loudly the day it stops being true.
  const landed = git(["rev-parse", "HEAD^{tree}"]);
  if (landed.status !== 0 || landed.stdout.trim() !== scannedTree) {
    fail(1, `WARNING — the commit that was just created does not contain the scanned tree (${scannedTree})`);
  }
}

// Direct-entry guard: importing this module for its argument allowlist must not commit anything.
if (isDirectEntry(import.meta.url)) main(process.argv.slice(2));
