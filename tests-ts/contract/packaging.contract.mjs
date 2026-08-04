/**
 * Packaging contract: what a user actually receives from `npm install`.
 *
 * Everything here is asserted against a REAL `npm pack` tarball installed into a scratch
 * prefix, not against the working tree, because the interesting failures are all things
 * that look fine in a clone and break once packed — a `bin` that was never built, a lost
 * shebang, a lost executable bit, or a file that should never have been shipped at all.
 *
 * Two of these are project constraints rather than mechanics, and are tested for the same
 * reason as the rest — they are invisible until the package is published, at which point
 * they are permanent:
 *
 *   * the tarball must carry NO transcript or session data. Claude transcripts and Codex
 *     rollouts contain prompts, source code, tool arguments, environment data, credentials
 *     and third-party content. The test fixtures are synthetic, but the rule is enforced at
 *     the tarball boundary rather than by trusting each fixture's provenance.
 *   * nothing shipped may carry personal attribution — not the manifest, and not the file
 *     contents. Both halves are load-bearing: ISS-005 put a real session ID and the
 *     maintainer's home path into source comments, which tsc copied into dist/, which is in
 *     `files`. The manifest was spotless the whole time.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scanText } from "../../scripts/privacy-scan.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The manifest AS SHIPPED, parsed out of the unpacked tarball in `before()`.
 *
 * Deliberately not the working tree's package.json. In candidate mode the tarball can have
 * been packed from a different commit, so reading the repo would let every manifest assertion
 * pass against HEAD while the artifact actually being audited carried different — or
 * forbidden — metadata. The point of these tests is the bytes a user receives.
 */
let MANIFEST;

/**
 * A specific tarball to audit instead of packing a fresh one.
 *
 * Publish prep needs the artifact that the install matrix actually installed to be the same
 * artifact this contract inspects and that `npm publish --dry-run` reports on. Two `npm pack`
 * runs produce two different files, so "we tested the tarball" and "we audited the tarball"
 * would otherwise be statements about different bytes. Unset — the normal case, including the
 * LICENSE mutation check — this packs its own, exactly as before.
 */
const CANDIDATE = process.env.SPENDBAR_TARBALL ?? null;

/**
 * Every path the tarball is expected to contain, `package/` stripped. Hand-maintained: see
 * the "ships exactly the expected set of files" test for why this is not generated.
 */
const EXPECTED_TARBALL_PATHS = [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/aggregate.js",
  "dist/argparse.js",
  "dist/ccusage.js",
  "dist/cli.js",
  "dist/codex.js",
  "dist/config.js",
  "dist/context.js",
  "dist/dates.js",
  "dist/errors.js",
  "dist/format.js",
  "dist/help.js",
  "dist/io.js",
  "dist/json.js",
  "dist/main-deps.js",
  "dist/main.js",
  "dist/pyrepr.js",
  "dist/pysort.js",
  "dist/pystr.js",
  "dist/renderers.js",
  "dist/resolve-ccusage.js",
  "dist/runner.js",
  // The T-010 snapshot store. It ships because the service (T-011), the CLI readers, and
  // the MCP server all consume it from the installed package.
  "dist/snapshot/authority.js",
  "dist/snapshot/dominance.js",
  "dist/snapshot/envelope.js",
  "dist/snapshot/freshness.js",
  "dist/snapshot/errors.js",
  "dist/snapshot/intrinsics.js",
  "dist/snapshot/node-fs.js",
  "dist/snapshot/store.js",
  "dist/snapshot/types.js",
  "dist/table.js",
  "dist/transcripts.js",
  "dist/unicode-tables.js",
];

/**
 * Every npm invocation this suite makes, recorded AT THE BOUNDARY — the argument vector handed
 * to spawnSync, not one the caller built and kept a copy of. The --ignore-scripts assertion used
 * to read the caller's copy, which stayed green if the call site passed something else entirely
 * (review round 1, chunk 16).
 */
const npmInvocations = [];

/** npm is chatty on stderr; only a non-zero status is a failure. */
function npm(args, cwd, extraEnv = {}) {
  npmInvocations.push({ args: [...args], cwd });
  const r = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", ...extraEnv },
  });
  assert.equal(r.status, 0, `npm ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

let scratch;
let tarball;
/** `tar -tzvf` lines, for the mode column. */
let listing;
/** Tarball paths from `tar -tzf`, stripped of the leading `package/`. */
let paths;
/** Unpacked tarball contents: tarball-relative path -> file text. */
let contents;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "spendbar-pack-"));
  if (CANDIDATE === null) {
    // `npm pack` runs prepack, so this also proves the tarball cannot be cut from a stale
    // dist/ — the build is part of packing, not something a developer has to remember.
    const out = npm(["pack", "--pack-destination", scratch], REPO);
    tarball = join(scratch, out.trim().split("\n").pop().trim());
  } else {
    tarball = resolve(CANDIDATE);
    assert.ok(existsSync(tarball), `SPENDBAR_TARBALL does not exist: ${tarball}`);
    // Print the digest rather than assert one: this run's job is to say WHAT it audited, so
    // that the matrix run and the publish dry-run can be checked against the same string.
    const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    process.stderr.write(`auditing candidate tarball\n  path: ${tarball}\n  sha256: ${sha}\n`);
  }
  assert.ok(existsSync(tarball), `npm pack did not produce ${tarball}`);
  const t = spawnSync("tar", ["-tzvf", tarball], { encoding: "utf8" });
  assert.equal(t.status, 0, t.stderr);
  listing = t.stdout.trim().split("\n");
  // Paths come from the NON-verbose listing: the verbose format's column count varies by
  // tar implementation and by date (`Oct 26  1985` vs `Jul 31 10:00`), so slicing columns
  // out of it to recover a path is unreliable.
  const p = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  paths = p.stdout.trim().split("\n").map((x) => x.replace(/^package\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  assert.ok(paths.length > 0, "empty tarball listing");

  // Unpack, so the content scans below read what a consumer actually receives rather than
  // the working tree. dist/ is generated, and the defect these scans exist for (ISS-005)
  // lived in a source comment that only became shipped bytes after tsc.
  const unpacked = join(scratch, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  const x = spawnSync("tar", ["-xzf", tarball, "-C", unpacked], { encoding: "utf8" });
  assert.equal(x.status, 0, x.stderr);
  contents = new Map(
    paths
      .filter((p) => statSync(join(unpacked, "package", p)).isFile())
      .map((p) => [p, readFileSync(join(unpacked, "package", p), "utf8")]),
  );
  assert.ok(contents.size > 0, "unpacked tarball has no files");

  const shippedManifest = contents.get("package.json");
  assert.ok(shippedManifest, "the tarball has no package.json");
  MANIFEST = JSON.parse(shippedManifest);
});

/**
 * Every `re` match across shipped file contents, as `path:line: text` — the form that
 * tells you where to go. `re` must be global.
 */
function scanContents(re, skip = () => false) {
  const hits = [];
  for (const [path, text] of contents) {
    if (skip(path)) continue;
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(re)) hits.push(`${path}:${i + 1}: ${m[0]}`);
    });
  }
  return hits.sort();
}

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the tarball", () => {
  test("contains the declared bin, and the bin exists", () => {
    const bin = MANIFEST.bin.spendbar;
    assert.equal(bin, "dist/cli.js");
    assert.ok(paths.includes(bin), `${bin} is missing from the tarball:\n${paths.join("\n")}`);
  });

  test("ships dist/cli.js executable, with the shebang intact", () => {
    const line = listing.find((l) => l.endsWith("package/dist/cli.js"));
    assert.ok(line, "no dist/cli.js entry");
    // tar's mode column, e.g. "-rwxr-xr-x". npm re-chmods bin targets on install, which is
    // precisely why a missing bit here goes unnoticed until someone execs the file by path.
    const mode = line.split(/\s+/)[0];
    assert.match(mode, /^-rwxr.xr.x/, `dist/cli.js is not executable in the tarball: ${mode}`);
    // Read the shebang out of the TARBALL, not out of the working tree's dist/. In candidate
    // mode the tarball may have been packed from a different commit, and the whole point of
    // that mode is to describe the artifact in hand rather than whatever is checked out.
    assert.equal(contents.get("dist/cli.js")?.split("\n", 1)[0], "#!/usr/bin/env node");
  });

  test("carries no transcript, session, or fixture data", () => {
    // Matched on EXTENSION and DIRECTORY, not on filename substrings: a name-based rule
    // flags `dist/transcripts.js`, which is source code and must ship. The distinction is
    // the point — this test exists to keep DATA out, not to police module names.
    const forbidden = paths.filter(
      (p) => p.endsWith(".jsonl") || /^(tests|tests-ts|spikes|scripts|\.story)\//.test(p),
    );
    assert.deepEqual(forbidden, [], `these must not ship:\n${forbidden.join("\n")}`);
  });

  test("ships exactly the expected set of files", () => {
    // Deliberately an exact, HAND-MAINTAINED list rather than a `dist/**` category rule.
    // A category rule answers "is this the kind of thing we ship?", which is not the question
    // — a new module that should never have shipped is exactly the kind of thing we ship.
    // Adding a file here is meant to be an edit someone makes on purpose and a reviewer sees.
    //
    // It is NOT generated from `npm pack` output: an expected set derived from the thing it
    // checks agrees with it by construction and proves nothing.
    const missing = EXPECTED_TARBALL_PATHS.filter((p) => !paths.includes(p));
    const unexpected = paths.filter((p) => !EXPECTED_TARBALL_PATHS.includes(p));
    // Reported separately, because "we stopped shipping the CLI" and "we shipped someone's
    // notes" are opposite emergencies and a single merged diff makes you work out which.
    assert.deepEqual(missing, [], `expected but MISSING from the tarball:\n${missing.join("\n")}`);
    assert.deepEqual(unexpected, [], `UNEXPECTED in the tarball:\n${unexpected.join("\n")}`);
  });

  // The three scans below read shipped file CONTENTS. The manifest check further down is
  // not enough on its own: ISS-005 shipped a real Codex rollout ID and the maintainer's
  // username in source comments, and 16 green contract tests missed both because the only
  // attribution assertion read package.json. tsc keeps comments, dist/ is in `files`, and a
  // published identifier is permanent — so the guard has to look where the bytes land.

  test("carries no personal data of any semantic class", () => {
    // These scans used to be three hand-rolled regexes: a maintainer-name literal, one
    // synthetic-UUID suffix rule, and a home-path check whose placeholder set included
    // generic names (`you`, `user`, `me`) that a real contributor could actually have.
    // T-024 replaced all of that with the repository's semantic scanner, which is stronger
    // on every axis it covered — emails, all three home-path shapes plus the mangled form,
    // anchored synthetic-id patterns instead of a suffix rule, workflow ids — and, above
    // all, contains no denylist literal: keeping the maintainer's name in a tracked grep
    // was itself a violation of the rule the grep enforced.
    const findings = [];
    for (const [path, text] of contents) {
      findings.push(...scanText(text, path));
    }
    assert.deepEqual(
      findings,
      [],
      `personal data in shipped content:\n${findings.map((f) => `${f.path}:${f.line} [${f.class}]`).join("\n")}`,
    );
  });

  test("the semantic scan would actually catch each class the old literals named", () => {
    // A denylist replaced by a classifier must be shown to still reject what the denylist
    // rejected — otherwise the swap silently weakened the guard. Values are assembled from
    // fragments so this file stays clean under its own scan.
    const j = (...parts) => parts.join("");
    const mustCatch = [
      [j("/Users", "/jdoe/.codex"), "macos-home"],
      [j("019f45d4-bf8e-7f83", "-adcb-1a8480205eef"), "session-id"],
      [j("jdoe", "@somewhere.example.co"), "email"],
    ];
    for (const [value, cls] of mustCatch) {
      assert.ok(
        scanText(value, "probe").some((f) => f.class === cls),
        `the scanner no longer catches class ${cls}`,
      );
    }
  });

  test("carries no maintainer identity, checked against this machine's, never a literal", (t) => {
    // The old bare-name grep caught a surname ANYWHERE in shipped bytes — a shape no semantic
    // class can express, because "some human surname" has no syntax. What it protected against
    // is publishing this machine's identity, and this machine knows its identity. Tokens are
    // derived at runtime, so the repository carries no name literal, and the check still bites
    // wherever a human actually packs — the only place publishing happens, since T-007 forbids
    // autonomous publish.
    //
    // Two round-1 chunk-16 corrections. The identity DOMAIN is no longer tokenized: it produced
    // tokens like the organization's own name, which then matched the repository URL in
    // package.json and failed the contract for a reason that had nothing to do with attribution.
    // And an absent identity is now a reported SKIP rather than `assert.ok(true)`, which was a
    // pass whose message nobody ever saw.
    const gitValue = (args) => {
      try {
        return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    };
    // Configured identity first; the last commit's author is the fallback for a container that
    // has none. A repository always has one of the two once anything has been committed.
    const name = gitValue(["config", "user.name"]) || gitValue(["log", "-1", "--format=%an"]);
    const email = gitValue(["config", "user.email"]) || gitValue(["log", "-1", "--format=%ae"]);
    const localPart = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;

    const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const needles = new Set();
    // The full name as a phrase, and each of its components that is long enough to identify
    // somebody. The mail DOMAIN is deliberately absent — it names an organization, not a person.
    if (name) {
      needles.add(words(name).join(" "));
      for (const w of words(name)) if (w.length >= 4) needles.add(w);
    }
    for (const w of words(localPart)) if (w.length >= 4) needles.add(w);
    needles.delete("");

    if (needles.size === 0) {
      t.skip("no git identity on this machine and no commit author to fall back on — nothing to enforce");
      return;
    }
    const hits = [...needles].flatMap((needle) =>
      scanContents(new RegExp(`^.*\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b.*$`, "gim")),
    );
    assert.deepEqual(hits, [], `maintainer identity token in shipped content:\n${hits.join("\n")}`);
  });
});

describe("the manifest", () => {
  test("carries no personal attribution", () => {
    // A published package is permanent and its metadata is mirrored widely, so this is
    // enforced here rather than left to review — and against the SHIPPED manifest, since a
    // clean working tree says nothing about a tarball packed from somewhere else.
    for (const field of ["author", "contributors", "maintainers"]) {
      assert.equal(MANIFEST[field], undefined, `package.json must not declare "${field}"`);
    }
    const blob = JSON.stringify(MANIFEST);
    // Semantic scan instead of a name literal — the literal WAS the class of leak it policed.
    const findings = scanText(blob, "package.json");
    assert.deepEqual(findings, [], `personal data in package.json: ${JSON.stringify(findings)}`);
  });

  test("declares prepare as well as prepack", () => {
    // prepack does NOT run for `npm install <git-url>`, so prepack alone would leave a
    // git-installed copy with `bin` pointing at a file that was never built.
    assert.equal(MANIFEST.scripts.prepack, "npm run build");
    assert.equal(MANIFEST.scripts.prepare, "npm run build");
  });
});

describe("installing the tarball", () => {
  let prefix;

  before(() => {
    prefix = mkdtempSync(join(tmpdir(), "spendbar-install-"));
    npm(["init", "-y"], prefix);
    // T-009 §10 / ISS-042: the consumer install runs with --ignore-scripts. With a clean
    // dependency tree the flag changes nothing observable, so the assertion below reads what
    // the npm() helper actually spawned.
    npm(["install", "--no-save", "--ignore-scripts", tarball], prefix);
  });

  after(() => {
    if (prefix) rmSync(prefix, { recursive: true, force: true });
  });

  test("links a spendbar binary that is executable", () => {
    const bin = join(prefix, "node_modules", ".bin", "spendbar");
    assert.ok(existsSync(bin), "npm did not link node_modules/.bin/spendbar");
    assert.ok(statSync(join(prefix, "node_modules", "spendbar", "dist", "cli.js")).mode & 0o111);
  });

  test("runs, reports its own name, and exits 0", () => {
    const r = spawnSync(join(prefix, "node_modules", ".bin", "spendbar"), ["--help"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: spendbar \[-h\]/);
    // The oracle's program name must not survive into the shipped help (ALLOWLIST 22).
    assert.doesNotMatch(r.stdout, /\busage (projects|daily|codex|combined)\b/);
  });

  test("reports a usage error on stderr with exit 2, through the installed entrypoint", () => {
    // Proves the exit-code path survives packaging, not just the in-process `main`.
    const r = spawnSync(join(prefix, "node_modules", ".bin", "spendbar"), ["frobnicate"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /spendbar: error: argument cmd: invalid choice/);
  });

  test("the consumer install actually ran with --ignore-scripts (argument capture)", () => {
    // The mutation this kills: removing the flag from the install call. Nothing in a clean tree
    // reveals that mutant — only the arguments do. And they are read from the recording the
    // npm() helper makes as it spawns, because an array the test built and then asserted about
    // is a test asserting about itself (review round 1, chunk 16).
    const installs = npmInvocations.filter((i) => i.args[0] === "install" && i.args.includes(tarball));
    assert.equal(installs.length, 1, `expected exactly one tarball install, saw ${installs.length}`);
    assert.ok(
      installs[0].args.includes("--ignore-scripts"),
      `tarball install args lost --ignore-scripts: ${installs[0].args.join(" ")}`,
    );
  });

  test("the selected MCP SDK loads from the installed package — or skips loudly against the recorded decision", (t) => {
    // T-009 §10: keyed off the RECORDED decision, never off this test's own ability to find a
    // module — a missing adapter must fail the adopt path, not skip it.
    //
    // Every state that checks nothing reports itself as SKIPPED, with a reason. `assert.ok(true,
    // "…")` was reported as a pass and its message never printed, so a suite in which this test
    // had verified nothing was indistinguishable from one in which it had (review round 1,
    // chunk 16).
    const decisionPath = join(REPO, "spikes", "mcp", "evidence", "decision.json");
    if (!existsSync(decisionPath)) {
      t.skip("no recorded T-009 decision yet (the gate has not run to a verdict) — nothing to smoke-test");
      return;
    }
    const decision = JSON.parse(readFileSync(decisionPath, "utf8"));
    if (decision.outcome === "blocked") {
      t.skip("the recorded decision is 'blocked' — by that decision there is no adapter to smoke-test");
      return;
    }
    assert.match(decision.outcome, /^adopt-(v1|v2)$/, `unrecognized recorded outcome ${decision.outcome}`);
    // The specifier the ADAPTER would import, not the package root. v1 ships no working root
    // export — its own `.` maps to absent files, which isolate.test.mjs pins — so resolving the
    // bare package name would fail a correctly installed v1 (review round 1, chunk 16). These
    // are the specifiers the candidate servers import; see spikes/mcp/candidates/*/server.mjs.
    const SPECIFIER = {
      "adopt-v1": { pkg: "@modelcontextprotocol/sdk", entry: "@modelcontextprotocol/sdk/server/mcp.js" },
      "adopt-v2": { pkg: "@modelcontextprotocol/server", entry: "@modelcontextprotocol/server" },
    }[decision.outcome];
    if (MANIFEST.dependencies?.[SPECIFIER.pkg] === undefined) {
      // Adopt is recorded, but adding the root dependency is owner-gated: open question 2
      // (pinning syntax) is not this test's to answer. Keyed off the SHIPPED manifest — a
      // recorded fact — not off this test's ability to resolve a module.
      t.skip(`decision is ${decision.outcome} but ${SPECIFIER.pkg} is not yet a root dependency — waiting on open question 2`);
      return;
    }
    // Once the owner has answered and the dependency ships, it must actually resolve where
    // spendbar is installed — from here on, a missing SDK is a failure, never a skip.
    const installedPkg = join(prefix, "node_modules", "spendbar", "package.json");
    const resolveFromInstalled = createRequire(installedPkg).resolve;
    assert.doesNotThrow(
      () => resolveFromInstalled(SPECIFIER.entry),
      `the shipped manifest declares ${SPECIFIER.pkg} but ${SPECIFIER.entry} does not resolve from the installed package`,
    );
  });
});
