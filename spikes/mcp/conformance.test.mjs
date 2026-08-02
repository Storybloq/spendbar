// Tests for the conformance suite itself (plan §5): every case must be able to FAIL.
//
// The mutant server (mutant-server.mjs) exists for exactly this: a case that passes against
// the defect it claims to detect is vacuous, and a suite of vacuous cases would wave both
// SDKs through. The baseline (`none`) run proves the opposite direction — the cases measure
// behavior, not SDK identity, since a hand-rolled correct server passes all eight.
//
// RUN THIS FILE DIRECTLY (`node spikes/mcp/conformance.test.mjs`), not through `node --test`:
// under the runner's child-process mode the file completes all tests and then the child never
// exits (observed on Node 22.18.0; the same workload drains cleanly in-process and standalone,
// so the lingering ref is in the runner interaction, not the suite). Direct execution reports
// identically and sets a nonzero exit code on failure.

import test from "node:test";
import assert from "node:assert/strict";

import { CASES, runCase, spawnMutant } from "./conformance.mjs";
import { MUTANTS } from "./mutant-server.mjs";

test("the mutant roster and the cases' kill claims are the same set, with no double-claims", () => {
  const claimed = CASES.flatMap((c) => c.mutants);
  assert.deepEqual(
    [...claimed].sort(),
    MUTANTS.filter((m) => m !== "none").sort(),
    "every non-baseline mutant must be claimed by a case, and no case may claim a ghost",
  );
  assert.equal(new Set(claimed).size, claimed.length, "a mutant is claimed twice");
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
    test(`case ${def.name} kills mutant ${mutant}`, async () => {
      const r = await runCase(def, () => spawnMutant(mutant));
      assert.equal(r.status, "fail", `${def.name} PASSED against ${mutant} — the case is vacuous`);
    });
  }
}
