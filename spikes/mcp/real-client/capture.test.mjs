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
  buildClientInvocation,
  ciIndicator,
  codexConfigSuppressionWitness,
  disclosesEnvValue,
  parseCells,
  preflight,
  sweepAbandonedIn,
  validateFlags,
} from "./capture.mjs";
import { exitCodeFor } from "./capture-wrapper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A named subdirectory, so each fixture gets its own PATH entry. */
function mkdirIn(parent, name) {
  const d = join(parent, name);
  mkdirSync(d, { recursive: true });
  return d;
}
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

// ---------- user-configuration isolation (ISS-047) --------------------------------------------
//
// The premise these tests exist to keep honest: for four paid captures, `userConfigIsolated` was
// computed as `client === "claude-code"`, on the stated ground that codex had no equivalent of
// --strict-mcp-config. That was never checked against the installed binary, and it was false —
// `codex exec --ignore-user-config` is documented as "do not load $CODEX_HOME/config.toml; auth
// still uses CODEX_HOME". Once the isolation gate landed, that unchecked claim would have forced
// a contract decision (drop Codex, or accept non-isolated evidence) that the facts did not
// require. Nothing pinned any of it.

/**
 * The isolation flags each client's invocation must carry, as an INDEPENDENT literal.
 *
 * Deliberately NOT imported from capture.mjs and deliberately not shared with the preflight's
 * own list. An expectation read out of the module under test agrees with that module by
 * construction — the defect this review round keeps finding. Removing a flag from the
 * invocation has to fail here, which it cannot do if this list moves with it.
 */
const REQUIRED_ISOLATION_FLAGS = {
  "claude-code": ["--strict-mcp-config", "--mcp-config", "--settings"],
  codex: ["--ignore-user-config", "--ignore-rules", "--ephemeral"],
};

test("every client invocation carries its user-configuration isolation flags", () => {
  const scratch = mkdtempSync(join(tmpdir(), "t009-inv-"));
  try {
    const wrapperCmd = [process.execPath, "/nonexistent/wrapper.mjs", "/nonexistent/root", scratch];
    for (const [client, flags] of Object.entries(REQUIRED_ISOLATION_FLAGS)) {
      const { binary, args } = buildClientInvocation(client, "the prompt", wrapperCmd, scratch);
      assert.equal(binary, client === "claude-code" ? "claude" : "codex");
      for (const flag of flags) {
        assert.ok(args.includes(flag), `${client} invocation is missing ${flag}`);
      }
      // The probe server must still be the only MCP server declared, or "isolated" would mean
      // isolated from the thing being measured.
      assert.ok(
        args.some((a) => String(a).includes("spendbar-probe")),
        `${client} invocation declares no probe server`,
      );
    }
    // Isolating codex's configuration removes whatever approved the tool call, and the measured
    // consequence is that codex CANCELS its own tools/call and never sends it. The grant has to
    // travel with the isolation or the capture scores the client's approval UX as an SDK
    // conformance failure. Asserted as a literal here for the same reason as the flag list.
    const { args: codexArgs } = buildClientInvocation("codex", "p", wrapperCmd, scratch);
    assert.ok(
      codexArgs.some((a) => String(a) === 'mcp_servers.spendbar-probe.default_tools_approval_mode="approve"'),
      "the codex invocation does not approve the probe tool, so the client will cancel its own tools/call",
    );
    // Scoped to the probe server, and NOT by disabling the sandbox — which also works and is
    // the wrong trade.
    assert.ok(
      !codexArgs.includes("--dangerously-bypass-approvals-and-sandbox"),
      "the capture is bypassing the sandbox to solve a tool-approval problem",
    );
    // Non-vacuity: an empty flag table would satisfy every loop above.
    assert.equal(Object.keys(REQUIRED_ISOLATION_FLAGS).length, 2);
    assert.equal(Object.values(REQUIRED_ISOLATION_FLAGS).flat().length, 6);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the preflight refuses a client that does not advertise its isolation flags", () => {
  // validateFlags is what stands between "the flag was in the plan" and "this binary has it".
  // Driven against a stub whose --help output is controlled, so the discrimination is visible
  // rather than dependent on whichever CLI happens to be installed.
  const dir = mkdtempSync(join(tmpdir(), "t009-help-"));
  try {
    const stub = join(dir, "stub.mjs");
    const advertise = (flags) => {
      writeFileSync(stub, `process.stdout.write(${JSON.stringify(flags.join("\n"))});\n`);
      return [process.execPath, [stub]];
    };
    const wanted = REQUIRED_ISOLATION_FLAGS.codex;
    // Non-vacuity, asserted HERE rather than relied on from the invocation test above: an empty
    // list makes the drop-one loop run zero times while the positive assertion still passes,
    // because validateFlags(binary, help, []) is trivially ok. A test has to be non-vacuous on
    // its own terms — depending on a sibling test's count is how a guard goes missing when the
    // sibling is edited.
    assert.equal(wanted.length, 3, "the codex isolation flag list is empty — this test proves nothing");

    const [bin, helpArgs] = advertise(wanted);
    assert.equal(validateFlags(bin, helpArgs, wanted).ok, true, "a binary advertising every flag was refused");

    for (const dropped of wanted) {
      const [b2, h2] = advertise(wanted.filter((f) => f !== dropped));
      const result = validateFlags(b2, h2, wanted);
      assert.equal(result.ok, false, `a binary missing ${dropped} was accepted`);
      assert.ok(result.missing.includes(dropped), `the refusal does not name ${dropped}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stand-in `codex` whose config-loading behaviour is controlled.
 *
 * `honoursFlag: true` emulates a real codex: it reads $CODEX_HOME/config.toml and dies on a
 * malformed one UNLESS --ignore-user-config is present. `false` emulates a codex that advertises
 * the flag and ignores it — the case the witness exists to catch, and the one no amount of
 * --help parsing can detect.
 */
function fakeCodex(dir, name, { honoursFlag }) {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(
    path,
    `import { readFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `const args = process.argv.slice(2);\n` +
      `const ignore = ${honoursFlag ? 'args.includes("--ignore-user-config")' : "false"};\n` +
      `if (!ignore) {\n` +
      `  const text = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");\n` +
      // A TOML line is well-formed here only as \`bare.key = value\`. The witness's fixture
      // (\`this is [not valid toml ===\`) fails that; a real config would not.
      `  const lines = text.split("\\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));\n` +
      `  if (lines.some((l) => !/^[A-Za-z0-9_.-]+\\s*=/.test(l.trim()))) {\n` +
      `    process.stdout.write("Error loading config.toml:\\n");\n` +
      `    process.exit(1);\n` +
      `  }\n` +
      `}\n` +
      `process.stdout.write("OpenAI Codex v0.144.0\\n");\n`,
  );
  return path;
}

test("the codex isolation witness is a demonstration, not a claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "t009-witness-"));
  try {
    // codexConfigSuppressionWitness(binary) execs `binary exec ...`, so each stand-in needs to
    // BE an executable. A one-line shell wrapper with the script pre-bound gives it that shape.
    const runWitness = (name, opts) => {
      const script = fakeCodex(dir, name, opts);
      const wrapper = join(dir, `bin-${name}`);
      writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, {
        mode: 0o755,
      });
      return codexConfigSuppressionWitness(wrapper);
    };

    const good = runWitness("honest", { honoursFlag: true });
    assert.equal(good.witnessed, true, `an honest codex failed the witness: ${good.detail}`);

    const bad = runWitness("liar", { honoursFlag: false });
    assert.equal(bad.witnessed, false, "a codex that ignores --ignore-user-config passed the witness");
    assert.match(bad.detail, /still reported the config error|--ignore-user-config did not exclude/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the witness refuses when its own control does not fire", () => {
  // The differential proves nothing if control A passes: a binary that never reads config.toml
  // would then look isolated for the wrong reason. This is the positive control on the control.
  const dir = mkdtempSync(join(tmpdir(), "t009-witness-null-"));
  try {
    const script = join(dir, "never-reads.mjs");
    writeFileSync(script, `process.stdout.write("OpenAI Codex v0.144.0\\n");\n`);
    const wrapper = join(dir, "bin-never");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, {
      mode: 0o755,
    });
    const result = codexConfigSuppressionWitness(wrapper);
    assert.equal(result.witnessed, false, "a binary that never reads config.toml was certified as isolating");
    assert.match(result.detail, /control A did not fail/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A complete stand-in `codex` on PATH, answering all three shapes preflight uses: `--version`,
 * `exec --help`, and a real `exec` run whose config-loading behaviour is controlled.
 *
 * This exists because testing the PARTS left the wiring unpinned, which mutation testing found:
 * narrowing preflight's validated flag list, and reverting `userConfigIsolated` to
 * `client === "claude-code"`, BOTH survived a suite that exercised validateFlags and the witness
 * directly. Each part worked; nothing asserted preflight used them. That is the same shape as
 * the verify-script wiring gap in decide.test.mjs — a correct component the entry point does not
 * call is a promise, not a gate.
 */
function fakeCodexOnPath(dir, { advertises, honoursFlag }) {
  const script = join(dir, "codex-impl.mjs");
  writeFileSync(
    script,
    `import { readFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args.includes("--version")) { process.stdout.write("codex-cli 0.144.0\\n"); process.exit(0); }\n` +
      `if (args[0] === "exec" && args.includes("--help")) {\n` +
      `  process.stdout.write(${JSON.stringify(advertises.join("\n") + "\n")});\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `const ignore = ${honoursFlag ? 'args.includes("--ignore-user-config")' : "false"};\n` +
      `if (!ignore) {\n` +
      `  const text = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");\n` +
      `  const lines = text.split("\\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));\n` +
      `  if (lines.some((l) => !/^[A-Za-z0-9_.-]+\\s*=/.test(l.trim()))) {\n` +
      `    process.stdout.write("Error loading config.toml:\\n");\n` +
      `    process.exit(1);\n` +
      `  }\n` +
      `}\n` +
      `process.stdout.write("OpenAI Codex v0.144.0\\n");\n`,
  );
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, {
    mode: 0o755,
  });
  return dir;
}

/** Run `fn` with PATH pointing at `dir` (plus node's own directory, which the shim needs). */
function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${dirname(process.execPath)}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

test("preflight certifies codex isolation only when the flags are advertised AND demonstrated", () => {
  const FULL = ["--config", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--ephemeral"];
  const dir = mkdtempSync(join(tmpdir(), "t009-preflight-"));
  try {
    // 1. Advertised and honoured -> isolation certified, and REPORTED as a fact the manifest
    //    will carry. `userConfigIsolated` used to be computed from the client's name here.
    const ok = withPath(fakeCodexOnPath(mkdirIn(dir, "good"), { advertises: FULL, honoursFlag: true }), () =>
      preflight("codex"),
    );
    assert.equal(ok.ok, true, `preflight refused an isolating codex: ${JSON.stringify(ok.environmental)}`);
    assert.equal(ok.userConfigIsolated, true, "preflight did not report the isolation it just demonstrated");

    // 2. Advertised but IGNORED -> refused. No --help parsing can catch this; only the
    //    differential can, and preflight must consult it.
    const liar = withPath(fakeCodexOnPath(mkdirIn(dir, "liar"), { advertises: FULL, honoursFlag: false }), () =>
      preflight("codex"),
    );
    assert.equal(liar.ok, false, "a codex that ignores --ignore-user-config was certified as isolating");
    assert.equal(liar.environmental.condition, "isolation-unavailable");

    // 3. Not advertised -> refused before any run, naming the missing flag.
    for (const missing of ["--ignore-user-config", "--ignore-rules", "--ephemeral"]) {
      const sub = mkdirIn(dir, `no${missing.replace(/-/g, "")}`);
      const result = withPath(
        fakeCodexOnPath(sub, { advertises: FULL.filter((f) => f !== missing), honoursFlag: true }),
        () => preflight("codex"),
      );
      assert.equal(result.ok, false, `preflight accepted a codex not advertising ${missing}`);
      assert.ok(result.environmental.detail.includes(missing), `the refusal does not name ${missing}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
