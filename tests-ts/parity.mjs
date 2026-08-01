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
import {
  assertLegacyFieldsAbsent,
  assertRegistry,
  assertWaiversArePublished,
  loadCases,
} from "./harness/cases.mjs";
import { resolvePolicy } from "./harness/policies.mjs";
import { anchorToday, assertEnvironmentContract, buildFixtures, childEnv, PATHS } from "./harness/env.mjs";
import { describeTermination, runProcess } from "./harness/run.mjs";

// ---------------------------------------------------------------- reporting
const tally = { pass: 0, fail: 0, skip: 0 };
const failures = [];
const skipped = [];
let section = "";

/**
 * The three phases that execute CASES, named so the trace can say which one it is looking at
 * instead of inferring it from call order.
 *
 * The wrapper self-tests also spawn subjects, but pass `phase: null` — they carry no case and
 * exist to prove the injected clock is load-bearing, so folding them into the case trace
 * would put case-less rows in a structure whose whole purpose is per-case accounting.
 */
const PHASE = { REPLAY: "stored-replay", ARGV: "argv-remeasurement", DIFF: "differential" };

/** Every traced subject invocation: {phase, impl, caseName, anchor}. */
const trace = [];

/**
 * The spawn call, behind a swappable binding so the routing spy can observe what
 * `runProcess` actually RECEIVED.
 *
 * Reading the argv array `spawnSubject` built would not be independent evidence: the trace
 * and the spawn would be two readings of one variable, and a regression that records one
 * array while executing another satisfies both. The indirection puts the observation at the
 * boundary rather than inside the thing being observed.
 *
 * Declared HERE, with the other module state, rather than beside `spawnSubject` further
 * down. The phase functions run from the module body above that point, so a `let` next to
 * its only user is still in the temporal dead zone when the wrapper self-tests fire — which
 * failed every case in the suite with "Cannot access 'spawnImpl' before initialization"
 * rather than anything resembling a parity difference.
 */
let spawnImpl = runProcess;

/** How many times (phase, impl, caseName) actually executed. */
function tally3(phase, impl, caseName) {
  return trace.filter((t) => t.phase === phase && t.impl === impl && t.caseName === caseName).length;
}

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
 * A skipped case. Every skip is a coverage hole, full stop.
 *
 * There used to be a `sanctioned` flag here marking a skip as phase-appropriate rather than
 * a hole, plus a `--final` check that re-proved the label. Deleting `dual_run_only` removed
 * the only producer, and no call site has passed it since — so the filter that read it was
 * the identity function, and the check that verified it always ran on an empty array.
 * Deleting the whole mechanism rather than keeping it "in case": a branch no test can kill
 * implies a hazard that does not exist, and this one also kept a retired concept alive in
 * the summary line (code review R2).
 */
function skip(name, why) {
  tally.skip++;
  skipped.push({ section, name, why });
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

// Inside `check`, so a registry that cannot even be READ is reported as a failed check
// rather than as a raw ENOENT stack from a missing golden file (code review R2).
let cases = [];
check("the case registry loads", () => {
  cases = loadCases();
});
check("every case carries a known capability tag, and every tag names a real case", () => {
  assertRegistry(cases);
});

check("every waived comparison is covered by its allowlist entry's published SCOPE", () => {
  assertWaiversArePublished(cases);
});

check("every pre-T-005 comparison flag is fully retired, in the data and in the document", () => {
  assertLegacyFieldsAbsent();
});

const fixtures = buildFixtures(python);

/**
 * TWO anchors, because stored replay and the live differential are different questions.
 *
 * A stored golden is only reproducible against the wall clock it was captured under, so it
 * replays at its own `captureAnchor`. The differential asks whether the two implementations
 * agree *right now*, so it runs at a live anchor — and running it at the capture anchor
 * instead would still pass, because both sides would receive the same wrong value and agree
 * with each other perfectly. That is why the routing needs its own evidence (`assertAnchorRouting`)
 * rather than resting on `--final` being green.
 */
const LIVE_ANCHOR = anchorToday();
const CAPTURE_ANCHORS = new Set(cases.filter((c) => c.storedGolden).map((c) => c.captureAnchor));
process.stdout.write(
  `  using Python ${python}\n  live anchor ${LIVE_ANCHOR}\n` +
    `  capture anchor(s) ${[...CAPTURE_ANCHORS].sort().join(", ")}\n  fixture home ${fixtures.home}\n`,
);

check("the capture and live anchors are distinct, so the phases are distinguishable", () => {
  // Today's date and a fixed past capture anchor differ by calendar accident. An accident is
  // not an assertion: on the one day they coincide, every routing check below would still
  // pass while proving nothing. Fail loudly instead of silently losing the discriminator.
  const collide = [...CAPTURE_ANCHORS].filter((a) => a === LIVE_ANCHOR);
  assert(
    collide.length === 0,
    `captureAnchor ${collide.join(", ")} equals today (${LIVE_ANCHOR}); the anchor-routing ` +
      `assertions cannot tell the phases apart until tomorrow`,
  );
});

try {
  selfTestHarness();
  selfTestWrappers();
  replayPythonOracle();
  verifyArgvMatrix();
  runDifferential();
  assertAnchorRouting();
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
    if (!c.storedGolden) continue;
    // No dual_run_only branch any more. The two relative-date cases used to be skipped here
    // because their output embeds "today" and stored bytes were therefore meaningless; they
    // are now captured at a FIXED captureAnchor and replayed at that same anchor, which
    // makes them ordinary comparable goldens. Skipping them and claiming the differential
    // covered it was the weaker arrangement: a flag proves code exists, not that it ran.
    check(c.name, () => {
      const actual = pythonRun(c.argv, { anchor: c.captureAnchor, case: c, phase: PHASE.REPLAY });
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
  const extra = cases.filter((c) => !c.storedGolden);
  heading(`argv matrix — ${extra.length} transcribed rows re-measured against live python`);
  for (const c of extra) {
    check(c.name, () => {
      const py = pythonRun(c.argv, { anchor: LIVE_ANCHOR, case: c, phase: PHASE.ARGV });
      // The policy owns the python-side predicates: a case that waives a stream in the
      // differential must already be showing, here, that python's half of the waiver is
      // still true — that it really does emit a traceback, or really does write a partial
      // table before dying. If that stops being so, the allowlist entry describes a
      // behaviour that no longer exists and the waiver is unearned.
      //
      // No exit-status assertion beside this call. Every policy's `remeasure` opens with
      // `pythonTerminatedAsTranscribed`, which makes the identical comparison and throws
      // first, so the copy here was unreachable for every case in the registry — deleting it
      // failed nothing (code review R4). Restating a predicate next to the call that already
      // enforces it is how two places come to disagree about what a case requires, which is
      // the duplication this ticket exists to remove.
      resolvePolicy(c.comparisonPolicy).remeasure(py, c);
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
    check(c.name, () => {
      const py = pythonRun(c.argv, { anchor: LIVE_ANCHOR, case: c, phase: PHASE.DIFF });
      const ts = tsRun(c.argv, { anchor: LIVE_ANCHOR, case: c, phase: PHASE.DIFF });
      // The whole comparison is the policy's, including the shared "python terminated
      // normally with the transcribed status" preamble. Keeping a copy of that preamble
      // here would mean two places could disagree about what a case requires, which is the
      // duplication this ticket exists to remove.
      //
      // The policy throws on any violation and `check` reports it like any other failure —
      // including `resolvePolicy` itself, if the name is unknown. An earlier comment here
      // claimed it "cannot throw, because assertRegistry already rejected unknown policy
      // names before a single subject was spawned". That was false: `check` catches and
      // continues, so a bad policy name fails the registry check and then the run carries on
      // and spawns every subject anyway (code review R2, measured). The run still fails, so
      // this is a documentation fix rather than a hole — but a stated guarantee the code does
      // not provide is worse than no comment, because the next reader may drop the wrapper.
      resolvePolicy(c.comparisonPolicy).differential(py, ts, c);
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
  check("nothing was skipped", () => {
    assert(
      skipped.length === 0,
      `${skipped.length} case(s) skipped with nothing else asserting them: ` +
        skipped.map((s) => `${s.name} [${s.section}]`).join(", "),
    );
  });

  /**
   * Execution counts, keyed by (phase, implementation, case).
   *
   * A single global "each case ran exactly once" tally cannot express this. A stored case
   * necessarily runs THREE times — once replaying its golden, then once per implementation
   * in the differential — so a global count of 1 was only ever right because the replay
   * phase was not being counted. Collapsing the phases would hide a duplicated replay and a
   * missing TypeScript run behind the same number.
   */
  check("every case executed exactly the phases it is supposed to, and no others", () => {
    const wrong = [];
    for (const c of cases) {
      const want = c.storedGolden
        ? { [PHASE.REPLAY]: { python: 1, typescript: 0 }, [PHASE.ARGV]: { python: 0, typescript: 0 }, [PHASE.DIFF]: { python: 1, typescript: 1 } }
        : { [PHASE.REPLAY]: { python: 0, typescript: 0 }, [PHASE.ARGV]: { python: 1, typescript: 0 }, [PHASE.DIFF]: { python: 1, typescript: 1 } };
      for (const [phase, impls] of Object.entries(want)) {
        for (const [impl, n] of Object.entries(impls)) {
          const got = tally3(phase, impl, c.name);
          if (got !== n) wrong.push(`${c.name}: ${phase}/${impl} ran ${got}×, expected ${n}×`);
        }
      }
    }
    assert(wrong.length === 0, wrong.join("\n  "));
  });

  check("no traced invocation belongs to a case that is not in the registry", () => {
    const known = new Set(cases.map((c) => c.name));
    const strays = trace.filter((t) => t.caseName !== null && !known.has(t.caseName));
    assert(strays.length === 0, `traced runs for unknown cases: ${strays.map((t) => t.caseName).join(", ")}`);
  });
}

/**
 * The anchor routing, proved from what was SPAWNED rather than from what was intended.
 *
 * Every entry's anchor was parsed back out of the argv handed to `runProcess`, so a mutation
 * that records one value and passes another cannot satisfy this. That mutation is the whole
 * reason the check exists: `--final` stays green through it, because Python and TypeScript
 * would both receive the same wrong anchor and agree with each other perfectly.
 */
function assertAnchorRouting() {
  heading("anchor routing — stored replay and the differential must not share a clock");
  const byName = new Map(cases.map((c) => [c.name, c]));

  check("stored replay used each case's captureAnchor", () => {
    const wrong = trace
      .filter((t) => t.phase === PHASE.REPLAY)
      .filter((t) => t.anchor !== byName.get(t.caseName).captureAnchor)
      .map((t) => `${t.caseName} replayed at ${t.anchor}, captured at ${byName.get(t.caseName).captureAnchor}`);
    assert(wrong.length === 0, wrong.join("\n  "));
  });

  check("the differential and argv phases used the live anchor", () => {
    const wrong = trace
      .filter((t) => t.phase === PHASE.DIFF || t.phase === PHASE.ARGV)
      .filter((t) => t.anchor !== LIVE_ANCHOR)
      .map((t) => `${t.caseName} [${t.phase}/${t.impl}] ran at ${t.anchor}, live anchor is ${LIVE_ANCHOR}`);
    assert(wrong.length === 0, wrong.join("\n  "));
  });

  check("the two phases really did use different clocks", () => {
    // Guard against the whole check passing vacuously: if no stored case replayed, the
    // first assertion above is trivially true and the routing is unverified.
    const replayed = trace.filter((t) => t.phase === PHASE.REPLAY);
    assert(replayed.length > 0, "no stored replay was traced; the routing assertions are vacuous");
    const anchors = new Set(replayed.map((t) => t.anchor));
    assert(!anchors.has(LIVE_ANCHOR), "stored replay ran at the live anchor; the split is not real");
  });

  check("the per-case anchor is READ per case, not a constant wearing a field name", () => {
    // cases.json defends `captureAnchor` being per-case at length. That argument was
    // unfalsifiable while all 45 stored cases shared one value: code review R2 replaced the
    // per-case read with the literal "2026-01-03" and all 265 checks still passed, so nothing
    // distinguished the design from a constant.
    //
    // The two relative-date cases are now captured a day later than the rest. They are the
    // only cases whose OUTPUT embeds the anchor, so they are the only ones that can tell —
    // which is exactly why they carry the distinct value rather than an arbitrary case doing
    // so for symmetry.
    const anchors = new Set(cases.filter((c) => c.storedGolden).map((c) => c.captureAnchor));
    assert(
      anchors.size >= 2,
      `all stored cases share captureAnchor ${[...anchors][0]}; substituting a constant for the ` +
        `per-case read would pass every check, so the field is undiscriminated`,
    );
    const replayAnchors = new Set(trace.filter((t) => t.phase === PHASE.REPLAY).map((t) => t.anchor));
    assert(
      replayAnchors.size >= 2,
      `replay used a single anchor (${[...replayAnchors].join(", ")}) though the registry declares ` +
        `${anchors.size}; the per-case value is not reaching the spawn`,
    );
  });

  check("the traced anchor is what runProcess RECEIVED, not what the caller intended", () => {
    // A real spy, wrapping the spawn boundary. An earlier version of this check read the
    // argv array off the trace entry — but the trace and the spawn were reading the SAME
    // local array, so a regression that built one array to record and a different one to
    // execute would satisfy it. Two readings of one variable are not two witnesses.
    //
    // Probed across EVERY (implementation, phase) pair, and each pair twice — once with no
    // case and once with a REAL registry case.
    //
    // Two rounds of review sharpened this. R2: a single probe at python/differential missed a
    // split confined to the replay phase or the TypeScript path. R3: six probes still all
    // passed `case: null`, so a split conditioned on `c !== null` took the unaffected branch
    // in every one of them — and since both implementations would receive the same wrong
    // per-case anchor, every byte comparison would stay green too.
    //
    // The structural fix is in `spawnTraced`, which records from the argv it forwards; these
    // probes are the check that the boundary is the only path. The real-case probe uses an
    // anchor distinct from that case's own captureAnchor, so a mutation substituting
    // `c.captureAnchor` for the requested value is visible rather than coincidentally equal.
    const realCase = cases.find((c) => c.storedGolden) ?? null;
    assert(realCase !== null, "no stored case available to probe with; the case-bearing path is untested");
    const probes = [];
    let n = 0;
    for (const [impl, run] of [["python", pythonRun], ["typescript", tsRun]]) {
      for (const phase of [PHASE.REPLAY, PHASE.ARGV, PHASE.DIFF]) {
        for (const c of [null, realCase]) {
          probes.push({ impl, phase, run, case: c, anchor: `2026-03-${String(++n).padStart(2, "0")}` });
        }
      }
    }
    // Distinct anchors per probe, so a wrapper that returned a cached or shared argv would
    // show up as an equality that holds for the wrong reason. Also distinct from the real
    // case's captureAnchor, for the reason above.
    assert(new Set(probes.map((p) => p.anchor)).size === probes.length, "probe anchors must be distinct");
    assert(
      !probes.some((p) => p.anchor === realCase.captureAnchor),
      `a probe anchor collides with ${realCase.name}'s captureAnchor; a substitution would read as agreement`,
    );

    for (const { impl, phase, run, anchor, case: probeCase } of probes) {
      const before = trace.length;
      const seen = [];
      const real = spawnImpl;
      spawnImpl = (file, args, opts) => {
        // Snapshot, not a reference. Holding the live array would let a later mutation of it
        // move BOTH observations together, which is the same shared-source defect this spy
        // was rewritten to eliminate — one level further in.
        seen.push([...args]);
        return real(file, args, opts);
      };
      try {
        run(["projects"], { anchor, case: probeCase, phase });
      } finally {
        spawnImpl = real;
      }
      const where = `${impl}/${phase}/${probeCase ? probeCase.name : "no-case"}`;
      assert(seen.length === 1, `${where}: the probe spawned ${seen.length} processes, expected 1`);
      assert(trace.length === before + 1, `${where}: the probe did not produce exactly one trace entry`);
      const entry = trace[trace.length - 1];
      assert(entry.impl === impl, `${where}: traced impl ${entry.impl}`);
      assert(entry.phase === phase, `${where}: traced phase ${entry.phase}`);
      assert(
        entry.caseName === (probeCase ? probeCase.name : null),
        `${where}: traced caseName ${entry.caseName}`,
      );
      // KEPT, against a code-review R4 finding that called it two derivations of one binding
      // and therefore deletable. Measured instead of argued, and the measurement disagrees:
      // a divergence inside `spawnTraced` confined to the ARGV phase — which has no stored
      // goldens, so no byte comparison can see it, and whose routing check reads the trace
      // and is therefore satisfied — fails ONLY this assertion. With it: 1 failure. Without
      // it: 266 passed, 0 failed.
      //
      // The reviewer was right that `spawnTraced` reads one binding twice; what that misses is
      // that those two lines are now the entire trust boundary, so an assertion watching
      // exactly them is the last thing standing between a record/execute split and a green run.
      assert(
        anchorFromArgv(seen[0]) === entry.anchor,
        `${where}: runProcess received --anchor ${anchorFromArgv(seen[0])} but the trace recorded ${entry.anchor}`,
      );
      assert(entry.anchor === anchor, `${where}: traced ${entry.anchor}, requested ${anchor}`);
      trace.pop(); // a probe is not a case execution and must not pollute the tallies
    }
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

/**
 * The anchor a spawned command was ACTUALLY given, read back out of its argv.
 *
 * Both wrappers take `--anchor <value> -- <argv>`, so this is a parse, not a guess. Reading
 * the caller's `anchor` parameter instead would record intent: a mutation that traces
 * `LIVE_ANCHOR` while passing `captureAnchor` to `runProcess` satisfies an intent-based
 * assertion perfectly, and that is precisely the mutation the routing check must catch.
 */
function anchorFromArgv(args) {
  const i = args.indexOf("--anchor");
  if (i === -1 || i + 1 >= args.length) throw new Error(`no --anchor in spawned argv: ${JSON.stringify(args)}`);
  return args[i + 1];
}

/**
 * One traced subject invocation. `phase` is explicit rather than inferred, because the two
 * wrapper self-tests also call these functions and must NOT enter the case trace — they pass
 * no case and exist to prove the injected clock is load-bearing at all.
 */
/**
 * The ONE place a subject process is created, and the only place the trace is written.
 *
 * The recording happens here, from the same `args` binding that is forwarded to `spawnImpl`
 * on the next line — not in the caller that built the array. That is what makes the trace
 * structurally truthful for all 265 real invocations rather than for a handful of probes:
 * a caller that assembles a different array to execute must hand THAT array to this function,
 * so the trace follows it and the ordinary routing assertions catch the divergence.
 *
 * Code review R3 found why this matters. The previous arrangement recorded in `spawnSubject`
 * beside the spawn, and proved the two agreed with synthetic probes — every one of which
 * passed `case: null`. A record-versus-execute split conditioned on a real case therefore
 * escaped all six probes: both implementations would receive the same wrong per-case anchor,
 * every byte comparison would stay green, and the probes would take the unaffected branch.
 * Watching the door only when nobody is carrying anything is not watching the door.
 */
function spawnTraced(file, args, opts, { impl, phase, caseName }) {
  if (phase !== null) {
    trace.push({ phase, impl, caseName, anchor: anchorFromArgv(args) });
  }
  return spawnImpl(file, args, opts);
}

function spawnSubject({ impl, phase, argv, anchor, case: c }) {
  const file = impl === "python" ? python : process.execPath;
  const wrapper = impl === "python" ? PATHS.usageWrapper : PATHS.cliWrapper;
  const args = [wrapper, "--anchor", anchor, "--", ...argv];
  return spawnTraced(file, args, { env: childEnv(fixtures.home, fixtureEnv(c)) },
                     { impl, phase, caseName: c?.name ?? null });
}

function pythonRun(argv, { anchor, case: c, phase = null } = {}) {
  return spawnSubject({ impl: "python", phase, argv, anchor, case: c });
}

function tsRun(argv, { anchor, case: c, phase = null } = {}) {
  return spawnSubject({ impl: "typescript", phase, argv, anchor, case: c });
}

// ---------------------------------------------------------------- exit
function report() {
  process.stdout.write(`\n${bold("summary")}  ${tally.pass} passed, ${tally.fail} failed, ${tally.skip} skipped\n`);
  for (const f of failures) {
    process.stdout.write(`\n${bold(`FAIL ${f.section} / ${f.name}`)}\n  ${f.message.replace(/\n/g, "\n  ")}\n`);
  }
  if (!FINAL && tally.skip > 0) {
    process.stdout.write(
      `\nnote: ${tally.skip} case(s) skipped by the capability gate; \`--final\` requires none.\n`,
    );
  }
  process.exit(tally.fail > 0 ? 1 : 0);
}
