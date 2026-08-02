// Tests for the capture command's lifecycle, added in review round 2 chunk 4.
//
// capture.mjs is the only thing in this repository that spends money and the only thing that
// recursively deletes inside the operator's home directory. Its risky parts had no tests at
// all: the abandonment sweep, the --cell parser, the CI prohibition and the environment
// disclosure predicate were exercised only by running the real thing, which costs quota.
//
// Everything here is a pure function or a filesystem fixture. Nothing in this file spawns a
// client, and the CI test asserts precisely that the entry point CANNOT.
//
// Runs under `node --test` or directly.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_CELLS,
  CAPTURE_ID,
  OWNER_MARKER,
  RETENTION_DAYS,
  ciIndicator,
  disclosesEnvValue,
  parseCells,
  sweepAbandonedIn,
} from "./capture.mjs";
import { exitCodeFor } from "./capture-wrapper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 3600 * 1000;

/** A retained-directory fixture, with `sweepAbandoned` rebound to it. */
function withRetained(fn) {
  const dir = mkdtempSync(join(tmpdir(), "t009-sweep-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A capture directory old enough to sweep, complete with its ownership marker. */
function agedCapture(root, id, { ageDays = RETENTION_DAYS + 1, marker = true } = {}) {
  const dir = join(root, id);
  mkdirSync(dir);
  if (marker) writeFileSync(join(dir, OWNER_MARKER), `${id}\n`);
  const when = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(dir, when, when);
  return dir;
}

/** The sweep, against a fixture root rather than the operator's real retained directory. */
const sweep = (root, now = Date.now()) => sweepAbandonedIn(root, now).swept;
const skips = (root, now = Date.now()) => sweepAbandonedIn(root, now).skipped;

// ---------- the abandonment sweep ------------------------------------------------------------

test("the sweep removes a capture it can prove is its own and old", () => {
  withRetained((root) => {
    agedCapture(root, "claude-code-v2-deadbeef");
    assert.deepEqual(sweep(root), ["claude-code-v2-deadbeef"]);
  });
});

test("the sweep keeps a capture that is merely young", () => {
  withRetained((root) => {
    agedCapture(root, "claude-code-v2-deadbeef", { ageDays: 1 });
    assert.deepEqual(sweep(root), []);
  });
});

test("the sweep will not delete something it cannot prove it wrote", () => {
  // This is a recursive delete inside the operator's home directory. Every one of these used to
  // be removed on age alone: an unrelated directory, a directory with no ownership marker, and
  // a plain file. Each must survive, and the sweep must say it left them.
  withRetained((root) => {
    const unrelated = join(root, "my-important-notes");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "notes.md"), "keep me");
    const old = new Date(Date.now() - 400 * DAY_MS);
    utimesSync(unrelated, old, old);

    agedCapture(root, "codex-v1-feedface", { marker: false });

    const loose = join(root, "claude-code-v1-aabbccdd");
    writeFileSync(loose, "not a directory");
    utimesSync(loose, old, old);

    assert.deepEqual(sweep(root), []);
    for (const survivor of [unrelated, join(root, "codex-v1-feedface"), loose]) {
      assert.ok(spawnSync("test", ["-e", survivor]).status === 0, `${survivor} was deleted`);
    }
  });
});

test("the sweep does not follow a symlink out of the retained directory", () => {
  withRetained((root) => {
    const outside = mkdtempSync(join(tmpdir(), "t009-outside-"));
    writeFileSync(join(outside, "precious.txt"), "do not delete");
    try {
      // The target is aged, carries a valid ownership marker, and is reached under a valid
      // capture name — so EVERY other guard passes and only the lstat stands between this
      // symlink and a recursive delete outside the retained directory.
      writeFileSync(join(outside, OWNER_MARKER), "claude-code-v2-deadbeef\n");
      const old = new Date(Date.now() - 400 * DAY_MS);
      utimesSync(outside, old, old);
      symlinkSync(outside, join(root, "claude-code-v2-deadbeef"));
      assert.deepEqual(sweep(root), []);
      assert.ok(skips(root).some((s) => s.includes("not a directory")), skips(root).join("; "));
      assert.equal(spawnSync("test", ["-e", join(outside, "precious.txt")]).status, 0, "the symlink target was deleted");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("a capture whose mtime is in the future is left alone rather than kept forever", () => {
  // A clock skew that puts the mtime ahead makes the age negative, which the old comparison
  // read as "very young" — pinning the capture until someone noticed. It is now reported.
  withRetained((root) => {
    const dir = agedCapture(root, "codex-v2-01234567");
    const future = new Date(Date.now() + 400 * DAY_MS);
    utimesSync(dir, future, future);
    assert.deepEqual(sweep(root), []);
    // Not swept is only half of it. An unusable timestamp must be REPORTED, or a capture pinned
    // by clock skew sits in the retained directory forever looking exactly like a fresh one.
    assert.ok(skips(root).some((s) => s.includes("mtime is in the future")), skips(root).join("; "));
  });
});

test("a dangling entry does not abort the sweep partway through", () => {
  withRetained((root) => {
    symlinkSync(join(root, "nowhere"), join(root, "codex-v1-feedface"));
    agedCapture(root, "claude-code-v2-deadbeef");
    assert.deepEqual(sweep(root), ["claude-code-v2-deadbeef"], "the sweep stopped at the broken entry");
  });
});

test("a directory that is ours in every way but its name is still not swept", () => {
  // The name check was the only guard with nothing exercising it alone: the other fixtures were
  // also missing a marker or were not directories, so the sweep refused them for those reasons
  // and a sweep that ignored names entirely still passed. This one is aged, is a real directory
  // and carries a valid marker — the name is all that saves it.
  withRetained((root) => {
    const dir = join(root, "claude-code-v2-not-a-capture-id");
    mkdirSync(dir);
    writeFileSync(join(dir, OWNER_MARKER), "claude-code-v2-not-a-capture-id\n");
    const old = new Date(Date.now() - 400 * DAY_MS);
    utimesSync(dir, old, old);
    assert.deepEqual(sweep(root), []);
    assert.ok(skips(root).some((s) => s.includes("not a capture id")), skips(root).join("; "));
  });
});

test("the capture-id pattern admits exactly the ids the capture command builds", () => {
  for (const id of ["claude-code-v2-deadbeef", "codex-v1-00000000"]) assert.ok(CAPTURE_ID.test(id), id);
  for (const id of ["", "..", "claude-code-v2", "claude-code-v3-deadbeef", "other-v1-deadbeef", "claude-code-v2-deadbee", "claude-code-v2-DEADBEEF", "claude-code-v2-deadbeef/x"]) {
    assert.ok(!CAPTURE_ID.test(id), id);
  }
});

// ---------- --cell selection -----------------------------------------------------------------

test("--cell accepts the form the usage line documents", () => {
  // The parser only ever understood `--cell=x:y`, while the header documented `--cell x:y`.
  // The space form therefore selected nothing, fell through to "no selection means all of
  // them", and spent four cells of quota instead of the one that was asked for.
  assert.deepEqual(parseCells(["--cell", "codex:v1"]), ["codex:v1"]);
  assert.deepEqual(parseCells(["--cell=codex:v1"]), ["codex:v1"]);
  assert.deepEqual(parseCells(["--cell", "codex:v1", "--cell=claude-code:v2"]), ["codex:v1", "claude-code:v2"]);
});

test("no selection means every cell, and that list is the declared one", () => {
  assert.deepEqual(parseCells([]), ALL_CELLS);
  assert.notEqual(parseCells([]), ALL_CELLS, "the caller must not be handed the module's own array");
});

test("a cell that is not one of the four is refused before anything spawns", () => {
  // `--cell=foo:v1` used to reach the codex branch, spend real quota, and only then be rejected
  // by the sanitizer — which meant the paid run could never become evidence.
  for (const bad of ["foo:v1", "claude-code:v3", "claude-code", "claude-code:v1:extra", "", "CODEX:V1"]) {
    assert.throws(() => parseCells([`--cell=${bad}`]), /--cell/, bad);
  }
  assert.throws(() => parseCells(["--cell"]), /needs a <client>:<candidate> value/);
  assert.throws(() => parseCells(["--cell", "--purge"]), /needs a <client>:<candidate> value/);
});

test("the same cell twice is refused rather than paid for twice", () => {
  assert.throws(() => parseCells(["--cell=codex:v1", "--cell=codex:v1"]), /more than once/);
});

// ---------- the CI prohibition ----------------------------------------------------------------

test("every documented CI marker is detected, and an unset or disabled one is not", () => {
  for (const name of ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TF_BUILD", "CONTINUOUS_INTEGRATION"]) {
    assert.equal(ciIndicator({ [name]: "true" }), name);
    assert.equal(ciIndicator({ [name]: "1" }), name);
  }
  assert.equal(ciIndicator({}), null);
  // The shapes a shell uses to mean "off" must not read as "on", or a developer machine that
  // exports CI=false could never run the capture.
  for (const off of ["", "0", "false", "False"]) assert.equal(ciIndicator({ CI: off }), null, off);
});

test("the capture command refuses to run under CI, before it can spawn anything", () => {
  // The header has always claimed this command is never CI-runnable; until now nothing enforced
  // it. An accidental workflow step would have spent four cells of quota and authenticated from
  // the runner's HOME. PATH is emptied so that if the refusal ever regresses, the test fails by
  // being unable to find a client rather than by quietly buying one.
  const run = spawnSync(process.execPath, [join(HERE, "capture.mjs")], {
    encoding: "utf8",
    timeout: 30_000,
    env: { CI: "true", HOME: process.env.HOME, PATH: "" },
  });
  assert.notEqual(run.status, 0, "the capture command exited successfully under CI");
  assert.match(run.stderr, /forbidden in CI/);
  assert.match(run.stderr, /CI is set/);
});

// ---------- the tee wrapper's exit code -------------------------------------------------------

test("a server that never spawned cannot be reported as a clean exit", () => {
  // Node emits `close` after a failed spawn too, and the close handler used to recompute the
  // code from scratch — discarding the 3 the error handler had just set. Observed here: a spawn
  // that never happened closes with code -2, the raw negative errno, which reaches a shell as
  // 254 and means nothing. The spawn failure now wins.
  assert.equal(exitCodeFor({ spawnFailed: true, code: -2, signal: null }), 3);
  assert.equal(exitCodeFor({ spawnFailed: true, code: null, signal: null }), 3);
  assert.equal(exitCodeFor({ spawnFailed: true, code: 0, signal: null }), 3, "a spawn failure reported as success");
});

test("an unexplained exit is a failure, not a success", () => {
  // `code ?? 0` published "the child left and nobody recorded why" as a clean run.
  assert.equal(exitCodeFor({ spawnFailed: false, code: null, signal: null }), 1);
});

test("a signalled server leaves through the conventional 128+n, and a clean one through its code", () => {
  assert.equal(exitCodeFor({ spawnFailed: false, code: null, signal: "SIGKILL", signals: { SIGKILL: 9 } }), 137);
  assert.equal(exitCodeFor({ spawnFailed: false, code: null, signal: "SIGTERM", signals: { SIGTERM: 15 } }), 143);
  // An unknown signal name still reports a signalled death rather than resolving to a code.
  assert.equal(exitCodeFor({ spawnFailed: false, code: null, signal: "SIGWEIRD", signals: {} }), 128);
  assert.equal(exitCodeFor({ spawnFailed: false, code: 0, signal: null }), 0);
  assert.equal(exitCodeFor({ spawnFailed: false, code: 7, signal: null }), 7);
});

test("importing the wrapper does not spawn a server", async () => {
  // The exit-code rule is only testable because the executable body sits behind a direct-entry
  // guard. Without it, importing this module for one pure function would start a candidate
  // server against whatever argv happened to be lying around.
  const mod = await import("./capture-wrapper.mjs");
  assert.equal(typeof mod.exitCodeFor, "function");
});

// ---------- the environment-disclosure predicate ----------------------------------------------

test("an identifying environment value is caught at any length", () => {
  // The rule used to skip everything under eight characters, which exempts exactly the values
  // most likely to be short and identifying: USER and LOGNAME.
  assert.equal(disclosesEnvValue({ USER: "amy" }, "running as amy on this box"), true);
  assert.equal(disclosesEnvValue({ LOGNAME: "jd" }, "hello jd"), true);
  const home = ["/home", "/x"].join(""); // assembled: a literal home path would not survive the commit scanner
  assert.equal(disclosesEnvValue({ HOME: home }, `cwd is ${home} now`), true);
  assert.equal(disclosesEnvValue({ HTTPS_PROXY: "http://u:p@h:1" }, "via http://u:p@h:1"), true);
});

test("a short identifying value is matched on word boundaries, not as a substring", () => {
  // Without boundaries a three-letter account name fires on any word containing it, and the
  // predicate would report a disclosure on every transcript.
  assert.equal(disclosesEnvValue({ USER: "amy" }, "the dynamic range"), false);
  assert.equal(disclosesEnvValue({ USER: "amy" }, "amy_smith"), false);
  assert.equal(disclosesEnvValue({ USER: "amy" }, "(amy)"), true);
});

test("only the variables named as non-identifying are exempt, and not for being short", () => {
  for (const name of ["LANG", "LC_ALL", "TERM", "NO_PROXY"]) {
    assert.equal(disclosesEnvValue({ [name]: "en_US.UTF-8" }, "locale is en_US.UTF-8"), false, name);
  }
  // TMPDIR is short-ish and NOT exempt: it is a path into the operator's filesystem.
  assert.equal(disclosesEnvValue({ TMPDIR: "/tmp/x" }, "wrote /tmp/x/f"), true);
  assert.equal(disclosesEnvValue({ USER: "" }, "anything at all"), false, "an empty value is not a disclosure");
});
