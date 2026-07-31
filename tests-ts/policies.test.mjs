/**
 * Negative contract tests for every comparison policy.
 *
 * A policy WAIVES a byte comparison. What makes that defensible is not the waiver but the
 * assertions that replace it — and "the policy executes its replacement assertions" is not
 * something structural validation can establish. A handler that quietly dropped a predicate,
 * or that returned success unconditionally, would register perfectly well and pass every
 * check in `assertRegistry`. That is the same "code exists, therefore it ran" evidence the
 * `dual_run_only` flag used to offer.
 *
 * So each policy is fed synthetic run pairs that violate exactly ONE predicate, and is
 * required to reject every one. Synthetic rather than recorded, because a recorded pair
 * varies in several ways at once and could not isolate which predicate did the rejecting —
 * a test that passes for the wrong reason is how a dropped predicate survives.
 *
 * Each case also carries a POSITIVE control: the same pair with the violation removed must
 * be accepted. Without it, a policy that rejected everything unconditionally would score a
 * perfect result here while asserting nothing at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { POLICIES, NON_EXACT_POLICIES, SANCTIONED_STDOUT_REWRITE } from "./harness/policies.mjs";

const exit = (status) => ({ kind: "exit", status, signal: null, code: null });
const run = (stdout, stderr, status = 1) => ({
  stdout: Buffer.from(stdout, "utf8"),
  stderr: Buffer.from(stderr, "utf8"),
  termination: exit(status),
});

/** Deep-clone a run pair so a mutation cannot leak into the next case. */
const pair = (py, ts) => ({ py: { ...py }, ts: { ...ts } });

function rejects(policy, py, ts, c, why) {
  assert.throws(
    () => policy.differential(py, ts, c),
    (e) => e instanceof Error,
    `${policy.id} accepted a pair it must reject: ${why}`,
  );
}

function accepts(policy, py, ts, c, why) {
  policy.differential(py, ts, c); // throws on failure
  assert.ok(true, why);
}

describe("every non-exact policy is registered AND enforces its predicates", () => {
  test("the set of non-exact policies is not empty", () => {
    // If policies were ever collapsed into one, this file would silently test nothing.
    assert.ok(NON_EXACT_POLICIES.length >= 3, `only ${NON_EXACT_POLICIES.length} non-exact policies`);
  });

  test("every policy declares a waiverId, and only `exact` declares null", () => {
    for (const [id, p] of Object.entries(POLICIES)) {
      if (id === "exact") assert.equal(p.waiverId, null, "exact must consume no waiver");
      else assert.ok(typeof p.waiverId === "string" && p.waiverId, `${id} declares no waiverId`);
    }
  });
});

describe("ts-diag: a waived stderr must still be the port's one-line diagnostic", () => {
  const policy = POLICIES["ts-diag:invalid-date"];
  const c = { name: "synthetic", argv: ["hourly"], expectExit: 1 };
  const goodTsErr = "invalid --date: 'bogus'\n";
  const pyErr = "Traceback (most recent call last):\n  File \"/usr/lib/python3.13/x.py\", line 1\nValueError\n";

  test("positive control: a well-formed pair is accepted", () => {
    const { py, ts } = pair(run("", pyErr), run("", goodTsErr));
    accepts(policy, py, ts, c, "the control pair must pass or every rejection below is meaningless");
  });

  test("rejects an empty TS diagnostic", () => {
    const { py, ts } = pair(run("", pyErr), run("", ""));
    rejects(policy, py, ts, c, "empty stderr");
  });

  test("rejects an empty PYTHON diagnostic", () => {
    // The oracle half of the waiver: if python stops emitting a traceback, ALLOWLIST 19
    // describes a behaviour that no longer exists.
    const { py, ts } = pair(run("", ""), run("", goodTsErr));
    rejects(policy, py, ts, c, "python emitted nothing");
  });

  test("rejects a multi-line TS diagnostic (a traceback smuggled through)", () => {
    const { py, ts } = pair(run("", pyErr), run("", "invalid --date: 'x'\n  at foo (bar.js:1)\n"));
    rejects(policy, py, ts, c, "two lines");
  });

  test("rejects a diagnostic that is not newline-terminated", () => {
    // Deliberately NOT the obvious `"invalid --date: 'x'"` — that has no newline at all, so
    // the one-line check rejects it first and this test would pass while the termination
    // check was deleted. Measured: dropping `endsWith("\n")` left that version green.
    //
    // This input splits into exactly two parts, so it satisfies the one-line check, and the
    // pattern matches — only the missing terminator is wrong. A diagnostic that runs into
    // the next write without ending its line is a real shape the port must not emit.
    const { py, ts } = pair(run("", pyErr), run("", "invalid --date: 'x'\ntrailing"));
    rejects(policy, py, ts, c, "no trailing newline");
  });

  test("rejects a one-line diagnostic that does not match the pattern", () => {
    // "non-empty stderr" alone would accept a module-load failure or an unrelated stack.
    const { py, ts } = pair(run("", pyErr), run("", "Error: cannot find module 'foo'\n"));
    rejects(policy, py, ts, c, "wrong diagnostic");
  });

  test("rejects stdout on a failure path, from either side", () => {
    rejects(policy, ...Object.values(pair(run("partial table\n", pyErr), run("", goodTsErr))), c, "python stdout");
    rejects(policy, ...Object.values(pair(run("", pyErr), run("half a table\n", goodTsErr))), c, "ts stdout");
  });

  test("rejects a disagreeing exit status even though stderr is waived", () => {
    // Waiving stderr must cost exactly stderr. The termination is still compared.
    const { py, ts } = pair(run("", pyErr, 1), run("", goodTsErr, 2));
    rejects(policy, py, ts, c, "exit 1 vs 2");
  });

  test("rejects when python's exit disagrees with the transcribed expectExit", () => {
    const { py, ts } = pair(run("", pyErr, 3), run("", goodTsErr, 3));
    rejects(policy, py, ts, c, "python exited 3, case declares 1");
  });

  test("the two ts-diag policies do not accept each other's diagnostics", () => {
    // Otherwise one pattern could be deleted and the other would cover for it.
    const other = POLICIES["ts-diag:blocks-array-attr"];
    const { py, ts } = pair(run("", pyErr), run("", goodTsErr));
    rejects(other, py, ts, c, "invalid-date text under the blocks-array policy");
  });
});

describe("partial-python-stdout: both streams waived, so the SHAPE carries the contract", () => {
  const policy = POLICIES["partial-python-stdout"];
  const c = { name: "synthetic", argv: ["blocks"], expectExit: 1 };
  const good = () => pair(run("Active blocks header\n", "TypeError: ...\n", 1), run("", "cost is not numeric\n", 1));

  test("positive control: python partial + port silent is accepted", () => {
    const { py, ts } = good();
    accepts(policy, py, ts, c, "control");
  });

  test("rejects python emitting nothing before dying", () => {
    // ALLOWLIST 23's premise. If it stops holding, the entry needs revisiting rather than
    // the case quietly continuing to pass.
    const { py, ts } = pair(run("", "TypeError: ...\n", 1), run("", "cost is not numeric\n", 1));
    rejects(policy, py, ts, c, "no partial output");
  });

  test("rejects the port half-writing a table", () => {
    const { py, ts } = pair(run("header\n", "TypeError\n", 1), run("header\n", "cost is not numeric\n", 1));
    rejects(policy, py, ts, c, "port wrote to stdout");
  });

  test("rejects either side failing without diagnosing", () => {
    rejects(policy, ...Object.values(pair(run("h\n", "", 1), run("", "msg\n", 1))), c, "python silent");
    rejects(policy, ...Object.values(pair(run("h\n", "err\n", 1), run("", "", 1))), c, "port silent");
  });

  test("rejects the port SUCCEEDING where the oracle failed", () => {
    // The regression this policy exists for: an earlier port returned 0 for a non-numeric
    // cost, rendering $0.00 and exiting 0 — a loud failure turned into a plausible wrong
    // number, which is strictly worse than either behaviour.
    const { py, ts } = pair(run("header\n", "TypeError\n", 1), run("", "warning\n", 0));
    rejects(policy, py, ts, c, "port exited 0");
  });

  test("guard: this policy really does waive the byte comparison", () => {
    // Otherwise the rejections above might be byte differences, not shape violations, and
    // the four replacement assertions would be untested.
    const { py, ts } = good();
    assert.notEqual(py.stdout.toString(), ts.stdout.toString(), "premise: the streams differ");
    assert.notEqual(py.stderr.toString(), ts.stderr.toString(), "premise: the streams differ");
    accepts(policy, py, ts, c, "differing bytes are accepted; only the shape is asserted");
  });
});

describe("help-config-path: one sanctioned span, everything else byte-frozen", () => {
  const policy = POLICIES["help-config-path"];
  const c = { name: "synthetic", argv: ["--help"], expectExit: 0 };
  const { from, to } = SANCTIONED_STDOUT_REWRITE;

  test("positive control: the rewritten span is accepted", () => {
    const { py, ts } = pair(run(`head ${from} tail`, "", 0), run(`head ${to} tail`, "", 0));
    accepts(policy, py, ts, c, "control");
  });

  test("rejects output that no longer contains the sanctioned span", () => {
    // The span vanishing means the waiver is being applied to text it was never granted for.
    const { py, ts } = pair(run("head tail", "", 0), run("head tail", "", 0));
    rejects(policy, py, ts, c, "span absent");
  });

  test("rejects a difference OUTSIDE the sanctioned span", () => {
    // The whole reason this is a rewrite rather than a blanket stdout waiver: the other
    // ~3.2 KB of help text must still be frozen.
    const { py, ts } = pair(run(`head ${from} tail`, "", 0), run(`HEAD ${to} tail`, "", 0));
    rejects(policy, py, ts, c, "text outside the span changed");
  });

  test("rejects a duplicated span, where the rewrite would be ambiguous", () => {
    // The TS side deliberately carries the rewritten span once and the PYTHON span once.
    //
    // The obvious input — both spans rewritten on the TS side — does not test this check at
    // all: `String.replace` rewrites only the first occurrence, so python becomes
    // "<to> mid <from>", that differs from "<to> mid <to>", and the ordinary byte comparison
    // rejects it. Measured: deleting the duplicate check left that version green.
    //
    // With this input the rewrite produces EXACTLY the TS bytes, so byte equality holds and
    // the duplicate check is the only thing objecting. What it is objecting to is real: a
    // port whose help text still contains Python's config sentence in a second position is
    // shipping documentation that points users at a file it never reads, which is the whole
    // reason ALLOWLIST 22 exists rather than being a `prog` swap.
    const { py, ts } = pair(run(`${from} mid ${from}`, "", 0), run(`${to} mid ${from}`, "", 0));
    rejects(policy, py, ts, c, "two occurrences");
  });

  test("rejects a stderr difference even though stdout is rewritten", () => {
    const { py, ts } = pair(run(`x ${from} y`, "", 0), run(`x ${to} y`, "unexpected\n", 0));
    rejects(policy, py, ts, c, "stderr diverged");
  });
});

describe("exact: the default policy compares everything", () => {
  const policy = POLICIES.exact;
  const c = { name: "synthetic", argv: ["projects"], expectExit: 0 };

  test("accepts identical runs and rejects each stream independently", () => {
    accepts(policy, run("out", "err", 0), run("out", "err", 0), c, "control");
    rejects(policy, run("out", "err", 0), run("OUT", "err", 0), c, "stdout");
    rejects(policy, run("out", "err", 0), run("out", "ERR", 0), c, "stderr");
    rejects(policy, run("out", "err", 0), run("out", "err", 1), c, "exit");
  });

  test("compares BYTES, not decoded strings", () => {
    // Two different byte sequences can decode to the same JS string (invalid UTF-8 becomes
    // U+FFFD), so a string comparison would report parity for output that is not identical.
    const a = { stdout: Buffer.from([0xff, 0xfe]), stderr: Buffer.alloc(0), termination: exit(0) };
    const b = { stdout: Buffer.from([0xfe, 0xff]), stderr: Buffer.alloc(0), termination: exit(0) };
    assert.equal(a.stdout.toString("utf8"), b.stdout.toString("utf8"), "premise: these decode alike");
    rejects(policy, a, b, c, "distinct invalid UTF-8");
  });
});
