/**
 * Comparison policies — how a case's two runs are allowed to differ, and what must be
 * asserted INSTEAD when a stream's byte comparison is waived.
 *
 * Before T-005 this lived in three boolean fields on each case (`rewrite`, `partialStdout`,
 * `compareStderr`) plus a `tsStderr` RegExp, all read by a chain of `if`s inside
 * parity.mjs's differential loop. Two problems with that, and the second is why this file
 * exists rather than a JSON schema with more fields:
 *
 *   1. A RegExp is not JSON-serialisable, so the case registry could not become data
 *      without either losing the pattern or inventing a string encoding for it. Patterns
 *      belong in code; the registry names a policy and the policy owns its pattern.
 *   2. The booleans could DISAGREE with the allowlist waiver sitting beside them — a case
 *      could carry `rewrite: true` with no waiver, so the comparison granted itself a
 *      licence nothing authorised. Here each policy declares the one allowlist ID it
 *      consumes, and `assertRegistry` requires the case's `waiver` to equal it exactly.
 *
 * Every predicate below is transcribed from the branch it replaces, not paraphrased. That
 * distinction is load-bearing: an earlier draft of the T-005 plan described
 * `partial-python-stdout` as "compares the common stdout prefix", which would have been
 * VACUOUS — the port emits nothing on that path, so the common prefix is empty and the
 * assertion always holds. The real branch waives both streams and replaces them with four
 * shape assertions. Paraphrasing a waiver is how a waiver quietly becomes a hole.
 *
 * Policies throw plain Errors and take run objects, never the harness. That is what lets
 * `policies.test.mjs` feed each one a synthetic pair violating exactly one predicate and
 * require a rejection — registering a handler proves it exists, not that it asserts
 * anything.
 */
import { compareRuns } from "./compare.mjs";
import { describeTermination } from "./run.mjs";

/**
 * The one sanctioned text delta, applied to PYTHON's stdout before byte comparison.
 *
 * Deliberately not a "skip stdout" waiver: ALLOWLIST 22b sanctions exactly one sentence —
 * the config path, which Python documents as a file this port never reads — so the
 * comparison rewrites that span and then demands byte equality for the other ~3.2 KB.
 */
export const SANCTIONED_STDOUT_REWRITE = {
  from: "(from usage-config.json next to this\nscript, or $USAGE_CONFIG)",
  to: "(from ~/.config/spendbar/config.json,\nor $USAGE_CONFIG)",
};

class PolicyError extends Error {}

function fail(msg) {
  throw new PolicyError(msg);
}

/** Predicates every policy shares: python terminated normally, with the transcribed status. */
function pythonTerminatedAsTranscribed(py, c) {
  if (py.termination.kind !== "exit") {
    fail(`python did not terminate normally: ${describeTermination(py.termination)}`);
  }
  if (c.expectExit !== undefined && py.termination.status !== c.expectExit) {
    fail(
      `transcribed exit ${c.expectExit}, python now exits ${py.termination.status}\n` +
        `  argv: ${JSON.stringify(c.argv)}`,
    );
  }
}

function assertSame(label, expected, actual) {
  const diffs = compareRuns(expected, actual);
  if (diffs.length) {
    fail(`${label}\n${diffs.map((d) => `  [${d.stream}] ${d.detail}`).join("\n")}`);
  }
}

/**
 * A waived stderr must still be a DIAGNOSTIC, and specifically the port's own one-line
 * diagnostic rather than a stack trace that happens to be non-empty.
 *
 * "Non-empty stderr" alone would accept a module-load failure or an unrelated traceback,
 * so the shape is pinned too: exactly one newline-terminated line, matching the pattern
 * this policy registered.
 */
function tsDiagnosticShape(ts, pattern, id) {
  const text = ts.stderr.toString("utf8");
  if (!text.endsWith("\n")) fail(`typescript stderr is not newline-terminated: ${JSON.stringify(text)}`);
  if (text.split("\n").length !== 2) {
    fail(`the port must emit ONE diagnostic line, not a traceback: ${JSON.stringify(text)}`);
  }
  if (!pattern.test(text)) {
    fail(`typescript stderr ${JSON.stringify(text)} does not match ${id}'s pattern ${pattern}`);
  }
}

/**
 * ALLOWLIST 19: an uncaught CPython traceback, whose bytes name CPython source files and
 * line numbers and which the port cannot emit under any implementation. One policy per
 * distinct diagnostic, so the pattern is never a per-case free variable.
 */
function tsDiag(id, pattern) {
  return {
    id: `ts-diag:${id}`,
    waiverId: "ALLOWLIST-19",
    pattern,
    remeasure(py, c) {
      pythonTerminatedAsTranscribed(py, c);
      if (py.stderr.length === 0) fail("case waives stderr comparison but python emits none");
      if (py.stdout.length !== 0) fail("a failure path wrote to stdout");
    },
    differential(py, ts, c) {
      pythonTerminatedAsTranscribed(py, c);
      for (const [who, r] of [["python", py], ["typescript", ts]]) {
        if (r.stderr.length === 0) fail(`${who} produced no stderr, but this case must diagnose`);
        if (r.stdout.length !== 0) fail(`${who} wrote to stdout on a failure path`);
      }
      tsDiagnosticShape(ts, pattern, `ts-diag:${id}`);
      // Substituting TS's stderr in leaves stdout and termination genuinely compared, so
      // waiving stderr costs exactly stderr and nothing else.
      assertSame(`case ${c.name} diverged`, { ...py, stderr: ts.stderr }, ts);
    },
  };
}

export const POLICIES = {
  /** Full byte equality of both streams and the termination. The default. */
  exact: {
    id: "exact",
    waiverId: null,
    remeasure(py, c) {
      pythonTerminatedAsTranscribed(py, c);
    },
    differential(py, ts, c) {
      pythonTerminatedAsTranscribed(py, c);
      assertSame(`case ${c.name} diverged`, py, ts);
    },
  },

  /** ALLOWLIST 22b: rewrite the ONE sanctioned span, then demand equality for the rest. */
  "help-config-path": {
    id: "help-config-path",
    waiverId: "ALLOWLIST-22b",
    remeasure(py, c) {
      pythonTerminatedAsTranscribed(py, c);
    },
    differential(py, ts, c) {
      pythonTerminatedAsTranscribed(py, c);
      const { from, to } = SANCTIONED_STDOUT_REWRITE;
      const pyText = py.stdout.toString("utf8");
      const first = pyText.indexOf(from);
      if (first === -1) fail(`case ${c.name} no longer contains the sanctioned span`);
      // Exactly one occurrence: `String.replace` with a string pattern rewrites only the
      // first, so a second occurrence would be silently left behind and then reported as a
      // port divergence at a confusing offset.
      if (pyText.indexOf(from, first + from.length) !== -1) {
        fail(`case ${c.name} contains the sanctioned span more than once; the rewrite is ambiguous`);
      }
      assertSame(
        `case ${c.name} diverged outside the sanctioned rewrite`,
        { ...py, stdout: Buffer.from(pyText.replace(from, to), "utf8") },
        ts,
      );
    },
  },

  /**
   * ALLOWLIST 23: usage.py prints as it goes, so a mid-render crash leaves a header on
   * stdout; the port renders to a string and writes once, so it emits nothing.
   *
   * BOTH streams are waived here — there is no prefix relationship to compare, because one
   * side is empty. What replaces them is the shape: python really did emit something first,
   * the port really did emit nothing, both really did diagnose, and the port really did
   * fail. Drop any one of those four and the interesting regression walks through.
   */
  "partial-python-stdout": {
    id: "partial-python-stdout",
    waiverId: "ALLOWLIST-23",
    remeasure(py, c) {
      pythonTerminatedAsTranscribed(py, c);
      if (py.stderr.length === 0) fail("case waives stderr comparison but python emits none");
      if (py.stdout.length === 0) {
        fail("ALLOWLIST 23 says python fails PART WAY THROUGH rendering; it now emits nothing first");
      }
    },
    differential(py, ts, c) {
      pythonTerminatedAsTranscribed(py, c);
      if (py.stdout.length === 0) {
        fail("python no longer emits partial output before failing; ALLOWLIST 23 needs revisiting");
      }
      if (ts.stdout.length !== 0) {
        fail(`the port must not half-write a table before failing; got ${ts.stdout.length}B`);
      }
      for (const [who, r] of [["python", py], ["typescript", ts]]) {
        if (r.stderr.length === 0) fail(`${who} produced no stderr, but this case must diagnose`);
      }
      if (ts.termination.kind !== "exit" || ts.termination.status !== c.expectExit) {
        fail(`typescript ${describeTermination(ts.termination)}, case requires exit ${c.expectExit}`);
      }
    },
  },

  "ts-diag:invalid-date": tsDiag("invalid-date", /^invalid --date: /),
  "ts-diag:blocks-array-attr": tsDiag("blocks-array-attr", /object has no attribute 'get'/),
};

/** Policy IDs that waive something, i.e. every one whose replacement assertions matter. */
export const NON_EXACT_POLICIES = Object.keys(POLICIES).filter((id) => id !== "exact");

/** The allowlist IDs a comparison actually consumes — the enforceable domain of T-005. */
export const POLICY_CONSUMED_WAIVERS = new Set(
  Object.values(POLICIES)
    .map((p) => p.waiverId)
    .filter((w) => w !== null),
);

export function resolvePolicy(id) {
  const p = POLICIES[id];
  if (!p) throw new Error(`unknown comparisonPolicy ${JSON.stringify(id)}`);
  return p;
}

export { PolicyError };
