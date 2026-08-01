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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  "dist/table.js",
  "dist/transcripts.js",
  "dist/unicode-tables.js",
];

/** npm is chatty on stderr; only a non-zero status is a failure. */
function npm(args, cwd, extraEnv = {}) {
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

  test("carries no personal name, anywhere, with no exemptions", () => {
    // This scan used to exempt LICENSE's copyright line, because the named MIT holder was an
    // open owner decision. It was decided (spendbar contributors), so the exemption is gone
    // and the scan now runs against every shipped byte. An exemption list that is empty is
    // worth more than one that is merely short: there is no longer a place to put a name.
    const hits = scanContents(/^.*shayegh.*$/gim);
    assert.deepEqual(hits, [], `personal name in shipped content:\n${hits.join("\n")}`);
  });

  test("carries no real session identifier", () => {
    // Rollout filenames are UUIDv7: 48 timestamp bits, then version/variant nibbles and
    // random bits. The fixtures keep the timestamp real (it encodes the date under test)
    // and zero every random bit, so a synthetic id ends `-7000-8000-0000000000xx`. A real
    // one — the shipped `…-7f83-adcb-1a8480205eef` — cannot, which is precisely the
    // difference between an example and someone's actual session.
    const SYNTHETIC = /-7000-8000-0000000000[0-9a-f]{2}$/;
    const real = scanContents(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    ).filter((hit) => !SYNTHETIC.test(hit));
    assert.deepEqual(real, [], `non-synthetic UUID in shipped content:\n${real.join("\n")}`);
  });

  test("carries no real home directory path", () => {
    // `/Users/testuser/.codex` shipped in a worked example. Placeholder accounts keep the
    // example legible without naming anyone; the list is deliberately short so that adding
    // to it is a conscious act rather than a reflex.
    const PLACEHOLDER = new Set(["testuser", "you", "user", "me"]);
    const real = scanContents(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g).filter(
      (hit) => !PLACEHOLDER.has(hit.slice(hit.lastIndexOf("/") + 1)),
    );
    assert.deepEqual(real, [], `real home path in shipped content:\n${real.join("\n")}`);
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
    assert.doesNotMatch(blob, /shayegh/i, "personal name found in package.json");
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
    npm(["install", "--no-save", tarball], prefix);
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
});
