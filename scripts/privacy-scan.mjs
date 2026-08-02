#!/usr/bin/env node
// Personal-data scanner (T-024).
//
// The project's hard rule is that no personal paths, usernames, real emails or real session
// identifiers appear in anything checked in. This finds violations of it.
//
// NOTE TO ANYONE EDITING THIS FILE OR ITS TESTS: this scanner is scanned by this scanner. Never
// write a complete forbidden-shaped value here, not even as an example in a comment — spell it with
// angle-bracket placeholders, or build it at runtime from fragments. Review round 8 found 25 such
// self-violations across this file, its config and its tests, which would have made the repository
// unscannable the moment they were staged.
//
// MODES, and the distinctions are load-bearing:
//
//   --mode=index     the PROSPECTIVE COMMITTED TREE: staged blobs for modified paths, index entries
//                    for everything else. This is what a commit would contain, and it is the only
//                    correct domain for a pre-commit decision. Scanning HEAD as well would make
//                    remediation impossible: during the very commit that removes a leak, HEAD still
//                    contains it and the staged replacement is clean, so a combined scan would
//                    refuse to authorize its own fix.
//   --mode=worktree  what `git add -A` would stage: tracked paths as they exist on disk PLUS
//                    non-ignored untracked files, minus tracked paths that have been deleted.
//                    Finds a leak before it reaches the index. Not the pre-commit gate: at hook
//                    time the change is already staged, so the gate reads the index.
//   --mode=audit     HEAD, for post-commit verification and for reporting on the repo as it stands.
//   --mode=commit    an explicit commit or treeish (--rev=<ref>). CI enumerates every commit in a
//                    push range with this; auditing only the tip would miss a leak introduced in an
//                    intermediate commit and removed at the tip, which still lives in remote history.
//   --mode=dir       an arbitrary directory tree (--dir=<path>), for scanning an unpacked npm
//                    tarball. This mode excludes NOTHING but .git: `dist` is precisely what ships,
//                    and skipping it would recreate the blind spot that let personal data into a
//                    published package while the packaging contract stayed green (ISS-005).
//
// SEMANTIC, NOT A DENYLIST. A denylist of this machine's values would have to contain those values,
// which is the violation it exists to prevent, and would miss the next machine's. So: a value
// matching a class pattern is a finding UNLESS it matches the documented synthetic allowlist, by
// exact equality or a fully anchored pattern — never by prefix. See scripts/privacy-synthetic.json.

import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, openSync, readFileSync, readdirSync, lstatSync, readlinkSync, existsSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectEntry } from "./direct-entry.mjs";

const DEFAULT_REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export const POLICY_PATH = "scripts/privacy-synthetic.json";

/**
 * Compile the synthetic allowlist into the matchers isSynthetic uses.
 *
 * ANCHORING IS APPLIED HERE, not trusted to the config. The helper was called `anchored` and did
 * nothing of the kind — it compiled each pattern as-is, so `RegExp.test` substring-matched and a
 * pattern as short as `abc` would have cleared every real session id containing it, in flat
 * contradiction of this file's own "exact equality or a fully anchored pattern — never by prefix"
 * contract (review round 2, chunk 2). Wrapping is idempotent for patterns already written with
 * ^…$, so the existing config keeps its meaning.
 */
export function compilePolicy(synthetic) {
  const anchored = (patterns) =>
    (patterns ?? []).map((p) => {
      try {
        return new RegExp(`^(?:${p})$`, "i");
      } catch (error) {
        // A malformed pattern must not silently become a pattern that matches nothing, which is
        // the safe direction for findings but hides a broken policy file.
        throw new Error(`privacy-scan: ${POLICY_PATH} has an invalid pattern (${error.message})`);
      }
    });
  return {
    session: anchored(synthetic.sessionIdPatterns),
    workflow: anchored(synthetic.workflowIdPatterns),
    mangled: anchored(synthetic.mangledHomePatterns),
    accounts: new Set((synthetic.accounts ?? []).map((a) => a.toLowerCase())),
    binaryExt: new Set((synthetic.binaryExtensions ?? []).map((e) => e.toLowerCase())),
    emailDomains: synthetic.emailDomains ?? [],
  };
}

/**
 * The policy that governs a scan must come from the SAME domain the scan is judging.
 *
 * Reading it from the working tree — which is what this file did, unconditionally, for every
 * mode — is a straightforward bypass of the pre-commit gate (review round 2, chunk 2, verified):
 * index mode judges STAGED blobs, so an edit to the allowlist that is never staged still cleared
 * real values out of them. The leak lands in the commit; the line that excused it does not, and
 * nothing downstream can even tell it happened. Auditing a historical commit had the mirror-image
 * problem: it applied today's policy to yesterday's tree.
 *
 * So the policy is read from the domain: the index for `index`, the named tree for
 * `commit`/`audit`, and the working file only for `worktree` and `dir`, where the working file
 * IS the domain.
 */
export function loadPolicy({ mode, rev, repo = DEFAULT_REPO, dir = null }) {
  const tryGit = (treeish) => {
    try {
      return git(repo, ["show", `${treeish}:${POLICY_PATH}`]).toString("utf8");
    } catch {
      return null;
    }
  };
  const tryFile = (base) => {
    try {
      return readFileSync(join(base, POLICY_PATH), "utf8");
    } catch {
      return null;
    }
  };

  let raw = null;
  let source = null;
  if (mode === "index") {
    // `:0:<path>` is the STAGED blob — the copy that is about to be committed.
    raw = tryGit(":0");
    source = "index";
    // Deleting the policy from the index while keeping a permissive copy on disk would be the
    // same bypass wearing a different hat, so a policy that HEAD has and the index does not is a
    // refusal rather than a fallback.
    if (raw === null && tryGit("HEAD") !== null) {
      throw new Error(
        `privacy-scan: ${POLICY_PATH} is committed but missing from the index — refusing to scan ` +
          "with a policy the prospective commit does not contain",
      );
    }
  } else if (mode === "commit") {
    raw = tryGit(rev);
    source = rev;
  } else if (mode === "audit") {
    raw = tryGit("HEAD");
    source = "HEAD";
  } else if (mode === "worktree") {
    raw = tryFile(repo);
    source = "worktree";
  }
  // `dir` mode deliberately never reads a policy out of the scanned tree: that tree is an
  // unpacked artifact, i.e. exactly the untrusted content under examination, and letting it
  // declare its own values synthetic would be the strongest possible version of this bug.
  if (raw === null) {
    // No policy in the domain — a foreign directory, or a repository that does not use this
    // scanner. The tool's own configuration is the only one left, and the source is REPORTED so
    // that "which allowlist cleared this scan" is never a question a reader has to go and answer.
    raw = tryFile(DEFAULT_REPO);
    source = source === null ? "scanner-default" : `scanner-default (no ${POLICY_PATH} in ${source})`;
  }
  if (raw === null) {
    throw new Error(`privacy-scan: no ${POLICY_PATH} available for mode=${mode}`);
  }
  return { policy: compilePolicy(JSON.parse(raw)), source, raw };
}

// `group` is the capture holding the part that identifies a person or session; 0 = whole match.
export const CLASSES = [
  // The TLD may contain digits and hyphens after its first letter, so an internationalized
  // (punycode) domain is matched rather than skipped — `[A-Za-z]{2,}` stopped at the first digit
  // and let an entire class of real address through (review round 1, chunk 14). A leading letter
  // is still required, which is what keeps package specifiers like `sdk@1.30.0` out.
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z][A-Za-z0-9-]+\b/g, group: 0 },
  // The capture is the WHOLE path component, not a run of "account-looking" characters. The old
  // class `[A-Za-z0-9._-]+` stopped at the first space, which failed in the worst possible
  // direction: `/Users/<declared-account> <RealSurname>/` captured only the declared account,
  // matched the allowlist exactly, and reported nothing — so a real surname passed the gate
  // BECAUSE its first token was synthetic (review round 2, chunk 2, verified). Names with spaces
  // or non-ASCII characters were also missed outright, and a Windows profile directory containing
  // a space is entirely ordinary.
  { name: "macos-home", re: /\/Users\/([^\s/\\\"'`,;:*?<>|()\[\]{}][^/\\\r\n\"'`,;:*?<>|()\[\]{}]*)/gi, group: 1 },
  { name: "linux-home", re: /\/home\/([^\s/\\\"'`,;:*?<>|()\[\]{}][^/\\\r\n\"'`,;:*?<>|()\[\]{}]*)/gi, group: 1 },
  // Case-insensitive and either slash direction: Windows paths are case-insensitive, and tooling
  // emits both separators. A backslash-only, case-sensitive pattern missed most real forms.
  { name: "windows-home", re: /[A-Za-z]:[\\/]+Users[\\/]+([^\s/\\\"'`,;:*?<>|()\[\]{}][^/\\\r\n\"'`,;:*?<>|()\[\]{}]*)/gi, group: 1 },
  // The WHOLE mangled run, not a guessed account. See isSynthetic for why the boundary is
  // undecidable and must not be inferred.
  { name: "mangled-home", re: /-Users-[A-Za-z0-9._-]+/gi, group: 0 },
  // The boundaries are the IDENTIFIER'S OWN ALPHABET, not \b. Underscore is a regex word
  // character and so is every hex digit, so `\b` finds no boundary between them: `session_<uuid>`
  // — which is the literal shape of a stored transcript filename — produced NO finding at all
  // (review round 2, chunk 2, verified). A hex lookaround is what actually means "not part of a
  // longer hex run".
  {
    name: "session-id",
    re: /(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])/g,
    group: 0,
  },
  // Non-UUID session shapes. Claiming coverage without these was a false claim, not a gap. No
  // leading boundary at all: `wf_` is distinctive enough, and requiring one is what hid
  // `run_wf_…` from the scan.
  { name: "workflow-id", re: /wf_[0-9a-fA-F]{6,}-[0-9a-fA-F]{2,}(?![0-9a-fA-F])/g, group: 0 },
];

// Excluded in git-backed and worktree modes only. `dir` mode excludes nothing but .git.
const REPO_SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__"]);
const DIR_SKIP_DIRS = new Set([".git"]);

/**
 * The policy of the WORKING FILE, for callers that scan live in-memory data rather than a git
 * domain — sanitize.mjs checking a capture it just took, and the tests. Lazy so that merely
 * importing this module does not require the file to exist.
 */
let worktreePolicy = null;
const defaultPolicy = () => {
  worktreePolicy ??= compilePolicy(
    JSON.parse(readFileSync(join(DEFAULT_REPO, POLICY_PATH), "utf8")),
  );
  return worktreePolicy;
};

/**
 * Trailing whitespace and sentence punctuation are stripped ONLY for the allowlist comparison.
 * This keeps prose like `see /Users/<synthetic>.` from being reported, while `<synthetic>
 * Surname` still is: trimming can shorten a component to a declared account, so it must never be
 * able to strip an interior space or a letter.
 */
const trimTrailingPunctuation = (s) => s.replace(/[\s.!?]+$/, "");

export function isSynthetic(value, className, policy = defaultPolicy()) {
  const v = value.toLowerCase();
  if (className === "email") {
    // Suffix match on the DOMAIN, at a label boundary. `endsWith("@example.com")` cleared the bare
    // domain and reported every subdomain of it, and it made the RFC 2606 reserved TLDs
    // (.test, .invalid, .localhost) dead config — those are TLDs and never appear as a whole
    // domain, so nothing could ever match them (review round 1, chunk 14).
    const domain = v.slice(v.lastIndexOf("@") + 1);
    return policy.emailDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
  }
  if (className === "session-id") return policy.session.some((re) => re.test(v));
  if (className === "workflow-id") return policy.workflow.some((re) => re.test(v));
  // Claude Code's project-directory mangling is LOSSY: the hyphen is both the separator and a legal
  // account character, so the account boundary cannot be recovered from the mangled string. Guessing
  // it fails in both directions — truncating at the first hyphen clears a real hyphenated account
  // whose first segment happens to be declared, and rejects a declared synthetic account that itself
  // contains a hyphen. So no boundary is inferred: the entire run must match a declared, fully
  // anchored synthetic path pattern.
  if (className === "mangled-home") return policy.mangled.some((re) => re.test(v));
  // Exact equality. Prefix matching cleared an undeclared account that merely began with a declared
  // one. Safe here because the slash delimits the account exactly.
  return policy.accounts.has(v) || policy.accounts.has(trimTrailingPunctuation(v));
}

export function scanText(text, path, policy = defaultPolicy()) {
  const findings = [];
  const lines = text.split("\n");
  for (const { name, re, group } of CLASSES) {
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        if (!isSynthetic(m[group], name, policy)) {
          // The finding names file, line and class. It never carries the value — a report about a
          // forbidden value that quotes it is a new instance of the leak, which is exactly how
          // ISS-046 was filed the first time.
          findings.push({ path, line: i + 1, class: name });
        }
      }
    }
  }
  return findings;
}

// Fatal, deliberately. `buf.toString("utf8")` substitutes U+FFFD for an invalid sequence, so a
// file with one bad byte inside a home path or an address was counted as successfully scanned
// while the replacement character split the match in half (review round 1, chunk 14). A file
// this cannot decode is reported, not read approximately.
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode a buffer as text, or report that it cannot be. UTF-16 is decoded rather than dismissed as
 * binary: its ASCII content is NUL-interleaved, so a naive NUL check would skip a file full of
 * readable personal data.
 *
 * The UTF-16 path checks only that the body has an even length. Lone surrogates are decoded to
 * replacement characters rather than refused, because JavaScript strings admit them legitimately
 * and a tool that writes one is not producing an undecodable file; the UTF-8 path has no such
 * excuse, and is strict.
 */
export function decode(buf) {
  // UTF-32 FIRST, because its little-endian BOM (FF FE 00 00) BEGINS with the UTF-16LE BOM. Read
  // as UTF-16LE it decodes to NUL-interleaved text that no class pattern can match, `scannedText`
  // is incremented, and the file is reported clean — the one encoding that failed OPEN rather
  // than into malformed-encoding or unscannable-binary (review round 2, chunk 2, verified). It is
  // not decoded here, because nothing in this project emits UTF-32 and a decoder nobody exercises
  // is a worse answer than a loud refusal.
  if (buf.length >= 4) {
    const u32le = buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00;
    const u32be = buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff;
    if (u32le || u32be) return { malformed: true };
  }
  if (buf.length >= 2) {
    const le = buf[0] === 0xff && buf[1] === 0xfe;
    const be = buf[0] === 0xfe && buf[1] === 0xff;
    if (le || be) {
      const body = buf.subarray(2);
      // An odd-length body is not valid UTF-16. Decoding it anyway would silently drop the last
      // byte, so it is reported rather than guessed at.
      if (body.length % 2 !== 0) return { malformed: true };
      if (!be) return { text: body.toString("utf16le") };
      const swapped = Buffer.from(body);
      swapped.swap16();
      return { text: swapped.toString("utf16le") };
    }
  }
  if (buf.includes(0)) return { binary: true };
  try {
    return { text: UTF8_STRICT.decode(buf) };
  } catch {
    return { malformed: true };
  }
}

const git = (repo, args) => execFileSync("git", args, { cwd: repo, maxBuffer: 1 << 28 });

const zsplit = (buf) => buf.toString("utf8").split("\0").filter(Boolean);

const parseLsTree = (out) =>
  zsplit(out)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [, type, sha] = meta.split(" ");
      return type === "blob" ? { path, sha } : null;
    })
    .filter(Boolean);

/** What a commit made right now would contain: staged blobs plus unchanged index entries. */
const indexEntries = (repo) =>
  zsplit(git(repo, ["ls-files", "-s", "-z"])).map((line) => {
    const [meta, path] = line.split("\t");
    const [, sha] = meta.split(" ");
    return { path, sha };
  });

/**
 * What `git add -A` would stage: tracked plus non-ignored untracked, minus tracked paths deleted
 * from disk. Tracked-only would miss exactly the untracked class this scanner exists to catch
 * before it becomes tracked; and a deleted tracked path is not staged as content at all.
 */
function worktreeEntries(repo) {
  // TRACKED paths are kept unconditionally. Applying the skip list to them dropped tracked files
  // living under a skipped directory — which `git add -A` would still stage, so the scan claimed
  // a domain it did not cover (review round 1, chunk 14). The skip list is about where an
  // untracked-file WALK has no business going, so that is the only set it filters.
  const tracked = zsplit(git(repo, ["ls-files", "--cached", "-z"]));
  const untracked = zsplit(git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).filter(
    (p) => !p.split("/").some((seg) => REPO_SKIP_DIRS.has(seg)),
  );
  const paths = new Set([...tracked, ...untracked]);
  return [...paths]
    .map((path) => ({ path, full: join(repo, path) }))
    .filter((e) => existsSync(e.full) || isLink(e.full))
    .map((e) => (isLink(e.full) ? { ...e, symlink: true } : e));
}

// existsSync follows links, so a dangling symlink reports false; lstat is what distinguishes
// "absent" from "a link pointing at something absent".
function isLink(full) {
  try {
    return lstatSync(full).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Read a file on disk without following a symlink — including one substituted between the moment
 * the entry was classified and the moment it is read. lstat-then-readFileSync leaves that window
 * open, and reading through a link put there in the meantime is exactly the "never follow a link
 * out of the tree" guarantee this scanner states (review round 1, chunk 14). O_NOFOLLOW closes it
 * at the syscall, where there is no window at all.
 */
function readNoFollow(full) {
  const fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function walk(root, skipDirs) {
  const out = [];
  const recurse = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skipDirs.has(name)) continue;
      const full = join(dir, name);
      // lstat, never stat: following a symlink lets an unpacked tarball walk the scanner outside
      // the artifact root, or into a cycle.
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out.push({ full, symlink: true });
      else if (st.isDirectory()) recurse(full);
      else if (st.isFile()) out.push({ full });
    }
  };
  recurse(root);
  return out.map((e) => ({ ...e, path: relative(root, e.full).split(sep).join("/") }));
}

/**
 * `beforeRead` exists for one reason: the no-follow guarantee is about a race, and a race that
 * cannot be provoked cannot be tested. It is called with each on-disk entry immediately before it
 * is opened, so a test can swap a classified regular file for a symlink in exactly the window the
 * guarantee covers (review round 1, chunk 15). No production caller passes it.
 */
export function scan({ mode, dir, rev, repo = DEFAULT_REPO, beforeRead = null }) {
  // Resolved BEFORE anything is read, and from the domain about to be judged rather than from
  // whatever the working tree happens to hold right now.
  const { policy, source: policySource } = loadPolicy({ mode, rev, repo, dir });
  let entries;
  if (mode === "dir") entries = walk(dir, DIR_SKIP_DIRS);
  else if (mode === "worktree") entries = worktreeEntries(repo);
  else if (mode === "audit") entries = parseLsTree(git(repo, ["ls-tree", "-r", "-z", "HEAD"]));
  else if (mode === "commit") entries = parseLsTree(git(repo, ["ls-tree", "-r", "-z", rev]));
  else if (mode === "index") entries = indexEntries(repo);
  // Never default. A mistyped mode silently scanning the index is how a scan reports on something
  // other than what was asked.
  else throw new Error(`privacy-scan: unknown mode ${mode}`);

  const findings = [];
  let scannedText = 0;
  for (const entry of entries) {
    if (entry.symlink) {
      // The link target is text that can itself carry a personal path, and reading THROUGH the link
      // would follow it out of the tree.
      findings.push(...scanText(readlinkSync(entry.full), entry.path, policy));
      scannedText++;
      continue;
    }
    let buf;
    if (entry.sha) {
      buf = git(repo, ["cat-file", "blob", entry.sha]);
    } else {
      try {
        if (beforeRead) beforeRead(entry);
        buf = readNoFollow(entry.full);
      } catch (error) {
        // ELOOP: it was a regular file when it was classified and is a link now. Continuing would
        // mean reporting on whatever the link points at, so the scan stops instead.
        throw new Error(`privacy-scan: ${entry.path} changed type during the scan (${error.code ?? error.message})`);
      }
    }
    const decoded = decode(buf);
    if (decoded.malformed) {
      findings.push({ path: entry.path, line: 0, class: "malformed-encoding" });
      continue;
    }
    if (decoded.binary) {
      // Fail closed. A silent skip is how a scan reports clean without having looked.
      if (!policy.binaryExt.has(extname(entry.path).toLowerCase())) {
        findings.push({ path: entry.path, line: 0, class: "unscannable-binary" });
      }
      continue;
    }
    scannedText++;
    findings.push(...scanText(decoded.text, entry.path, policy));
  }
  return { mode, entries: entries.length, scannedText, findings, policySource };
}

function main(argv) {
  let mode = "index";
  let dir = null;
  let rev = null;
  let repo = undefined;
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) mode = arg.slice(7);
    else if (arg.startsWith("--dir=")) dir = arg.slice(6);
    else if (arg.startsWith("--rev=")) rev = arg.slice(6);
    else if (arg.startsWith("--repo=")) repo = arg.slice(7);
    else {
      process.stderr.write(`privacy-scan: unknown argument ${arg}\n`);
      return 2;
    }
  }
  if (mode === "dir" && !dir) {
    process.stderr.write("privacy-scan: --mode=dir requires --dir=<path>\n");
    return 2;
  }
  if (mode === "commit" && !rev) {
    process.stderr.write("privacy-scan: --mode=commit requires --rev=<treeish>\n");
    return 2;
  }

  let result;
  try {
    result = scan({ mode, dir, rev, repo });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const { entries, scannedText, findings, policySource } = result;

  // A scan that read no text is not a passing scan. Without this, an empty tree, a wrong --dir or a
  // directory of nothing but binaries all report success.
  if (scannedText === 0) {
    process.stderr.write(
      `privacy-scan: mode=${mode} read 0 text files (${entries} entries); refusing to report a pass\n`,
    );
    return 2;
  }

  const where = mode === "dir" ? dir : mode === "commit" ? rev : mode;
  if (findings.length === 0) {
    // The policy source is printed on every pass. A reader of CI output should be able to see
    // WHICH allowlist cleared a scan without going and looking, since that is the lever an
    // attacker would reach for first.
    process.stdout.write(
      `privacy-scan: ${where}, ${scannedText} text files, clean (policy from ${policySource})\n`,
    );
    return 0;
  }
  process.stderr.write(
    `privacy-scan: ${where}, ${scannedText} text files, ${findings.length} finding(s)\n`,
  );
  for (const f of findings) process.stderr.write(`  ${f.path}:${f.line}  [${f.class}]\n`);
  return 1;
}

if (isDirectEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
