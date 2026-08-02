#!/usr/bin/env node
// Which commits a push actually introduced (T-024 criterion 5b, review round 1 chunk 15).
//
//   node scripts/push-range.mjs --before=<sha|zeros> --after=<sha> --ref=refs/heads/<name>
//
// Prints one SHA per line — every commit the push made reachable that was not reachable before —
// and exits 2 rather than printing nothing, because a privacy audit that resolves an empty range
// and passes is the vacuous success this project refuses everywhere else.
//
// This lived as a shell block inside the workflow, where it could not be tested and was wrong in
// a way nobody would notice: the fallback for a new branch or a force push ran
//
//     git rev-list "$AFTER" --not --exclude="$GITHUB_REF" --branches --remotes
//
// and `--exclude` matches patterns in the namespace of the `--branches`/`--remotes` that FOLLOW
// it, so a full `refs/heads/<name>` never excluded anything. Worse, right after a push the
// branch also exists as `refs/remotes/origin/<name>`, which `--remotes` then subtracted — so the
// range came back EMPTY and the code fell back to scanning the tip alone. A five-commit push of
// a new branch was audited by looking at one commit.
//
// Every ref is therefore enumerated explicitly, both spellings of the pushed ref are removed from
// the exclusion set, and the tip-only fallback is reachable only when the tip genuinely is the
// only new commit.

import { execFileSync } from "node:child_process";

const ZEROS = /^0{40,64}$/;

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** Every ref this repository holds, as full names. */
function allRefs(repo) {
  return git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
}

/** True when `rev` names an object this repository actually has. */
function exists(repo, rev) {
  try {
    git(repo, ["cat-file", "-e", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commits `after` introduced. With a usable `before` this is the plain range; otherwise it is
 * everything reachable from `after` and from no OTHER ref — with the pushed ref itself excluded
 * under both the local and the remote-tracking spelling, since after a push both point at `after`
 * and leaving either in would subtract the entire push from its own range.
 */
export function pushRange({ before, after, ref, repo = process.cwd() }) {
  if (!after) throw new Error("push-range: --after is required");
  if (before && !ZEROS.test(before) && exists(repo, before)) {
    return git(repo, ["rev-list", `${before}..${after}`]).split("\n").filter(Boolean);
  }

  const pushed = new Set();
  if (ref) {
    pushed.add(ref);
    const short = ref.replace(/^refs\/heads\//, "");
    for (const candidate of allRefs(repo)) {
      if (candidate === ref || candidate.endsWith(`/${short}`)) pushed.add(candidate);
    }
  }
  const others = allRefs(repo).filter((name) => !pushed.has(name));
  const commits = git(repo, ["rev-list", after, "--not", ...others]).split("\n").filter(Boolean);
  // The tip is the floor, never the answer: falling back to it when the range is non-empty is
  // exactly the defect this module exists to remove.
  return commits.length ? commits : [after];
}

function main(argv) {
  const opt = (name) => {
    const found = argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : "";
  };
  let commits;
  try {
    commits = pushRange({ before: opt("before"), after: opt("after"), ref: opt("ref"), repo: opt("repo") || process.cwd() });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (commits.length === 0) {
    process.stderr.write("push-range: resolved no commits — refusing to report an empty audit range\n");
    return 2;
  }
  process.stdout.write(`${commits.join("\n")}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
