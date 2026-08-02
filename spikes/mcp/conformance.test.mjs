// Tests for the conformance suite itself (plan §5): every case must be able to FAIL.
//
// The mutant server (mutant-server.mjs) exists for exactly this: a case that passes against
// the defect it claims to detect is vacuous, and a suite of vacuous cases would wave both
// SDKs through. The baseline (`none`) run proves the opposite direction — the cases measure
// behavior, not SDK identity, since a hand-rolled correct server passes all eight.
//
// This file runs under `node --test` or directly (`node spikes/mcp/conformance.test.mjs`);
// test:mcp-spike uses direct execution. An earlier header blamed the test runner for a child
// that never exited — review round 1 found the real cause in THIS suite: importing MUTANTS
// executed the mutant server, whose readline interface held the importing process's stdin.
// mutant-server.mjs now guards its runtime behind a direct-entry check.

import test from "node:test";
import assert from "node:assert/strict";

import { CASES, runCase, spawnMutant } from "./conformance.mjs";
import { MUTANTS } from "./mutant-server.mjs";

// Each mutant must die to the ORACLE CLAUSE it exists to prove, not merely die: a mutant
// killed by an unrelated failure (framing-wrong-code crashing at startup, say) would credit
// the wrong-code check without ever exercising it (review round 1). Patterns are literal
// fragments of the intended clause's failure message.
const KILL_REASONS = {
  "blank-version": /is not a date-shaped string/,
  "tool-absent": /absent from tools\/list/,
  "schema-drop": /inputSchema lost the nonce field/,
  "no-structured": /structuredContent missing or nonce not echoed/,
  "empty-text": /text fallback missing or empty/,
  "framing-wrong-code": /only -32700 or silence is conformant/,
  "framing-garbage": /unframeable bytes|only -32700 or silence is conformant/,
  "framing-late": /only -32700 or silence is conformant/,
  "framing-dies": /server died on a malformed line/,
  "args-accept": /accepted instead of rejected/,
  "args-crash": /before answering tools\/call/,
  "cancel-ignored": /waiting for the aborted release witness/,
  "cancel-wedged": /a response to tools\/call \(id 10\)/,
  "eof-alive": /after client EOF/,
  "stdout-noise": /non-JSON bytes on stdout/,
  "stdout-blank-lines": /empty line/,
  "stdout-unterminated": /unterminated/,
  "stderr-silent": /no log output on stderr/,
};

test("the mutant roster and the cases' kill claims are the same set, with no double-claims", () => {
  const claimed = CASES.flatMap((c) => c.mutants);
  assert.deepEqual(
    [...claimed].sort(),
    MUTANTS.filter((m) => m !== "none").sort(),
    "every non-baseline mutant must be claimed by a case, and no case may claim a ghost",
  );
  assert.equal(new Set(claimed).size, claimed.length, "a mutant is claimed twice");
  assert.deepEqual(
    Object.keys(KILL_REASONS).sort(),
    MUTANTS.filter((m) => m !== "none").sort(),
    "every non-baseline mutant must declare its intended kill reason",
  );
});

test("the eight-case list matches the plan's literal case names", () => {
  // An independent oracle for the suite's own shape — dropping a case while refactoring
  // must fail here, not silently shrink the matrix.
  assert.deepEqual(
    CASES.map((c) => c.name),
    [
      "initialize",
      "tools-list",
      "tools-call",
      "broken-framing",
      "schema-violation",
      "cancellation",
      "client-eof",
      "stdout-purity",
    ],
  );
});

test("the correct baseline server passes all eight cases", async () => {
  for (const def of CASES) {
    const r = await runCase(def, () => spawnMutant("none"));
    assert.equal(r.status, "pass", `${def.name} vs correct baseline: ${r.detail}`);
  }
});

for (const def of CASES) {
  for (const mutant of def.mutants) {
    test(`case ${def.name} kills mutant ${mutant} for the intended reason`, async () => {
      const r = await runCase(def, () => spawnMutant(mutant));
      assert.equal(r.status, "fail", `${def.name} PASSED against ${mutant} — the case is vacuous`);
      assert.match(
        r.detail,
        KILL_REASONS[mutant],
        `${mutant} died, but to the wrong clause — the intended oracle was never exercised: ${r.detail}`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Review round 2, chunk 9: the harness itself, and the isolation claim.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Harness, sdkWitness, judgeCaseIsolation, aggregateIsolation } from "./conformance.mjs";

/** A stand-in for a spawned server, so harness properties are testable without a process. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: () => true, end: () => {}, destroy: () => {} });
  child.kill = () => {};
  return child;
}

test("an observation that overflowed is a failure even when the predicate is satisfied", async () => {
  const child = fakeChild();
  const h = new Harness(child);
  // The response and the overflow arrive in the SAME event. Taking the predicate first
  // reported a passing request over a stream the harness had stopped capturing.
  h.overflow = "stdout";
  await assert.rejects(
    () => h.waitFor(() => true, 1_000, "anything"),
    /stdout exceeded/,
    "a satisfied predicate was allowed to override a known-failed observation",
  );
});

test("overflow arriving in the same event that satisfies the predicate still fails", async () => {
  const child = fakeChild();
  const h = new Harness(child);
  // The asynchronous path, not the early check: nothing is wrong when the wait begins, and
  // then ONE event both floods the stream and makes the predicate true. Taking the predicate
  // first here reported a pass over a stream the harness had just stopped capturing.
  const waiting = h.waitFor(() => h.stdoutRaw.length > 0, 2_000, "any output");
  child.stdout.emit("data", "x".repeat(6_000_000));
  await assert.rejects(() => waiting, /exceeded/, "a satisfied predicate overrode a failed observation mid-wait");
});

test("the parse buffer is bounded, not only the retained stream", async () => {
  const child = fakeChild();
  const h = new Harness(child);
  // Six megabytes with no newline: nothing is ever framed, so the cap on the retained copy
  // never limited what the parser held.
  child.stdout.emit("data", "x".repeat(6_000_000));
  assert.equal(h.overflow, "stdout", "an unterminated flood did not register as overflow");
  await assert.rejects(() => h.waitFor(() => false, 500, "a frame"), /exceeded/);
});

test("a case whose child would not close is failed, not reported on", async () => {
  // dispose() bounds its wait so an unkillable child cannot hang the run — but returning
  // quietly meant the caller read a resolution log a live process was still writing.
  const def = { name: "fake", async run() {} };
  const r = await runCase(def, () => {
    const child = fakeChild();
    child.kill = () => {}; // never emits 'close'
    return child;
  });
  assert.equal(r.status, "fail");
  assert.match(r.detail, /did not close after SIGKILL/);
});

test("isolation requires the candidate SDK to have been resolved, not merely something in-root", () => {
  const rootReal = "/tmp/candidate-root";
  const sdk = "@modelcontextprotocol/server";
  const inSdk = join(rootReal, "node_modules", "@modelcontextprotocol", "server", "dist", "index.js");
  const notSdk = [
    join(rootReal, "server.mjs"),
    join(rootReal, "instrument.mjs"),
    join(rootReal, "node_modules", "@modelcontextprotocol", "server-extras", "index.js"),
  ];
  // Every one of these is inside the root, so the old "inside > 0" test passed — and a
  // server.mjs that had stopped importing the SDK entirely would have passed with it.
  assert.equal(sdkWitness({ rootReal, insidePaths: notSdk }, sdk), 0);
  assert.equal(sdkWitness({ rootReal, insidePaths: [...notSdk, inSdk] }, sdk), 1);
  // The sibling package must not be mistaken for the package: prefix matching without the
  // separator would count `server-extras` as `server`.
  assert.equal(sdkWitness({ rootReal, insidePaths: [notSdk[2]] }, sdk), 0);
});

test("a case that never resolved the candidate SDK is recorded as uninstrumented", () => {
  const rootReal = "/tmp/candidate-root";
  const sdk = "@modelcontextprotocol/server";
  const base = { rootReal, total: 40, violations: [] };
  const withoutSdk = judgeCaseIsolation({ ...base, insidePaths: [join(rootReal, "server.mjs")] }, sdk, 0);
  assert.equal(withoutSdk.sdkResolutions, 0);
  assert.match(withoutSdk.error, /did not exercise the candidate SDK/);

  const withSdk = judgeCaseIsolation(
    { ...base, insidePaths: [join(rootReal, "node_modules", "@modelcontextprotocol", "server", "index.js")] },
    sdk,
    0,
  );
  assert.equal(withSdk.error, undefined);
  assert.equal(withSdk.sdkResolutions, 1);
});

test("every way isolation can be false actually makes it false", () => {
  const clean = { perCase: { a: { sdkResolutions: 3 } }, violations: [], descendants: [], oppositeSdkProbe: "not-found" };
  assert.equal(aggregateIsolation(clean).ok, true, "the positive control does not pass");
  assert.equal(aggregateIsolation({ ...clean, perCase: { a: { error: "no SDK" } } }).ok, false);
  assert.equal(aggregateIsolation({ ...clean, perCase: { a: { error: "no SDK" } } }).everyCaseInstrumented, false);
  assert.equal(aggregateIsolation({ ...clean, violations: [{}] }).ok, false);
  assert.equal(aggregateIsolation({ ...clean, descendants: [{}] }).ok, false);
  assert.equal(aggregateIsolation({ ...clean, oppositeSdkProbe: "resolved" }).ok, false);
});
