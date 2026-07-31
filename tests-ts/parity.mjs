#!/usr/bin/env node
/**
 * Differential parity harness: run usage.py and the TypeScript port against the same
 * fixture environment and compare raw bytes.
 *
 * The 33 stored goldens are a good corpus but a poor oracle for a general CLI contract —
 * they omit --help, hourly with data, most parser failures, Unicode names, tie ordering
 * and terminal widths. This harness exists so those can be asserted against live Python
 * instead of against nothing.
 *
 * A verification harness that cannot fail is worse than no harness, because it reports
 * success. So the run starts by proving it can fail: a stub process with dictated stdout
 * bytes, stderr bytes and manner of death is compared against deliberately perturbed
 * copies of itself, and every one of those comparisons is required to report a
 * difference. Only then does it compare anything real.
 *
 *   node tests-ts/parity.mjs                      # capabilities implemented so far
 *   node tests-ts/parity.mjs --capabilities=all   # everything, for a work-in-progress check
 *   node tests-ts/parity.mjs --final              # + assert nothing was skipped
 */
import { existsSync } from "node:fs";
import { compareRuns } from "./harness/compare.mjs";
import { ALL_CAPABILITIES, ENABLED, parseCapabilities } from "./harness/capabilities.mjs";
import { assertRegistry, loadCases, SANCTIONED_STDOUT_REWRITE } from "./harness/cases.mjs";
import { anchorToday, assertEnvironmentContract, buildFixtures, childEnv, PATHS } from "./harness/env.mjs";
import { describeTermination, runProcess } from "./harness/run.mjs";

// ---------------------------------------------------------------- reporting
const tally = { pass: 0, fail: 0, skip: 0 };
const failures = [];
const skipped = [];
/** case name -> how many times the differential phase executed it; `--final` demands 1. */
const executed = new Map();
let section = "";

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function heading(title) {
  section = title;
  process.stdout.write(`\n${bold(title)}\n`);
}

function check(name, fn) {
  try {
    fn();
    tally.pass++;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (e) {
    tally.fail++;
    failures.push({ section, name, message: e.message });
    process.stdout.write(`  FAIL  ${name}\n`);
  }
}

/**
 * A skipped case. `sanctioned` marks a skip that is PHASE-appropriate rather than a
 * coverage hole — the case is asserted in a different phase. The final invariant does not
 * take that label on trust: it re-checks that the differential phase really did run it.
 */
function skip(name, why, opts = {}) {
  tally.skip++;
  skipped.push({ section, name, why, sanctioned: opts.sanctioned === true });
  process.stdout.write(`  skip  ${name}  (${why})\n`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Assert two runs are byte-identical, rendering the first difference when they are not. */
function assertSame(label, expected, actual) {
  const diffs = compareRuns(expected, actual);
  assert(diffs.length === 0, `${label}\n${diffs.map((d) => `  [${d.stream}] ${d.detail}`).join("\n")}`);
}

/** Assert a comparison DID report a difference, and on the stream we expected. */
function assertDiffers(label, expected, actual, stream) {
  const diffs = compareRuns(expected, actual);
  assert(diffs.length > 0, `${label}: the comparator reported no difference — it is not comparing`);
  assert(
    diffs.some((d) => d.stream === stream),
    `${label}: expected a ${stream} difference, got ${diffs.map((d) => d.stream).join(", ")}`,
  );
}

// ---------------------------------------------------------------- flags
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 1);
};
/**
 * Variables a child sets on ITSELF after exec, which therefore appear in an environment
 * the harness constructed without them. Measured on macOS 25.5 with `env -i`:
 * CoreFoundation writes __CF_USER_TEXT_ENCODING in both node and python3, and CPython's
 * locale coercion writes LC_CTYPE. Neither is inherited from this process — the canary
 * assertion above is what proves nothing leaks — and neither is read by usage.py.
 */
const SELF_INJECTED = new Set(["__CF_USER_TEXT_ENCODING", "LC_CTYPE"]);

const FINAL = argv.includes("--final");
// `--final` runs with the DECLARED set, not with everything switched on. Substituting
// ALL_CAPABILITIES here would make the "every capability is enabled" invariant compare a
// set against itself — tautologically true, and blind to the one regression it exists to
// catch: a capability that ships disabled. Combining --final with --capabilities would
// reintroduce the same blind spot from the command line, so it is refused.
if (FINAL && flagValue("--capabilities") !== undefined) {
  process.stderr.write("--final asserts the declared ENABLED set; it cannot be combined with --capabilities\n");
  process.exit(2);
}
const enabled = FINAL ? new Set(ENABLED) : parseCapabilities(flagValue("--capabilities"));

// ---------------------------------------------------------------- setup
heading("environment contract");
let python;
check("goldens were captured under the environment this harness constructs", () => {
  python = assertEnvironmentContract();
});
if (!python) {
  process.stdout.write("\nthe environment contract failed; nothing further can be trusted\n");
  report();
}

const cases = loadCases();
check("every case carries a known capability tag, and every tag names a real case", () => {
  assertRegistry(cases);
});

const fixtures = buildFixtures(python);
const ANCHOR = anchorToday();
process.stdout.write(`  using Python ${python}\n  anchor ${ANCHOR}\n  fixture home ${fixtures.home}\n`);

try {
  selfTestHarness();
  selfTestWrappers();
  replayPythonOracle();
  verifyArgvMatrix();
  runDifferential();
  if (FINAL) finalInvariant();
} finally {
  fixtures.dispose();
}
report();

// ---------------------------------------------------------------- phase 1: can it fail?
function selfTestHarness() {
  heading("harness self-test — a comparison that cannot fail is not a comparison");

  const b64 = (s) => Buffer.from(s).toString("base64");
  const stub = (args) =>
    runProcess(process.execPath, [PATHS.stub, ...args], { env: childEnv(fixtures.home) });

  const baseline = () => stub(["--stdout", b64("hello\nworld\n"), "--stderr", b64("warn\n"), "--exit", "0"]);

  check("two identical runs compare equal", () => {
    assertSame("identical stubs disagreed", baseline(), baseline());
  });

  check("a single changed stdout byte is caught", () => {
    const other = stub(["--stdout", b64("hello\nworld!\n"), "--stderr", b64("warn\n"), "--exit", "0"]);
    assertDiffers("one stdout byte", baseline(), other, "stdout");
  });

  check("a single changed stderr byte is caught", () => {
    const other = stub(["--stdout", b64("hello\nworld\n"), "--stderr", b64("warm\n"), "--exit", "0"]);
    assertDiffers("one stderr byte", baseline(), other, "stderr");
  });

  check("trailing-newline-only differences are caught", () => {
    const other = stub(["--stdout", b64("hello\nworld"), "--stderr", b64("warn\n"), "--exit", "0"]);
    assertDiffers("missing trailing newline", baseline(), other, "stdout");
  });

  check("a different exit status is caught", () => {
    const other = stub(["--stdout", b64("hello\nworld\n"), "--stderr", b64("warn\n"), "--exit", "2"]);
    assertDiffers("exit 0 vs exit 2", baseline(), other, "termination");
  });

  check("death by signal is not conflated with a clean exit", () => {
    const killed = stub(["--stdout", b64("hello\nworld\n"), "--stderr", b64("warn\n"), "--signal", "SIGTERM"]);
    assert(killed.termination.kind === "signal", `expected a signal death, got ${describeTermination(killed.termination)}`);
    assert(killed.termination.status === null, "a signalled process must not report a numeric status");
    assertDiffers("exit 0 vs SIGTERM", baseline(), killed, "termination");
  });

  check("a process that never started is not conflated with one that exited", () => {
    const missing = runProcess("/nonexistent/parity-stub-xyz", [], { env: childEnv(fixtures.home) });
    assert(missing.termination.kind === "spawn-error", `expected a spawn error, got ${describeTermination(missing.termination)}`);
    assert(missing.termination.code === "ENOENT", `expected ENOENT, got ${missing.termination.code}`);
    assertDiffers("exit 0 vs spawn failure", baseline(), missing, "termination");
  });

  // Two distinct invalid-UTF-8 sequences that both decode to U+FFFD U+FFFD. A harness that
  // compares decoded strings calls these equal; a harness that compares bytes does not.
  check("distinct invalid UTF-8 that decodes identically is still caught", () => {
    const a = stub(["--stdout", Buffer.from([0xff, 0xfe]).toString("base64"), "--exit", "0"]);
    const b = stub(["--stdout", Buffer.from([0xfe, 0xff]).toString("base64"), "--exit", "0"]);
    assert(
      a.stdout.toString("utf8") === b.stdout.toString("utf8"),
      "premise broken: these byte sequences no longer decode identically, so the test proves nothing",
    );
    assertDiffers("0xFFFE vs 0xFEFF", a, b, "stdout");
  });

  check("identical invalid UTF-8 still compares equal", () => {
    const spec = Buffer.from([0xff, 0xfe]).toString("base64");
    assertSame("identical invalid UTF-8 disagreed", stub(["--stdout", spec, "--exit", "0"]), stub(["--stdout", spec, "--exit", "0"]));
  });

  check("a difference past the first megabyte is caught", () => {
    const bulk = ["--repeat", b64("x".repeat(1000)), "--times", "1500", "--exit", "0"];
    const a = stub([...bulk, "--stdout", b64("A")]);
    const b = stub([...bulk, "--stdout", b64("B")]);
    assert(a.stdout.length === 1_500_001, `expected the full stream, captured ${a.stdout.length}B`);
    assertDiffers("1.5MB then one differing byte", a, b, "stdout");
  });

  check("the child environment is constructed, not inherited", () => {
    process.env.PARITY_CANARY_MUST_NOT_LEAK = "1";
    const r = stub(["--dump-env"]);
    delete process.env.PARITY_CANARY_MUST_NOT_LEAK;
    assert(r.termination.kind === "exit" && r.termination.status === 0, "env dump did not exit cleanly");
    const seen = JSON.parse(r.stdout.toString("utf8"));
    const want = childEnv(fixtures.home);
    for (const [k, v] of Object.entries(want)) {
      assert(seen[k] === v, `child ${k}=${JSON.stringify(seen[k])}, expected ${JSON.stringify(v)}`);
    }
    assert(!("PARITY_CANARY_MUST_NOT_LEAK" in seen), "an ambient variable leaked into the child environment");
    const extra = Object.keys(seen).filter((k) => !(k in want) && !SELF_INJECTED.has(k));
    assert(extra.length === 0, `the child saw variables the contract does not declare: ${extra.join(", ")}`);
  });
}

// ---------------------------------------------------------------- phase 2: the wrappers
function selfTestWrappers() {
  heading("wrapper self-test — the injected clock has to be load-bearing");

  // An expectation computed HERE, not read off the other implementation: a wrapper that
  // drops the anchor has to fail, and it cannot fail if both sides are asked to agree with
  // each other rather than with an independently derived answer.
  const minusDays = (iso, days) => {
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d - days));
    const p = (n) => String(n).padStart(2, "0");
    return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`;
  };

  for (const anchor of ["2026-01-15", "2026-07-15"]) {
    check(`python wrapper honours --anchor ${anchor}`, () => {
      const r = pythonRun(["projects", "--since", "-3d"], { anchor });
      const want = `since -3d (=${minusDays(anchor, 3)})`;
      const got = r.stdout.toString("utf8").split("\n")[0];
      assert(got.includes(want), `expected the window label to contain ${JSON.stringify(want)}\n  got: ${got}`);
    });
  }

  check("python wrapper at anchor=today is byte-identical to running usage.py directly", () => {
    // The pair must not straddle midnight in the pinned zone, or the two runs disagree for
    // a reason that has nothing to do with the wrapper.
    for (let attempt = 0; ; attempt++) {
      const before = anchorToday();
      const direct = runProcess(python, [PATHS.usagePy, "projects", "--since", "-3d"], {
        env: childEnv(fixtures.home, fixtureEnv({ mode: "normal" })),
      });
      const wrapped = pythonRun(["projects", "--since", "-3d"], { anchor: before });
      if (anchorToday() !== before) {
        assert(attempt < 3, "the date kept changing mid-comparison");
        continue;
      }
      assertSame("the wrapper is not the same program as the entrypoint", direct, wrapped);
      return;
    }
  });

  // Gated on the capability rather than on dist/main.js existing, because the assertion can
  // only bite once `projects` actually renders a window label — before Step 5 the skeleton
  // exits 70 with no output, and a check that passes only by not looking is the vacuous
  // kind this harness exists to prevent. `--final` refuses to leave it skipped.
  if (enabled.has("render:projects") && existsSync(PATHS.distMain)) {
    check("typescript wrapper honours --anchor 2026-07-15", () => {
      const r = tsRun(["projects", "--since", "-3d"], { anchor: "2026-07-15" });
      const want = `since -3d (=${minusDays("2026-07-15", 3)})`;
      assert(r.stdout.toString("utf8").includes(want), `expected ${JSON.stringify(want)} in the TS output`);
    });
  } else {
    skip("typescript wrapper honours --anchor", "needs the render:projects capability (Step 5)");
  }
}

// ---------------------------------------------------------------- phase 3: the oracle
/**
 * Replay every stored golden through the harness's own path — constructed environment,
 * test wrapper, byte capture, comparator — and require the stored bytes back.
 *
 * capture.py --check already re-runs Python, but through capture.py's code. This asserts
 * the *harness* reaches the same bytes, which is what the differential phase will depend
 * on once there is a TypeScript side to compare against.
 */
function replayPythonOracle() {
  heading("python oracle replay — the harness path reproduces all stored goldens");
  for (const c of cases) {
    if (!c.golden) continue;
    if (c.dualRunOnly) {
      // Not a hole: stored bytes are meaningless for a case whose output embeds "today",
      // so the assertion lives in the differential phase, which runs BOTH implementations
      // at one anchor. The final invariant verifies that it actually did.
      skip(c.name, "relative dates embed today; asserted by dual-run, never against stored bytes",
        { sanctioned: true });
      continue;
    }
    check(c.name, () => {
      const actual = pythonRun(c.argv, { anchor: ANCHOR, case: c });
      const expected = {
        stdout: Buffer.from(c.golden.stdout, "utf8"),
        stderr: Buffer.from(c.golden.stderr, "utf8"),
        termination: { kind: "exit", status: c.expectExit, signal: null, code: null },
      };
      assertSame(`golden ${c.name} was not reproduced`, expected, actual);
    });
  }
}

// ---------------------------------------------------------------- phase 3b: the matrix
/**
 * The Step 3 argv matrix has no stored golden, so its `expectExit` values are transcribed
 * from a measurement. Transcription is exactly where a matrix silently rots: a wrong number
 * sits inert until the capability is enabled, and then reads as a port bug.
 *
 * So the Python side of every extra case runs now, against the transcribed contract. This
 * is a real assertion today — it caught nothing on the first run, which is the point: it
 * establishes that the 44 rows describe the CLI as it currently behaves, before any of them
 * is used to judge the port.
 */
function verifyArgvMatrix() {
  const extra = cases.filter((c) => !c.golden);
  heading(`argv matrix — ${extra.length} transcribed rows re-measured against live python`);
  for (const c of extra) {
    check(c.name, () => {
      const py = pythonRun(c.argv, { anchor: ANCHOR, case: c });
      assert(
        py.termination.kind === "exit",
        `python did not terminate normally: ${describeTermination(py.termination)}`,
      );
      assert(
        py.termination.status === c.expectExit,
        `transcribed exit ${c.expectExit}, python now exits ${py.termination.status}\n` +
          `  argv: ${JSON.stringify(c.argv)}\n` +
          `  stderr: ${JSON.stringify(py.stderr.toString("utf8").slice(0, 200))}`,
      );
      // A case that waives stderr comparison must at least be diagnosing something.
      if (c.partialStdout) {
        // This phase runs python only, so it pins the ORACLE half of ALLOWLIST 23: that
        // usage.py really does write part of its output before dying. If that ever stops
        // being true, the allowlist entry describes a behaviour that no longer exists.
        assert(py.stderr.length > 0, "case waives stderr comparison but python emits none");
        assert(py.stdout.length > 0,
          "ALLOWLIST 23 says python fails PART WAY THROUGH rendering; it now emits nothing first");
      }
      if (c.compareStderr === false) {
        assert(py.stderr.length > 0, "case waives stderr comparison but python emits none");
        assert(py.stdout.length === 0, "a failure path wrote to stdout");
      }
    });
  }
}

// ---------------------------------------------------------------- phase 4: differential
function runDifferential() {
  heading(`differential — python vs typescript (capabilities: ${[...enabled].sort().join(", ") || "none"})`);
  const tsReady = existsSync(PATHS.distMain) && existsSync(PATHS.cliWrapper);
  for (const c of cases) {
    if (!enabled.has(c.capability)) {
      skip(c.name, `capability ${c.capability} not implemented yet`);
      continue;
    }
    if (!tsReady) {
      skip(c.name, "dist/main.js does not exist yet (Step 1b)");
      continue;
    }
    executed.set(c.name, (executed.get(c.name) ?? 0) + 1);
    check(c.name, () => {
      const py = pythonRun(c.argv, { anchor: ANCHOR, case: c });
      const ts = tsRun(c.argv, { anchor: ANCHOR, case: c });
      // A matching number is not enough: the contract is that both terminate normally with
      // the required status, so a pair that both died on a signal cannot pass by agreeing.
      assert(
        py.termination.kind === "exit",
        `python did not terminate normally: ${describeTermination(py.termination)}`,
      );
      if (c.expectExit !== undefined) {
        assert(py.termination.status === c.expectExit, `python exited ${py.termination.status}, case requires ${c.expectExit}`);
      }
      if (c.rewrite) {
        // ALLOWLIST 22: rewrite the ONE sanctioned span in Python's output, then require
        // byte equality for everything else.
        const { from, to } = SANCTIONED_STDOUT_REWRITE;
        const pyText = py.stdout.toString("utf8");
        assert(pyText.includes(from), `case ${c.name} no longer contains the sanctioned span`);
        assertSame(`case ${c.name} diverged outside the sanctioned rewrite`,
          { ...py, stdout: Buffer.from(pyText.replace(from, to), "utf8") }, ts);
        return;
      }
      if (c.partialStdout) {
        // ALLOWLIST 23: the oracle crashes PART WAY THROUGH rendering, having already
        // written a header, because it prints as it goes. The port renders to a buffer and
        // writes once, so it emits nothing at all on a failure path.
        //
        // Both streams are therefore waived, which is only defensible with replacement
        // assertions sharp enough that the interesting regressions still fail here: the
        // port silently succeeding, the port half-writing a table, or either side failing
        // without saying why.
        assert(py.stdout.length > 0,
          "python no longer emits partial output before failing; ALLOWLIST 23 needs revisiting");
        assert(ts.stdout.length === 0,
          `the port must not half-write a table before failing; got ${ts.stdout.length}B`);
        for (const [who, r] of [["python", py], ["typescript", ts]]) {
          assert(r.stderr.length > 0, `${who} produced no stderr, but this case must diagnose`);
        }
        assert(ts.termination.kind === "exit" && ts.termination.status === c.expectExit,
          `typescript ${describeTermination(ts.termination)}, case requires exit ${c.expectExit}`);
        return;
      }
      if (c.compareStderr === false) {
        // ALLOWLIST 19: an uncaught CPython traceback, whose bytes name CPython source
        // files and line numbers. Waiving the comparison is only defensible alongside a
        // replacement assertion, or "the port printed nothing" would silently pass.
        for (const [who, r] of [["python", py], ["typescript", ts]]) {
          assert(r.stderr.length > 0, `${who} produced no stderr, but this case must diagnose`);
          assert(r.stdout.length === 0, `${who} wrote to stdout on a failure path`);
        }
        // "nonempty stderr" alone would accept a module-load failure or an unrelated stack
        // trace (code review R1). The port's replacement diagnostic is part of the contract,
        // so pin its SHAPE: exactly one newline-terminated line, matching the case's pattern.
        const tsErr = ts.stderr.toString("utf8");
        assert(tsErr.endsWith("\n"), `typescript stderr is not newline-terminated: ${JSON.stringify(tsErr)}`);
        assert(
          tsErr.split("\n").length === 2,
          `the port must emit ONE diagnostic line, not a traceback: ${JSON.stringify(tsErr)}`,
        );
        if (c.tsStderr) {
          assert(c.tsStderr.test(tsErr), `typescript stderr ${JSON.stringify(tsErr)} does not match ${c.tsStderr}`);
        }
        assertSame(`case ${c.name} diverged`, { ...py, stderr: ts.stderr }, ts);
        return;
      }
      assertSame(`case ${c.name} diverged`, py, ts);
    });
  }
}

// ---------------------------------------------------------------- phase 5: no escape hatch
function finalInvariant() {
  heading("final invariant — the capability gate must not be hiding anything");
  check("every capability is enabled", () => {
    const missing = ALL_CAPABILITIES.filter((c) => !enabled.has(c));
    assert(missing.length === 0, `not enabled: ${missing.join(", ")}`);
  });
  check("every skip is phase-appropriate, not a coverage hole", () => {
    const holes = skipped.filter((s) => !s.sanctioned);
    assert(
      holes.length === 0,
      `${holes.length} case(s) skipped with nothing else asserting them: ` +
        holes.map((s) => `${s.name} [${s.section}]`).join(", "),
    );
  });
  check("every sanctioned skip really was asserted by the differential phase", () => {
    // The label is a claim; this is the proof. Without it, marking a skip `sanctioned`
    // would be a way to delete coverage and still pass `--final`.
    const unproven = skipped.filter((s) => (executed.get(s.name) ?? 0) !== 1);
    assert(
      unproven.length === 0,
      `skipped but never dual-run: ${unproven.map((s) => `${s.name} ran ${executed.get(s.name) ?? 0}×`).join(", ")}`,
    );
  });
  check("every declared case ran exactly once in the differential phase", () => {
    const wrong = cases
      .map((c) => [c.name, executed.get(c.name) ?? 0])
      .filter(([, n]) => n !== 1)
      .map(([name, n]) => `${name} ran ${n}×`);
    assert(wrong.length === 0, wrong.join(", "));
  });
}

// ---------------------------------------------------------------- subject invocation
function fixtureEnv(c) {
  const extra = {
    CCUSAGE_CMD: `${python} ${PATHS.fakeCcusage}`,
    FAKE_MODE: c?.mode ?? "normal",
    USAGE_CONFIG: PATHS.fixtureConfig,
  };
  if (c?.codexFixture) extra.CODEX_HOME = fixtures.codexHome;
  return { ...extra, ...(c?.extraEnv ?? {}) };
}

function pythonRun(argv, { anchor, case: c } = {}) {
  return runProcess(python, [PATHS.usageWrapper, "--anchor", anchor, "--", ...argv], {
    env: childEnv(fixtures.home, fixtureEnv(c)),
  });
}

function tsRun(argv, { anchor, case: c } = {}) {
  return runProcess(process.execPath, [PATHS.cliWrapper, "--anchor", anchor, "--", ...argv], {
    env: childEnv(fixtures.home, fixtureEnv(c)),
  });
}

// ---------------------------------------------------------------- exit
function report() {
  process.stdout.write(`\n${bold("summary")}  ${tally.pass} passed, ${tally.fail} failed, ${tally.skip} skipped\n`);
  for (const f of failures) {
    process.stdout.write(`\n${bold(`FAIL ${f.section} / ${f.name}`)}\n  ${f.message.replace(/\n/g, "\n  ")}\n`);
  }
  if (!FINAL && tally.skip > 0) {
    const holes = skipped.filter((s) => !s.sanctioned).length;
    process.stdout.write(
      `\nnote: ${tally.skip} case(s) skipped ` +
        `(${holes} by the capability gate, ${tally.skip - holes} asserted by dual-run instead); ` +
        `\`--final\` checks both.\n`,
    );
  }
  process.exit(tally.fail > 0 ? 1 : 0);
}
