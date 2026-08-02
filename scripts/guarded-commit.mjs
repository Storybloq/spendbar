#!/usr/bin/env node
// Commit wrapper (T-024 criterion 5b): the gate autonomous workflows go through to commit.
//
//   node scripts/guarded-commit.mjs -m "message" [git commit args...]
//
// It runs the privacy scanner in INDEX mode — the prospective committed tree — and refuses the
// commit on any finding. Two properties matter:
//
//   * It scans the index, not the working tree. At this point the change is already staged, and
//     the index is what the commit would contain. A dirty worktree file that is not staged is
//     not about to be committed and must not block one (T-009.json's tool-written claim fields
//     live in exactly that state between releases).
//   * It fails CLOSED. If the scanner cannot run, the commit does not happen. A guard that lets
//     a commit through because it broke is a guard in name only.
//
// HONESTY CLAUSE, recorded here because the guard must not overclaim: this wrapper protects the
// workflows that use it. `git commit` run directly, `--no-verify`, another worktree, or a tool
// writing its own commits all bypass it. The CI audit workflow exists to DETECT what this cannot
// prevent; nothing in this repository claims prevention without a server-side check.

import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// SPENDBAR_GUARD_REPO exists so tests can point the whole wrapper at a fixture repository and
// observe the refusal end-to-end. Unset — every real use — it guards this repository.
const HERE = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPO = process.env.SPENDBAR_GUARD_REPO ?? HERE;
const SCANNER = join(HERE, "scripts", "privacy-scan.mjs");

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("guarded-commit: pass git commit arguments, e.g. -m \"message\"\n");
  process.exit(2);
}

// Nothing staged is an error, not a pass: the caller thought they were committing something.
const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: REPO });
if (staged.status === 0) {
  process.stderr.write("guarded-commit: nothing is staged\n");
  process.exit(2);
}

const scan = spawnSync(process.execPath, [SCANNER, "--mode=index", `--repo=${REPO}`], {
  cwd: REPO,
  encoding: "utf8",
});
if (scan.status !== 0) {
  // Findings (1) and scanner failure (2) both refuse — fail closed — but say which happened.
  const why = scan.status === 1 ? "the index contains personal data" : "the scanner could not run";
  process.stderr.write(`guarded-commit: REFUSED — ${why}\n${scan.stderr}${scan.stdout}`);
  process.exit(scan.status);
}

try {
  execFileSync("git", ["commit", ...args], { cwd: REPO, stdio: "inherit" });
} catch (error) {
  process.exit(error.status ?? 1);
}
