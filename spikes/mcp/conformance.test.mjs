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
  "framing-dies": /server died on a malformed line/,
  "args-accept": /accepted instead of rejected/,
  "args-crash": /before answering tools\/call/,
  "cancel-ignored": /waiting for the aborted release witness/,
  "cancel-wedged": /a response to tools\/call \(id 10\)/,
  "eof-alive": /after client EOF/,
  "stdout-noise": /non-JSON bytes on stdout/,
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
