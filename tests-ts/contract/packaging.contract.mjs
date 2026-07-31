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
 *   * the manifest must carry no personal attribution.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

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

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "spendbar-pack-"));
  // `npm pack` runs prepack, so this also proves the tarball cannot be cut from a stale
  // dist/ — the build is part of packing, not something a developer has to remember.
  const out = npm(["pack", "--pack-destination", scratch], REPO);
  tarball = join(scratch, out.trim().split("\n").pop().trim());
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
});

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
    assert.equal(
      readFileSync(join(REPO, "dist", "cli.js"), "utf8").split("\n", 1)[0],
      "#!/usr/bin/env node",
    );
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

  test("ships only dist/ and the documented top-level files", () => {
    const stray = paths.filter(
      (p) => !p.startsWith("dist/") && !["package.json", "README.md", "LICENSE"].includes(p),
    );
    assert.deepEqual(stray, [], `unexpected entries:\n${stray.join("\n")}`);
  });
});

describe("the manifest", () => {
  test("carries no personal attribution", () => {
    // A published package is permanent and its metadata is mirrored widely, so this is
    // enforced here rather than left to review.
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
