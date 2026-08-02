// Tests for decide()/act1 (plan §1), the evidence verifier (§6) and the token plumbing (§7).
//
// Runs under `node --test` or directly (`node spikes/mcp/decide.test.mjs`); test:mcp-spike
// uses direct execution. (An earlier runner hang traced to mutant-server.mjs executing on
// import; it is fixed — see conformance.test.mjs.)

import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  SCRIPTED_CASES,
  REAL_CLIENTS,
  MANDATORY_CELLS,
  EXIT_CODES,
  aggregate,
  decide,
  act1,
  renderDecisionDoc,
  renderDecisionRecord,
  renderAttemptReport,
  serializeJsonArtifact,
  versionTuple,
  TransitionError,
} from "./decide.mjs";
import {
  verifyEvidence,
  BOUND_INPUTS,
  EVIDENCE_DIR,
  EvidenceError,
  CAN_ISOLATE_USER_CONFIG,
  checkOutcomeArtifacts,
  verifyRecordedOutcome,
  OUTCOME_ARTIFACTS,
} from "./verify-evidence.mjs";
import { canonicalize, proxyTokens, measureToolDefinition, TOKEN_PROXY_VERSION } from "./token-cost.mjs";
import {
  runStages,
  buildStages,
  validateConformance,
  validateMeasurement,
  readAuditResult,
  publishGeneration,
  candidateFailed,
} from "./matrix.mjs";
import { CAPTURE_INPUTS } from "./real-client/provenance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// ---------- the mandatory set, against a SEPARATE literal oracle ---------------------------

test("the mandatory cell set equals the plan's literal: eight scripted cases plus both clients", () => {
  assert.deepEqual(MANDATORY_CELLS, [
    "scripted:initialize",
    "scripted:tools-list",
    "scripted:tools-call",
    "scripted:broken-framing",
    "scripted:schema-violation",
    "scripted:cancellation",
    "scripted:client-eof",
    "scripted:stdout-purity",
    "real:claude-code",
    "real:codex",
  ]);
});

test("exit codes are the pinned literals", () => {
  assert.deepEqual(EXIT_CODES, {
    "adopt-v2": 0,
    "adopt-v1": 0,
    blocked: 3,
    incomplete: 4,
    invalidEvidence: 2,
    transitionError: 5,
  });
});

// ---------- aggregate and the truth table, every cell --------------------------------------

const cellsAll = (status) => Object.fromEntries(MANDATORY_CELLS.map((n) => [n, { status }]));
const withCell = (cells, name, status) => ({ ...cells, [name]: { status } });

test("aggregate: EVERY mandatory cell can single-handedly drive the aggregate", () => {
  // Exhaustive on purpose (review round 1): spot-checking two cells would pass even if the
  // aggregate silently ignored the other eighteen. Each cell is broken alone, twice.
  assert.equal(aggregate(cellsAll("pass")), "pass");
  for (const name of MANDATORY_CELLS) {
    assert.equal(aggregate(withCell(cellsAll("pass"), name, "fail")), "fail", `${name} did not force fail`);
    assert.equal(aggregate(withCell(cellsAll("pass"), name, "not-run")), "not-run", `${name} did not force not-run`);
    // not-run dominates fail no matter which cell carries which.
    assert.equal(aggregate(withCell(cellsAll("fail"), name, "not-run")), "not-run", `${name} lost not-run dominance`);
  }
});

test("aggregate refuses an absent or malformed value in EVERY mandatory cell", () => {
  for (const name of MANDATORY_CELLS) {
    const missing = cellsAll("pass");
    delete missing[name];
    assert.throws(() => aggregate(missing), /absent or malformed/, `missing ${name} was tolerated`);
    assert.throws(
      () => aggregate(withCell(cellsAll("pass"), name, "maybe")),
      /absent or malformed/,
      `malformed ${name} was tolerated`,
    );
  }
});

test("the decision truth table, every cell", () => {
  // The plan's table plus the not-run row expanded: nine aggregate combinations, all pinned.
  const EXPECT = {
    "not-run|not-run": "incomplete",
    "not-run|pass": "incomplete",
    "not-run|fail": "incomplete",
    "pass|not-run": "incomplete",
    "fail|not-run": "incomplete",
    "pass|pass": "adopt-v2", // v1 is UNSELECTED, not failed
    "pass|fail": "adopt-v2",
    "fail|pass": "adopt-v1",
    "fail|fail": "blocked",
  };
  for (const [combo, expected] of Object.entries(EXPECT)) {
    const [v2, v1] = combo.split("|");
    const verified = { cells: { v2: cellsAll(v2), v1: cellsAll(v1) } };
    assert.equal(decide(verified).outcome, expected, `v2=${v2} v1=${v1}`);
  }
});

test("a single not-run cell anywhere produces incomplete, never blocked", () => {
  // §1: absence of evidence is not evidence of failure — even when everything else failed.
  const verified = {
    cells: { v2: cellsAll("fail"), v1: withCell(cellsAll("fail"), "real:codex", "not-run") },
  };
  assert.equal(decide(verified).outcome, "incomplete");
});

// ---------- act1 ----------------------------------------------------------------------------

function verifiedFixture(v2Status, v1Status, { qualifications = [] } = {}) {
  return {
    cells: { v2: cellsAll(v2Status), v1: cellsAll(v1Status) },
    sdk: { v2: "@modelcontextprotocol/server", v1: "@modelcontextprotocol/sdk" },
    versions: { v2: "2.0.0", v1: "1.30.0" },
    report: {
      closureSize: { v2: 3, v1: 93 },
      tokenCost: {
        proxyVersion: TOKEN_PROXY_VERSION,
        v2: { canonicalBytes: 903, proxyTokens: 226 },
        v1: { canonicalBytes: 933, proxyTokens: 234 },
      },
      notes: ["fixture note"],
      qualifications,
    },
  };
}

function spyDeps({
  existingTicket = null,
  failAt = null,
  blockedByAfterAttach = true,
  resolutionTicketBack = null, // override the read-back record for the resolution ticket
} = {}) {
  const calls = [];
  const fail = (step) => {
    if (failAt === step) throw new Error(`injected ${step} failure`);
  };
  const ticket = { id: "T-900" };
  return {
    calls,
    docs: [],
    reports: [],
    records: [],
    cleared: 0,
    writeDecisionDoc(doc) {
      calls.push("decision-doc");
      fail("decision-doc");
      this.docs.push(doc);
    },
    writeDecisionRecord(record) {
      calls.push("decision-record");
      fail("decision-record");
      this.records.push(record);
    },
    removeDecisionArtifacts() {
      calls.push("clear-stale-verdict");
      fail("clear-stale-verdict");
      this.cleared++;
    },
    writeAttemptReport(report) {
      calls.push("attempt-report");
      fail("attempt-report");
      this.reports.push(report);
    },
    graph: {
      findOpenTicketByDedupeKey(key) {
        calls.push(`locate:${key}`);
        fail("locate-resolution-ticket");
        return existingTicket;
      },
      createResolutionTicket(key) {
        calls.push(`create:${key}`);
        fail("create-resolution-ticket");
        return ticket;
      },
      attachBlocker(target, id) {
        calls.push(`attach:${target}:${id}`);
        fail("attach-blocker");
      },
      readTicket(id) {
        calls.push(`read:${id}`);
        if (id === "T-900") {
          fail("read-back-resolution-ticket");
          return (
            resolutionTicketBack ?? {
              id,
              // Still a hand-written literal rather than a call to resolutionTicketTitle: an
              // oracle computed by the code under test cannot catch that code changing. The
              // version tuple is length-prefixed so no separator can be forged (round 2, c11).
              title: "No supported MCP SDK (T-009:no-supported-sdk:5:2.0.0/6:1.30.0)",
              status: "open",
            }
          );
        }
        fail("read-back-t013");
        return { id, blockedBy: blockedByAfterAttach ? ["T-900"] : [] };
      },
    },
  };
}

test("act1 on incomplete: typed attempt report, no decision document, no graph mutation", async () => {
  const verified = verifiedFixture("pass", "not-run");
  const deps = spyDeps();
  const r = await act1(decide(verified), verified, deps);
  assert.equal(r.exitCode, EXIT_CODES.incomplete);
  assert.equal(deps.docs.length, 0);
  assert.equal(deps.reports.length, 1);
  assert.equal(deps.reports[0].type, "t009-attempt-report");
  assert.ok(deps.reports[0].unavailable.length > 0);
  assert.ok(deps.reports[0].unavailable.every((u) => u.cell && u.candidate && u.cause));
  assert.equal(deps.cleared, 1, "stale verdict artifacts were not cleared");
  assert.deepEqual(deps.calls, ["clear-stale-verdict", "attempt-report"], `graph was touched: ${deps.calls}`);
});

test("act1 on adopt-v2: decision document only — no ticket, no blocker", async () => {
  const verified = verifiedFixture("pass", "pass");
  const deps = spyDeps();
  const r = await act1(decide(verified), verified, deps);
  assert.equal(r.exitCode, 0);
  assert.equal(deps.docs.length, 1);
  assert.ok(deps.docs[0].includes("adopt-v2"));
  assert.ok(deps.docs[0].includes("open question 3, an owner decision"));
  assert.deepEqual(deps.calls, ["decision-doc", "decision-record"]);
  assert.deepEqual(deps.records, [
    {
      outcome: "adopt-v2",
      aggregates: { v2: "pass", v1: "pass" },
      versions: { v2: "2.0.0", v1: "1.30.0" },
      qualifications: [],
    },
  ]);
  // With nothing to qualify, the heading is absent rather than present-and-empty: a standing
  // empty section trains a reader to skip it, which is exactly when the one that matters lands.
  assert.ok(!deps.docs[0].includes("Qualified passes"));
});

test("a qualified pass reaches BOTH the decision document and the machine record", async () => {
  // The failure this pins: a cell that passed under a weaker guarantee than the others, whose
  // caveat lives only in a manifest nobody re-reads. adopt-v2 is the dangerous outcome for it —
  // the run "succeeded", so nothing else in the pipeline is going to raise its hand.
  const qualification = {
    candidate: "v1",
    cell: "real:codex",
    kind: "user-config-not-isolated",
    detail: "codex ran with the operator's own user configuration reachable",
  };
  const verified = verifiedFixture("pass", "pass", { qualifications: [qualification] });
  const deps = spyDeps();
  await act1(decide(verified), verified, deps);

  const doc = deps.docs[0];
  assert.ok(doc.includes("## Qualified passes"), "the document does not qualify the table it just printed");
  assert.ok(doc.includes("user-config-not-isolated"));
  assert.ok(doc.includes("real:codex"));
  // Before "Reported, not gating", because it is a limit on the result rather than context
  // beside it.
  assert.ok(doc.indexOf("## Qualified passes") < doc.indexOf("## Reported, not gating"));
  assert.deepEqual(deps.records[0].qualifications, [qualification]);
  // The outcome itself is untouched: a qualification is not a downgrade, and a verifier that
  // could silently turn a pass into something else would be overruling the classifier.
  assert.equal(deps.records[0].outcome, "adopt-v2");
});

test("a qualification cannot break the document's structure with embedded markup", async () => {
  // Qualification text is evidence-controlled, so it goes through the same md() escaping as
  // every other rendered value — otherwise a newline or a pipe could make the document
  // visually disagree with the record it was generated from.
  const verified = verifiedFixture("pass", "pass", {
    qualifications: [
      { candidate: "v1", cell: "real:codex", kind: "k\ninjected", detail: "a | b\n## Fake heading" },
    ],
  });
  const deps = spyDeps();
  await act1(decide(verified), verified, deps);
  const qualLine = deps.docs[0].split("\n").find((l) => l.includes("injected"));
  assert.ok(qualLine.includes("\\|"), "a table pipe was rendered unescaped");
  assert.ok(!deps.docs[0].includes("\n## Fake heading"), "an embedded heading survived into the document");
});

test("act1 on blocked: dedupe-keyed ticket, attach, read-back, then the document, exit 3", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps();
  const r = await act1(decide(verified), verified, deps);
  assert.equal(r.exitCode, EXIT_CODES.blocked);
  assert.deepEqual(deps.calls, [
    "locate:T-009:no-supported-sdk:5:2.0.0/6:1.30.0",
    "create:T-009:no-supported-sdk:5:2.0.0/6:1.30.0",
    "read:T-900",
    "attach:T-013:T-900",
    "read:T-013",
    "decision-doc",
    "decision-record",
  ]);
  assert.equal(deps.docs.length, 1);
  assert.equal(deps.records.length, 1);
  assert.equal(deps.records[0].outcome, "blocked");
});

test("act1 on blocked is idempotent: an existing ticket is reused AND the rest of the transaction still runs", async () => {
  // Asserting only "did not create" would pass an implementation that returned right after
  // the lookup — never attaching the blocker or writing the artifacts (review round 1).
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps({ existingTicket: { id: "T-900" } });
  const r = await act1(decide(verified), verified, deps);
  assert.deepEqual(deps.calls, [
    "locate:T-009:no-supported-sdk:5:2.0.0/6:1.30.0",
    "read:T-900",
    "attach:T-013:T-900",
    "read:T-013",
    "decision-doc",
    "decision-record",
  ]);
  assert.equal(r.exitCode, EXIT_CODES.blocked);
  assert.equal(r.ticketId, "T-900");
  assert.equal(deps.docs.length, 1);
  assert.equal(deps.records.length, 1);
});

test("act1 trusts the read-back, not the write: a lying attach is a transition error", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps({ blockedByAfterAttach: false });
  await assert.rejects(
    () => act1(decide(verified), verified, deps),
    (e) => e instanceof TransitionError && e.step === "read-back-t013",
  );
  assert.equal(deps.docs.length, 0, "decision document written despite failed read-back");
});

test("act1 recomputes the decision and refuses a supplied one that disagrees — before any effect", async () => {
  const verified = verifiedFixture("pass", "pass"); // truth: adopt-v2
  const deps = spyDeps();
  await assert.rejects(
    () => act1({ outcome: "blocked", aggregates: { v2: "fail", v1: "fail" } }, verified, deps),
    (e) => e instanceof TransitionError && e.step === "decision-recompute",
  );
  assert.deepEqual(deps.calls, [], `effects ran on a mismatched decision: ${deps.calls}`);
});

test("act1 refuses a decision whose OUTCOME agrees but whose aggregates do not", async () => {
  // Comparing only `outcome` would let wrong aggregates reach the document and the machine
  // record (review round 1). Each aggregate is corrupted independently.
  const verified = verifiedFixture("pass", "pass"); // truth: adopt-v2, aggregates pass/pass
  for (const aggregates of [
    { v2: "pass", v1: "fail" },
    { v2: "fail", v1: "pass" },
    { v2: "not-run", v1: "pass" },
    { v2: "pass", v1: "not-run" },
  ]) {
    const deps = spyDeps();
    await assert.rejects(
      () => act1({ outcome: "adopt-v2", aggregates }, verified, deps),
      (e) => e instanceof TransitionError && e.step === "decision-recompute",
      `aggregates ${JSON.stringify(aggregates)} were accepted`,
    );
    assert.deepEqual(deps.calls, [], "effects ran on a mismatched decision");
  }
});

test("act1 refuses an unknown outcome before any effect", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps();
  await assert.rejects(
    () => act1({ outcome: "adopt-v3", aggregates: { v2: "fail", v1: "fail" } }, verified, deps),
    (e) => e instanceof TransitionError && e.step === "decision-recompute",
  );
  assert.deepEqual(deps.calls, []);
});

test("act1 on blocked verifies the resolution ticket read-back: a missing dedupe key fails closed", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps({ resolutionTicketBack: { id: "T-900", title: "Some other ticket", status: "open" } });
  await assert.rejects(
    () => act1(decide(verified), verified, deps),
    (e) => e instanceof TransitionError && e.step === "read-back-resolution-ticket",
  );
  assert.ok(!deps.calls.some((c) => c.startsWith("attach:")), `attached despite bad read-back: ${deps.calls}`);
});

test("act1 on blocked refuses a resolution ticket that read back closed", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps({
    resolutionTicketBack: {
      id: "T-900",
      title: "No supported MCP SDK (T-009:no-supported-sdk:5:2.0.0/6:1.30.0)",
      status: "done",
    },
  });
  await assert.rejects(
    () => act1(decide(verified), verified, deps),
    (e) => e instanceof TransitionError && e.step === "read-back-resolution-ticket",
  );
  assert.ok(!deps.calls.some((c) => c.startsWith("attach:")));
});

test("act1: an injected failure at each step surfaces as that step's transition error", async () => {
  const verified = verifiedFixture("fail", "fail");
  for (const step of [
    "locate-resolution-ticket",
    "create-resolution-ticket",
    "read-back-resolution-ticket",
    "attach-blocker",
    "read-back-t013",
    "decision-doc",
    "decision-record",
  ]) {
    const deps = spyDeps({ failAt: step });
    await assert.rejects(
      () => act1(decide(verified), verified, deps),
      (e) => e instanceof TransitionError && e.step === step && e.exitCode === EXIT_CODES.transitionError,
      `step ${step}`,
    );
  }
});

test("act1 on incomplete: a failing stale-verdict clear is that step's transition error", async () => {
  const verified = verifiedFixture("pass", "not-run");
  const deps = spyDeps({ failAt: "clear-stale-verdict" });
  await assert.rejects(
    () => act1(decide(verified), verified, deps),
    (e) => e instanceof TransitionError && e.step === "clear-stale-verdict",
  );
  assert.equal(deps.reports.length, 0, "attempt report written despite failed clear");
});

test("evidence-controlled strings cannot corrupt the decision document's markdown", () => {
  const verified = verifiedFixture("pass", "fail");
  verified.sdk.v2 = "evil|name\nsecond-line";
  verified.cells.v1["scripted:initialize"] = { status: "fail", detail: "bad | pipe\nand newline" };
  verified.report.notes = ["note with | pipe"];
  const doc = renderDecisionDoc(verified, decide(verified));
  assert.ok(doc.includes("| v2 | evil\\|name second-line |".replace("| v2 | ", "| v2 | ")), "sdk not escaped");
  assert.ok(!doc.includes("evil|name"), "raw pipe survived into the table");
  assert.ok(doc.includes("bad \\| pipe and newline"), "detail not escaped/normalized");
  assert.ok(doc.includes("note with \\| pipe"), "note not escaped");
});

test("the decision document is generated from the data and reports without gating", () => {
  const verified = verifiedFixture("pass", "fail");
  const doc = renderDecisionDoc(verified, decide(verified));
  assert.ok(doc.includes("| v2 | @modelcontextprotocol/server | 2.0.0 | pass |"));
  assert.ok(doc.includes("| v1 | @modelcontextprotocol/sdk | 1.30.0 | fail |"));
  assert.ok(doc.includes("no acceptance threshold"));
  assert.ok(doc.includes("fixture note"));
});

// ---------- the verifier, against fixture evidence ------------------------------------------

/**
 * A self-consistent fixture: the real evidence dir copied to tmp, plus a fake repo holding
 * copies of every bound input — so digests match, and each test then breaks exactly one thing.
 */
function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-fixture-"));
  try {
    const evidenceDir = join(dir, "evidence");
    const repoRoot = join(dir, "repo");
    cpSync(EVIDENCE_DIR, evidenceDir, { recursive: true });
    for (const rel of BOUND_INPUTS) {
      mkdirSync(dirname(join(repoRoot, rel)), { recursive: true });
      cpSync(join(REPO, rel), join(repoRoot, rel));
    }
    const mutate = (name, fn2) => {
      const p = join(evidenceDir, name);
      const value = JSON.parse(readFileSync(p, "utf8"));
      fn2(value);
      writeFileSync(p, JSON.stringify(value, null, 2));
    };
    return fn({ evidenceDir, repoRoot, mutate });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the committed evidence verifies offline, with the full mandatory set", () => {
  // This is §5's "recorded evidence validated offline" running against the real record:
  // structure, digests, isolation, supply chain, and all twenty cells.
  const verified = verifyEvidence();
  for (const c of ["v1", "v2"]) {
    assert.deepEqual(Object.keys(verified.cells[c]).sort(), [...MANDATORY_CELLS].sort());
  }
  // The recorded verdict, pinned to what the evidence ACTUALLY derives today: `incomplete`.
  //
  // This line used to read adopt-v2, and the gap between it and reality is the whole reason
  // §14 exists. The four real-client captures went stale — a capture input changed after they
  // were taken — so every mandatory real cell degrades to not-run, not-run dominates (§1), and
  // the gate has no verdict to give. Meanwhile the committed decision.json and DECISION.md
  // still said adopt-v2 and `verify:real-client-evidence` exited 0 over the contradiction.
  //
  // A recapture is what changes this, and it must change this line WITH the evidence, never
  // instead of it.
  const decision = decide(verified);
  assert.equal(decision.outcome, "incomplete");
  assert.deepEqual(decision.aggregates, { v2: "not-run", v1: "not-run" });
  // Non-vacuity: assert the CAUSE, not just the status. A not-run with an empty or missing
  // cause would satisfy the line above while telling a reader nothing about why the gate could
  // not run — and "the gate could not run" is only an honest answer when it says what stopped it.
  for (const candidate of ["v1", "v2"]) {
    for (const client of ["claude-code", "codex"]) {
      const cell = verified.cells[candidate][`real:${client}`];
      assert.equal(cell.status, "not-run", `${candidate}/real:${client} is not not-run`);
      assert.match(
        cell.cause,
        /changed since these captures were taken/,
        `${candidate}/real:${client} is not-run for an unstated reason`,
      );
    }
  }
  // No cell reached a pass, so nothing qualified one. Pinned as an exact set rather than a
  // count: a qualification appearing here would mean a cell contributed to a decision the
  // aggregates above say was never reached.
  assert.deepEqual(verified.report.qualifications, []);
});

test("a cell that ran without user-config isolation is not-run — it cannot certify an adoption", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    // Flip the one client that IS isolated today. If the rule were hardcoded to Codex, or read
    // from anywhere but the manifest, this would not move.
    mutate("real-clients/claude-code-v2.manifest.json", (m) => (m.isolation.userConfigIsolated = false));
    const verified = verifyEvidence({ evidenceDir, repoRoot });
    const cell = verified.cells.v2["real:claude-code"];
    // This assertion is the inversion of what it used to be, and the inversion IS the fix.
    // Until review round 12 an unisolated capture stayed a mandatory `pass` and merely acquired
    // a qualification — and qualifications reach DECISION.md prose without ever entering
    // decide()'s aggregate, so a cell that did not meet §9's isolation requirement could still
    // certify adopt-v2 with the shortfall demoted to a paragraph a reader has to notice
    // (ISS-047). Prose is not a gate.
    assert.equal(cell.status, "not-run", "an unisolated capture is still being counted as a pass");
    assert.match(cell.cause, /isolation mechanism/, "the not-run does not say why");
    // And the consequence that makes it a gate rather than a note: not-run dominates, so no
    // adoption can be reached on this evidence.
    assert.equal(decide(verified).outcome, "incomplete");
    // The cell contributed nothing, so nothing may annotate it as a qualified pass.
    assert.ok(
      !verified.report.qualifications.some((q) => q.candidate === "v2" && q.cell === "real:claude-code"),
      "a cell that was downgraded to not-run is still being described as a qualified pass",
    );
  });
});

test("an unisolated capture is still fully validated — the downgrade is not a way to skip checks", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    // The downgrade is applied to the PUBLISHED cell, after every receipt, manifest-binding and
    // re-derivation check has run against the RECORDED status. If it were applied early — by
    // returning or continuing at the isolation flag — a manifest could dodge validation by
    // simply declaring itself unisolated, turning a fail-closed rule into a bypass.
    mutate("real-clients/claude-code-v2.manifest.json", (m) => {
      m.isolation.userConfigIsolated = false;
      m.digests.derivationDigest = "0".repeat(64);
    });
    assert.throws(
      () => verifyEvidence({ evidenceDir, repoRoot }),
      /receipt digests disagree with the manifest|is not the file its receipt was written for/,
      "an unisolated capture skipped the manifest/receipt binding checks",
    );
  });
});

// ---------- the recorded outcome, against the evidence it claims to describe ------------------
//
// The check that did not exist. decide(verifyEvidence()) derived `incomplete` while the
// committed decision.json and DECISION.md declared adopt-v2, and `verify:real-client-evidence`
// exited 0 over the contradiction — a guard reporting success while having observed nothing, in
// the check whose whole job was to catch exactly this (plan §14.1).
//
// checkOutcomeArtifacts takes an injected reader precisely so BOTH branches are testable: the
// verdict branch is unreachable from any fixture built out of the committed evidence, because
// that evidence derives `incomplete`, and the untested half would have been the half that
// decides whether an adoption is honest.

/** An in-memory artifact set. Absent files are simply missing keys. */
const reader = (files) => (name) => (name in files ? Buffer.from(files[name], "utf8") : null);

const sha256Hex = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** Exactly what Act 1 would have written for this verified result — via the same generators. */
function artifactsFor(verified, decision) {
  if (decision.outcome === "incomplete") {
    return { [OUTCOME_ARTIFACTS.attemptReport]: serializeJsonArtifact(renderAttemptReport(verified)) };
  }
  return {
    [OUTCOME_ARTIFACTS.decisionDoc]: renderDecisionDoc(verified, decision),
    [OUTCOME_ARTIFACTS.decisionRecord]: serializeJsonArtifact(renderDecisionRecord(verified, decision)),
  };
}

test("a freshly generated artifact set verifies clean, on every outcome", () => {
  // The positive control. Without it every refusal test below could pass against a check that
  // refuses unconditionally — which would be a gate that never lets a correct repository through.
  const cases = [
    ["pass", "pass", "adopt-v2"],
    ["fail", "pass", "adopt-v1"],
    ["fail", "fail", "blocked"],
    ["not-run", "pass", "incomplete"],
  ];
  for (const [v2, v1, expected] of cases) {
    const verified = verifiedFixture(v2, v1);
    const decision = decide(verified);
    assert.equal(decision.outcome, expected, `fixture ${v2}/${v1} did not derive ${expected}`);
    checkOutcomeArtifacts(verified, decision, reader(artifactsFor(verified, decision)));
  }
  assert.equal(cases.length, 4, "the outcome table lost a row — every outcome must be exercised");
});

test("a decision document is refused when the evidence derives incomplete", () => {
  // The exact repository state that went unnoticed: stale captures, no verdict, and a decision
  // document still naming a winner.
  const verified = verifiedFixture("not-run", "pass");
  const decision = decide(verified);
  assert.equal(decision.outcome, "incomplete");
  const stale = verifiedFixture("pass", "pass");
  for (const name of [OUTCOME_ARTIFACTS.decisionDoc, OUTCOME_ARTIFACTS.decisionRecord]) {
    const files = { ...artifactsFor(verified, decision), ...artifactsFor(stale, decide(stale)) };
    delete files[name === OUTCOME_ARTIFACTS.decisionDoc ? OUTCOME_ARTIFACTS.decisionRecord : OUTCOME_ARTIFACTS.decisionDoc];
    assert.throws(
      () => checkOutcomeArtifacts(verified, decision, reader(files)),
      new RegExp(`${name.replace(".", "\\.")} is present`),
      `${name} survived alongside a derived incomplete`,
    );
  }
});

test("an attempt report that is missing, stale, or hand-written is refused", () => {
  const verified = verifiedFixture("not-run", "pass");
  const decision = decide(verified);

  assert.throws(() => checkOutcomeArtifacts(verified, decision, reader({})), /attempt-report\.json is missing/);

  // "Present and names a cause" — the weaker check — is satisfied by both of these. Byte
  // equality is what separates a report generated from THIS evidence from one that merely
  // looks like a report.
  const handWritten = serializeJsonArtifact({
    type: "t009-attempt-report",
    outcome: "incomplete",
    unavailable: [{ candidate: "v2", cell: "real:codex", cause: "something plausible" }],
  });
  assert.throws(
    () => checkOutcomeArtifacts(verified, decision, reader({ [OUTCOME_ARTIFACTS.attemptReport]: handWritten })),
    /does not match the artifact regenerated/,
    "a hand-written attempt report naming a plausible cause was accepted",
  );

  // A report from a DIFFERENT incomplete run: same type, same outcome, different unavailable set.
  const other = verifiedFixture("pass", "not-run");
  assert.equal(decide(other).outcome, "incomplete");
  assert.throws(
    () =>
      checkOutcomeArtifacts(
        verified,
        decision,
        reader({ [OUTCOME_ARTIFACTS.attemptReport]: serializeJsonArtifact(renderAttemptReport(other)) }),
      ),
    /does not match the artifact regenerated/,
    "an attempt report from a different run was accepted",
  );
});

test("a decision naming the RIGHT outcome but the wrong evidence is refused", () => {
  // THE mutation the review round demanded, and the one outcome-equality would have passed.
  // Both sides derive adopt-v2; only the bodies differ — different candidate versions, a
  // different cell breakdown, a qualification that is no longer true. An outcome-only check
  // calls this a match and leaves a document describing evidence that no longer exists.
  const verified = verifiedFixture("pass", "pass");
  const decision = decide(verified);
  const drifted = verifiedFixture("pass", "fail", {
    qualifications: [{ candidate: "v2", cell: "real:codex", kind: "stale-kind", detail: "no longer true" }],
  });
  drifted.versions = { v2: "2.9.9", v1: "1.99.0" };
  assert.equal(decide(drifted).outcome, decision.outcome, "the two fixtures must agree on the OUTCOME");

  for (const name of [OUTCOME_ARTIFACTS.decisionDoc, OUTCOME_ARTIFACTS.decisionRecord]) {
    const files = { ...artifactsFor(verified, decision), ...{ [name]: artifactsFor(drifted, decide(drifted))[name] } };
    assert.throws(
      () => checkOutcomeArtifacts(verified, decision, reader(files)),
      /does not match the artifact regenerated/,
      `a stale ${name} naming the same outcome was accepted`,
    );
  }
});

test("an attempt report alongside a verdict is refused, and a missing decision artifact too", () => {
  const verified = verifiedFixture("pass", "pass");
  const decision = decide(verified);
  const incomplete = verifiedFixture("not-run", "pass");

  assert.throws(
    () =>
      checkOutcomeArtifacts(
        verified,
        decision,
        reader({
          ...artifactsFor(verified, decision),
          [OUTCOME_ARTIFACTS.attemptReport]: serializeJsonArtifact(renderAttemptReport(incomplete)),
        }),
      ),
    /attempt-report\.json is present/,
    "a verdict kept an attempt report from an earlier incomplete run",
  );

  for (const name of [OUTCOME_ARTIFACTS.decisionDoc, OUTCOME_ARTIFACTS.decisionRecord]) {
    const files = artifactsFor(verified, decision);
    delete files[name];
    assert.throws(() => checkOutcomeArtifacts(verified, decision, reader(files)), new RegExp(`${name.replace(".", "\\.")} is missing`));
  }
});

/**
 * Golden digests: the exact bytes each generator produces for a fixed fixture, recorded as
 * INDEPENDENT LITERALS rather than recomputed from the generators under test.
 *
 * These exist because the obvious determinism test does not work. Regenerating twice and
 * comparing the two results passes a generator that reads `Date.now()`, because both calls land
 * in the same millisecond — mutation-verified: adding `generatedAt: Date.now()` to the attempt
 * report SURVIVED a back-to-back comparison. An oracle computed by the thing it is checking is
 * the defect this whole review round is about, and it had reappeared in the test written to
 * prevent it.
 *
 * A pin against a fixed literal has no such blind spot: any added field, reordered key, changed
 * indent or clock read moves the digest. Updating one is the intended friction — it means the
 * committed evidence format changed, which is exactly when a human should look.
 */
const GOLDEN = {
  "pass/pass": {
    outcome: "adopt-v2",
    "DECISION.md": "1b06f9baf7784a9afef345e85cb6389a25674c4a366ecec4429596aadf12a2fb",
    "decision.json": "8b2d93db3f364326e5ccac3a76e56d7f8515a65ce23d61289895eb0472051144",
  },
  "fail/fail": {
    outcome: "blocked",
    "DECISION.md": "394a6566fde9f08479cace2f5a03f26e05d6c39fd3dd13363db578dc82beafef",
    "decision.json": "96d5c120a109e2b9a0e6fd83d32bf2fd27556afb33dd625c04cf6a31a7dad5bd",
  },
  "not-run/pass": {
    outcome: "incomplete",
    "attempt-report.json": "7d1f155ead571d2049cf2c6dc68420da0c41431b4314b10debaf7656b3aaf279",
  },
};

test("the generators are deterministic, pinned against literals the generators did not compute", () => {
  // Byte comparison is only honest if regeneration is stable. If any generator read the clock,
  // an absolute path, or an unordered map, verification would fail on a CORRECT repository — and
  // the predictable response to a check that cries wolf is to weaken it back to outcome-equality,
  // which is what review round 12 removed the volatile-field allowlist to prevent (plan §14.1).
  let pinned = 0;
  for (const [key, expected] of Object.entries(GOLDEN)) {
    const [v2, v1] = key.split("/");
    const verified = verifiedFixture(v2, v1);
    const decision = decide(verified);
    assert.equal(decision.outcome, expected.outcome, `${key} no longer derives ${expected.outcome}`);
    const produced = artifactsFor(verified, decision);
    const names = Object.keys(expected).filter((k) => k !== "outcome");
    // The artifact SET is pinned too, not just the bytes: an outcome that silently stopped
    // writing one of its artifacts would otherwise pass on the ones it still wrote.
    assert.deepEqual(Object.keys(produced).sort(), [...names].sort(), `${key} wrote a different artifact set`);
    for (const name of names) {
      assert.equal(sha256Hex(produced[name]), expected[name], `${key} ${name} does not match its pinned digest`);
      pinned += 1;
    }
  }
  // Non-vacuity: an empty GOLDEN table, or one whose entries carried no artifacts, would satisfy
  // every assertion above without checking a single byte.
  assert.equal(Object.keys(GOLDEN).length, 3, "the golden table lost an outcome");
  assert.equal(pinned, 5, "the golden table lost an artifact");
});

test("the verify script itself runs the recorded-outcome check, not just input verification", () => {
  // The WIRING, pinned separately from the behaviour — and it had to be, because it was not
  // covered: reverting `main()` from verifyRecordedOutcome() back to verifyEvidence() left every
  // other test in this file green, since they all call the function directly. That mutation
  // survived. It is the §14.3 lesson stated as a mutation: an enforcer that `test:all` does not
  // reach is a promise rather than a gate, and this file was proving the promise.
  //
  // Run as a SUBPROCESS, against the real evidence directory, exactly as
  // `npm run verify:real-client-evidence` does.
  const proc = spawnSync(process.execPath, [join(HERE, "verify-evidence.mjs")], { encoding: "utf8" });
  assert.equal(proc.status, 2, `the verify script exited ${proc.status}; stderr: ${proc.stderr}`);
  assert.match(
    proc.stderr,
    /evidence INVALID: DECISION\.md is present, but the derived outcome is 'incomplete'/,
    "the verify script is not running the recorded-outcome check",
  );
  // Non-vacuity: a script that crashed on startup would also exit nonzero with something on
  // stderr. It must have got far enough to print nothing on stdout AND to name the artifact.
  assert.equal(proc.stdout, "", "the script emitted a verified result while refusing");
});

test("verifyRecordedOutcome refuses the repository as it actually stands", () => {
  // The end-to-end path, against the real evidence directory rather than a fixture. Today the
  // captures are stale, so the derived outcome is incomplete while DECISION.md and decision.json
  // are still committed — the state §14.1 exists to refuse. This is the assertion that has to be
  // revisited by the recapture, and it is deliberately specific about WHY it refuses so that a
  // different failure cannot silently satisfy it.
  assert.throws(
    () => verifyRecordedOutcome(),
    (error) =>
      error instanceof EvidenceError &&
      /DECISION\.md is present, but the derived outcome is 'incomplete'/.test(error.message),
    "the committed decision artifacts are no longer being checked against the evidence",
  );
});

test("a capture that executed a hostile configuration is refused, not qualified", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    // The distinction the two isolation booleans encode: an unisolated user config weakens what
    // a cell proves, but a hostile config that RAN means the client was taking instructions
    // from the fixture. There is no honest reading of that capture, so it fails closed.
    mutate("real-clients/codex-v1.manifest.json", (m) => (m.isolation.hostileConfigExecuted = true));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /ran a hostile configuration/);
  });
});

test("a manifest whose isolation record is missing or mistyped is refused", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("real-clients/codex-v1.manifest.json", (m) => (m.isolation = { userConfigIsolated: "yes" }));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /manifest\.isolation/);
  });
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("real-clients/codex-v1.manifest.json", (m) => (m.isolation = {}));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /manifest\.isolation/);
  });
});

test("with the real-client capture removed, decide() is incomplete", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    rmSync(join(evidenceDir, "real-clients"), { recursive: true, force: true });
    const verified = verifyEvidence({ evidenceDir, repoRoot });
    assert.equal(decide(verified).outcome, "incomplete");
    for (const c of ["v1", "v2"]) {
      for (const client of REAL_CLIENTS) {
        assert.equal(verified.cells[c][`real:${client}`].status, "not-run");
      }
    }
  });
});

test("a one-byte mutation of the probe source is rejected — versions and results untouched", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    const p = join(repoRoot, "spikes/mcp/probe-def.mjs");
    const bytes = Buffer.from(readFileSync(p));
    bytes[bytes.length - 2] ^= 0x01;
    writeFileSync(p, bytes);
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /probe-def\.mjs changed since capture/);
  });
});

test("a missing scripted case is rejected", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => delete s.v1.cases["cancellation"]);
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /v1\.cases has keys .* expected exactly/);
  });
});

test("an unknown scripted case is rejected", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => (s.v2.cases["bonus-case"] = { status: "pass" }));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /v2\.cases has keys .*bonus-case.* expected exactly/);
  });
});

test("a manually-supplied field on a cell is rejected", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => (s.v1.cases["initialize"].forcedStatus = "pass"));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /unknown field 'forcedStatus'/);
  });
});

test("an invalid status value is rejected", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => (s.v1.cases["initialize"].status = "mostly-pass"));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /invalid status 'mostly-pass'/);
  });
});

test("broken isolation invalidates the candidate's evidence outright", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => (s.v2.isolation.oppositeSdkProbe = "resolved"));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /isolation is broken/);
  });
});

test("a supply-chain violation fails verification — the no-hooks precondition", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("supply-chain.json", (s) => s.v1.violations.push({ package: "x@1", kind: "script:postinstall" }));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /supply chain has violations/);
  });
});

// NOTE, recorded rather than hidden: there is deliberately NO fixture here that rewrites the
// scripted case statuses wholesale and still expects verification to succeed. Such a test
// passes only because scripted statuses are recorded outcomes rather than statuses re-derived
// offline from persisted per-case protocol observations — so it would document a weakness
// while appearing to prove a strength (review round 1). The dominance claim it used to carry
// ("a fully failing matrix still cannot reach blocked while real cells are absent") is proved
// against decide() directly, above, where the inputs are synthetic by construction. Closing
// the underlying gap — persisting raw per-case transcripts and re-running the literal oracles
// inside the verifier — is tracked as follow-up work.

test("hand-fabricated real-client cells with no receipt are refused, never accepted", () => {
  // Review round 1: a cells.json alone must not complete the matrix — the verifier demands
  // the receipt and per-cell manifests it re-derives from. (The positive path — recorded
  // cells + receipt + manifests unlocking adopt-v2 — is the committed-evidence test above.)
  withFixture(({ evidenceDir, repoRoot }) => {
    rmSync(join(evidenceDir, "real-clients"), { recursive: true, force: true });
    mkdirSync(join(evidenceDir, "real-clients"), { recursive: true });
    const cell = { status: "pass", traceDigest: "0".repeat(64), clientVersion: "0.0.0-fixture" };
    writeFileSync(
      join(evidenceDir, "real-clients", "cells.json"),
      JSON.stringify({
        v1: { "claude-code": cell, codex: cell },
        v2: { "claude-code": cell, codex: cell },
      }),
    );
    // Refused at the FIRST missing support — the capture-input pin — and, once that is
    // supplied, still refused for the missing receipt. Both gates asserted, in order.
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /capture-inputs\.json is absent/);
    cpSync(
      join(EVIDENCE_DIR, "real-clients", "capture-inputs.json"),
      join(evidenceDir, "real-clients", "capture-inputs.json"),
    );
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /receipt\.json is absent/);
  });
});

test("a flipped real-client status is caught by re-derivation from the manifest", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    const p = join(evidenceDir, "real-clients", "cells.json");
    const cells = JSON.parse(readFileSync(p, "utf8"));
    cells.v1["claude-code"].status = "fail";
    writeFileSync(p, JSON.stringify(cells, null, 2));
    assert.throws(
      () => verifyEvidence({ evidenceDir, repoRoot }),
      /records status 'fail' but the manifest re-derives 'pass'/,
    );
  });
});

test("a missing sanitized manifest is refused", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    rmSync(join(evidenceDir, "real-clients", "codex-v2.manifest.json"));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /manifest is absent/);
  });
});

test("a receipt whose digests disagree with the manifest is refused", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    const p = join(evidenceDir, "real-clients", "receipt.json");
    const receipts = JSON.parse(readFileSync(p, "utf8"));
    receipts[0].reproduced.derivationDigest = "0".repeat(64);
    writeFileSync(p, JSON.stringify(receipts, null, 2));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /disagree with the manifest/);
  });
});

test("a duplicated key in an evidence file is refused — JSON.parse's last-wins is not accepted", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    const p = join(evidenceDir, "token-cost.json");
    const text = readFileSync(p, "utf8");
    // Duplicate the proxyVersion key: one value for a human reader, one for the machine.
    writeFileSync(p, text.replace('"proxyVersion":', '"proxyVersion": "decoy/v0", "proxyVersion":'));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /duplicate key 'proxyVersion'/);
  });
});

test("an unknown field on a candidate record is refused at the top level too", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => (s.v1.reviewedBy = "nobody"));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /unknown field 'reviewedBy'/);
  });
});

test("a tampered token count that no longer follows from the recorded bytes is refused", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("token-cost.json", (t) => (t.v2.proxyTokens = 1));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /does not follow from canonicalBytes/);
  });
});

test("an inconsistent failed count on a candidate record is refused", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => (s.v1.failed = 7));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /inconsistent/);
  });
});

test("a changed capture input makes the real cells not-run — captures are never re-bound silently", () => {
  // The scripted matrix recomputes inputs.json every run. Without the separately pinned
  // capture-input record, a re-run would bind today's bytes to yesterday's paid captures.
  withFixture(({ evidenceDir, repoRoot }) => {
    const p = join(evidenceDir, "real-clients", "capture-inputs.json");
    const ci = JSON.parse(readFileSync(p, "utf8"));
    ci.files["spikes/mcp/real-client/sanitize.mjs"] = "0".repeat(64);
    writeFileSync(p, JSON.stringify(ci, null, 2));
    const verified = verifyEvidence({ evidenceDir, repoRoot });
    for (const c of ["v1", "v2"]) {
      for (const client of REAL_CLIENTS) {
        const cell = verified.cells[c][`real:${client}`];
        assert.equal(cell.status, "not-run", `${c}/${client} survived a changed capture input`);
        // The file this test changed must be NAMED. Matching the whole message pinned it to
        // being the only stale input, which stopped being true the moment another capture input
        // was edited in the same review.
        assert.match(cell.cause, /sanitize\.mjs/);
        assert.match(cell.cause, /changed since these captures were taken/);
        assert.ok(!/[0-9a-f]{64}/.test(cell.cause), "the cause leaked a digest value instead of naming the file");
      }
    }
    assert.equal(decide(verified).outcome, "incomplete", "a stale capture must force a recapture, not a verdict");
  });
});

test("real-client cells present with no capture-input record are refused", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    rmSync(join(evidenceDir, "real-clients", "capture-inputs.json"));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /capture-inputs\.json is absent/);
  });
});

test("the capture-input set excludes the classifier — a change there re-derives, never invalidates", () => {
  // classify.mjs is re-run live by the verifier over the recorded manifest, so it is a
  // consumer, not a capture input. Pinning it would force a paid recapture for a pure
  // refactor of the classifier.
  assert.ok(!CAPTURE_INPUTS.includes("spikes/mcp/real-client/classify.mjs"));
  assert.ok(!CAPTURE_INPUTS.includes("spikes/mcp/real-client/receipt.mjs"));
  for (const rel of ["spikes/mcp/probe-def.mjs", "spikes/mcp/real-client/capture.mjs", "spikes/mcp/real-client/sanitize.mjs"]) {
    assert.ok(CAPTURE_INPUTS.includes(rel), `${rel} must be pinned at capture time`);
  }
});

test("a present matrix attempt marker makes the whole evidence set unconsumable", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    writeFileSync(
      join(evidenceDir, "matrix-attempt.json"),
      JSON.stringify({ status: "failed", failures: [{ candidate: "v1", stage: "install", cause: "x" }] }),
    );
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /did not complete; regenerate/);
  });
});

// An INDEPENDENT literal of the producers this project expects to be digest-bound. Iterating
// BOUND_INPUTS alone would silently stop checking a producer that was dropped from the list
// (review round 1); this list is the oracle, and the equality assertion below is the guard.
const EXPECTED_BOUND_PRODUCERS = [
  "spikes/mcp/probe-def.mjs",
  "spikes/mcp/candidates/v1/server.mjs",
  "spikes/mcp/candidates/v2/server.mjs",
  "spikes/mcp/candidates/v1/package.json",
  "spikes/mcp/candidates/v2/package.json",
  "spikes/mcp/candidates/v1/package-lock.json",
  "spikes/mcp/candidates/v2/package-lock.json",
  "spikes/mcp/conformance.mjs",
  "spikes/mcp/isolate.mjs",
  "spikes/mcp/instrument.mjs",
  "spikes/mcp/instrument-hooks.mjs",
  "spikes/mcp/token-cost.mjs",
  "spikes/mcp/supply-chain.mjs",
  "spikes/mcp/matrix.mjs",
  "spikes/mcp/real-client/capture.mjs",
  "spikes/mcp/real-client/capture-wrapper.mjs",
  "spikes/mcp/real-client/classify.mjs",
  "spikes/mcp/real-client/normalize.mjs",
  "spikes/mcp/real-client/sanitize.mjs",
  "spikes/mcp/real-client/receipt.mjs",
  "spikes/mcp/real-client/provenance.mjs",
  "scripts/direct-entry.mjs",
  "scripts/privacy-scan.mjs",
  "scripts/privacy-synthetic.json",
];

test("the bound-input list equals this suite's independent literal — nothing dropped silently", () => {
  assert.deepEqual([...BOUND_INPUTS].sort(), [...EXPECTED_BOUND_PRODUCERS].sort());
});

test("every capture input is also a bound input — a capture-time pin the evidence never checks", () => {
  // The two lists answer different questions (what a re-capture would invalidate vs what any
  // evidence depends on), but the first is a subset of the second. A file pinned only at
  // capture time would go unverified on every scripted run.
  for (const rel of CAPTURE_INPUTS) {
    assert.ok(BOUND_INPUTS.includes(rel), `${rel} is pinned at capture time but is not a bound input`);
  }
});

test("EVERY bound producer's digest is enforced — a stale recorded digest for each file refuses", () => {
  // Review round 1: each evidence-producing input must independently invalidate stale
  // evidence. One fixture per producer, corrupting only that file's recorded digest, driven
  // from the INDEPENDENT literal above.
  for (const rel of EXPECTED_BOUND_PRODUCERS) {
    withFixture(({ evidenceDir, repoRoot, mutate }) => {
      mutate("inputs.json", (i) => (i.files[rel] = "0".repeat(64)));
      assert.throws(
        () => verifyEvidence({ evidenceDir, repoRoot }),
        /changed since capture/,
        `bound input ${rel} did not enforce staleness`,
      );
    });
  }
});

test("the committed matrix recorded every scripted case for both candidates", () => {
  const scripted = JSON.parse(readFileSync(join(EVIDENCE_DIR, "scripted.json"), "utf8"));
  for (const c of ["v1", "v2"]) {
    assert.deepEqual(Object.keys(scripted[c].cases).sort(), [...SCRIPTED_CASES].sort());
  }
});

test("no short-circuit: an early stage failure stops NOTHING but its own dependents", async () => {
  // An all-green record proves nothing about short-circuiting — a short-circuiting
  // orchestrator produces exactly the same one (review round 1). So inject a real failure
  // into v1's FIRST stage and require that v1's independent stages, and every v2 stage,
  // still produced typed results.
  const ran = [];
  const stages = [
    {
      name: "supply-chain",
      run: (c) => {
        ran.push(`${c}:supply-chain`);
        if (c === "v1") throw new Error("injected first-stage failure");
        return { ok: true };
      },
    },
    { name: "install", needs: "supply-chain", run: (c) => (ran.push(`${c}:install`), { ok: true }) },
    { name: "installed-rescan", needs: "install", run: (c) => (ran.push(`${c}:installed-rescan`), { ok: true }) },
    { name: "audit", run: (c) => (ran.push(`${c}:audit`), { ok: true }) },
    { name: "conformance", needs: "installed-rescan", run: (c) => (ran.push(`${c}:conformance`), { ok: true }) },
  ];
  const results = await runStages(["v1", "v2"], stages);

  // Every stage of every candidate has a typed record — nothing silently absent.
  for (const c of ["v1", "v2"]) {
    assert.deepEqual(Object.keys(results[c]), stages.map((s) => s.name), `${c} lost a stage record`);
  }
  assert.equal(results.v1["supply-chain"].status, "failed");
  assert.match(results.v1["supply-chain"].cause, /injected first-stage failure/);
  // Dependents are not-run WITH A CAUSE, never silently skipped.
  for (const dependent of ["install", "installed-rescan", "conformance"]) {
    assert.equal(results.v1[dependent].status, "not-run", `${dependent} should be not-run`);
    assert.match(results.v1[dependent].cause, /prerequisite stage/);
  }
  // The independent stage still ran for the FAILED candidate...
  assert.equal(results.v1.audit.status, "ok");
  assert.ok(ran.includes("v1:audit"), "an independent stage was skipped after a sibling failed");
  // ...and the other candidate ran completely.
  for (const name of stages.map((s) => s.name)) {
    assert.equal(results.v2[name].status, "ok", `v2/${name} was lost to v1's failure`);
  }
});

test("no short-circuit: a mid-chain failure still leaves every later independent stage recorded", async () => {
  const stages = [
    { name: "supply-chain", run: () => ({ ok: true }) },
    { name: "install", needs: "supply-chain", run: (c) => {
      if (c === "v2") throw new Error("injected install failure");
      return { ok: true };
    } },
    { name: "installed-rescan", needs: "install", run: () => ({ ok: true }) },
    { name: "audit", run: () => ({ ok: true }) },
  ];
  const results = await runStages(["v1", "v2"], stages);
  assert.equal(results.v1["installed-rescan"].status, "ok");
  assert.equal(results.v2.install.status, "failed");
  assert.equal(results.v2["installed-rescan"].status, "not-run");
  assert.equal(results.v2.audit.status, "ok");
  for (const name of stages.map((s) => s.name)) assert.equal(results.v1[name].status, "ok");
});

test("the production stage list declares the install chain its scripted stages depend on", () => {
  // The injected-stage tests above prove the RUNNER; this pins the real wiring, so a stage
  // that quietly loses its `needs` cannot let conformance run against an unverified tree.
  const stages = buildStages();
  assert.deepEqual(stages.map((s) => s.name), [
    "supply-chain",
    "install",
    "installed-rescan",
    "audit",
    "conformance",
    "token-measure",
  ]);
  const needs = Object.fromEntries(stages.map((s) => [s.name, s.needs ?? null]));
  assert.equal(needs["install"], "supply-chain");
  assert.equal(needs["installed-rescan"], "install");
  assert.equal(needs["conformance"], "installed-rescan");
  assert.equal(needs["token-measure"], "installed-rescan");
  assert.equal(needs["audit"], null, "the advisory audit must not depend on the install chain");
});

// ---------- a stage's result must be acceptable, not merely thrown-free (round 2, chunk 13) --
//
// `inspectClosure` and `scanInstalledTree` report violations by RETURNING them. Status `ok`
// meant "did not throw", so a closure known to declare `postinstall` was `ok`, `npm ci` ran,
// and the conformance cases and the token measurement EXECUTED that tree — the violations
// reached the exit code long after the code had run.

test("a stage whose result is refused blocks everything that depends on it", async () => {
  const ran = [];
  const stages = [
    {
      name: "supply-chain",
      run: (c) => {
        ran.push(`${c}:supply-chain`);
        return { packages: 1, verified: 1, violations: c === "v1" ? [{ package: "e@1", kind: "script:postinstall" }] : [] };
      },
      validate: (v) => (v.violations.length ? `locked closure: ${v.violations.length} violation(s)` : null),
    },
    { name: "install", needs: "supply-chain", run: (c) => (ran.push(`${c}:install`), { ok: true }) },
    { name: "conformance", needs: "install", run: (c) => (ran.push(`${c}:conformance`), { ok: true }) },
    { name: "audit", run: (c) => (ran.push(`${c}:audit`), { ok: true }) },
  ];
  const results = await runStages(["v1", "v2"], stages);

  assert.equal(results.v1["supply-chain"].status, "refused");
  assert.match(results.v1["supply-chain"].cause, /violation/);
  assert.ok(results.v1["supply-chain"].value, "the refused record must keep what it was refused for");
  assert.ok(!ran.includes("v1:install"), "an unsafe closure was installed");
  assert.ok(!ran.includes("v1:conformance"), "an unsafe tree was EXECUTED");
  // The refusal is this candidate's, and it is not a short circuit: independent stages and the
  // other candidate are untouched.
  assert.equal(results.v1.audit.status, "ok");
  for (const name of stages.map((s) => s.name)) assert.equal(results.v2[name].status, "ok");
});

test("the real supply-chain and rescan stages refuse a result carrying violations", () => {
  const stages = Object.fromEntries(buildStages().map((s) => [s.name, s]));
  for (const name of ["supply-chain", "installed-rescan"]) {
    const clean = { packages: 1, verified: 1, packagesScanned: 1, violations: [] };
    assert.equal(stages[name].validate(clean), null, `${name} refused a clean result`);
    const dirty = { ...clean, violations: [{ package: "e@1", kind: "script:postinstall" }] };
    assert.match(stages[name].validate(dirty), /script:postinstall/, `${name} accepted a violation`);
  }
});

test("a stage that returns nothing is a failure, not a success with no result", async () => {
  // It used to be `ok` with `value: undefined`; main() then wrote no record for it, found no
  // stage failure, and could publish an evidence file containing `{}` and exit zero.
  const results = await runStages(["v1"], [
    { name: "supply-chain", run: () => undefined },
    { name: "install", needs: "supply-chain", run: () => ({ ok: true }) },
  ]);
  assert.equal(results.v1["supply-chain"].status, "failed");
  assert.match(results.v1["supply-chain"].cause, /returned no result/);
  assert.equal(results.v1.install.status, "not-run");

  const nulled = await runStages(["v1"], [{ name: "supply-chain", run: () => null }]);
  assert.equal(nulled.v1["supply-chain"].status, "failed");
});

test("conformance validation recomputes 'failed' instead of trusting it", () => {
  const cases = { a: { status: "pass" }, b: { status: "fail" } };
  // Case failures are EVIDENCE and must publish, so a consistent failing record is accepted.
  assert.equal(validateConformance({ cases, failed: 1, isolation: { ok: true } }), null);
  assert.equal(validateConformance({ cases: { a: { status: "pass" } }, failed: 1, isolation: { ok: false } }), null);
  // Broken isolation counts as one more failure, exactly as runCandidate records it.
  assert.equal(validateConformance({ cases, failed: 2, isolation: { ok: false } }), null);
  // What must refuse is a record that cannot be read at face value.
  assert.match(validateConformance({ cases, failed: 0, isolation: { ok: true } }), /recompute to 1/);
  assert.match(validateConformance({ cases, failed: 1, isolation: { ok: false } }), /recompute to 2/);
  for (const bad of [undefined, null, -1, 1.5, "1", Infinity]) {
    assert.match(
      validateConformance({ cases, failed: bad, isolation: { ok: true } }),
      /not a count|recompute/,
      `failed=${String(bad)} was accepted`,
    );
  }
  assert.match(validateConformance({ cases, failed: 1 }), /no isolation verdict/);
  assert.match(validateConformance({ failed: 0, isolation: { ok: true } }), /no case records/);
});

test("broken isolation is a failure for the exit code in its own right", () => {
  // stderr printed "isolation BROKEN" while the process could exit 0, because the only term
  // was `conf.failed > 0` — and `undefined > 0` is false.
  const cases = { a: { status: "pass" } };
  assert.equal(candidateFailed({ cases, failed: 0, isolation: { ok: true } }), false);
  assert.equal(candidateFailed({ cases, failed: 1, isolation: { ok: true } }), true);
  assert.equal(candidateFailed({ cases, failed: 0, isolation: { ok: false } }), true);
  assert.equal(candidateFailed({ cases, failed: undefined, isolation: undefined }), true);
});

test("a measurement with no proxy version or a non-count is refused", () => {
  const good = { proxyVersion: "bytes-div-4/v1", canonicalBytes: 8, proxyTokens: 2 };
  assert.equal(validateMeasurement(good), null);
  assert.match(validateMeasurement({ ...good, proxyVersion: "" }), /no proxy version/);
  assert.match(validateMeasurement({ ...good, canonicalBytes: Infinity }), /'canonicalBytes'/);
  assert.match(validateMeasurement({ ...good, proxyTokens: -1 }), /'proxyTokens'/);
});

// ---------- `npm audit` that did not audit (round 2, chunk 13) -------------------------------

test("an npm-audit error envelope is recorded as not-run, never as a clean audit", () => {
  // npm prints well-formed JSON and exits 0 when it REFUSES to audit. The old reader parsed
  // that, found no metadata, defaulted to {} and recorded `ran: true, advisoriesTotal: 0` —
  // "audit ran (0 advisories)" for a command that audited nothing.
  const envelope = JSON.stringify({ error: { code: "ENOLOCK", summary: "This command requires an existing lockfile." } });
  const r = readAuditResult({ stdout: envelope, stderr: "", status: 0 });
  assert.equal(r.ran, false);
  assert.match(r.cause, /ENOLOCK/);
  assert.equal(r.advisoriesTotal, undefined, "a refused audit must not carry a count");
});

test("a real audit result is recorded, including a nonzero exit — that is what finding things looks like", () => {
  // The exit status cannot be the test: npm exits NONZERO precisely when the audit succeeded
  // and found vulnerabilities.
  const stdout = JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 2, moderate: 1, high: 0, critical: 0 } } });
  const r = readAuditResult({ stdout, stderr: "", status: 1 });
  assert.deepEqual(r, {
    ran: true,
    vulnerabilities: { info: 0, low: 2, moderate: 1, high: 0, critical: 0 },
    advisoriesTotal: 3,
  });
});

test("audit output that carries no vulnerability counts is not an audit", () => {
  for (const stdout of ["{}", '{"metadata":{}}', '{"metadata":{"vulnerabilities":{}}}', '{"metadata":{"vulnerabilities":[]}}']) {
    assert.equal(readAuditResult({ stdout, stderr: "", status: 0 }).ran, false, `accepted ${stdout}`);
  }
  assert.equal(readAuditResult({ stdout: "not json", stderr: "boom", status: 1 }).ran, false);
  assert.equal(readAuditResult({ stdout: "", error: new Error("spawn ENOENT"), status: null }).ran, false);
  // A count that is not a count is not a count. Written as a literal because JSON.stringify
  // turns Infinity into null and would prove something else.
  const bad = '{"metadata":{"vulnerabilities":{"low":1e999}}}';
  assert.equal(JSON.parse(bad).metadata.vulnerabilities.low, Infinity, "premise: this parses to Infinity");
  assert.equal(readAuditResult({ stdout: bad, stderr: "", status: 0 }).ran, false);
});

// ---------- publication actually validates what it publishes (round 2, chunk 13) ------------
//
// The header said "renamed into place only after the whole generation validated" while the
// code wrote five files and renamed them with nothing in between.

test("a generation is validated off disk before anything is renamed into place", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-fixture-"));
  try {
    writeFileSync(join(dir, "a.json"), '{"previous":"generation"}\n');
    assert.throws(
      () =>
        publishGeneration(
          { "a.json": { fresh: 1 }, "b.json": { fresh: 2 } },
          {
            dir,
            // A short write is what the read-back exists to catch: the bytes on disk are not
            // the bytes that were meant to be there.
            tamper: (staged) => writeFileSync(staged[0].tmp, staged[0].text.slice(0, 4)),
          },
        ),
      /a\.json: staged file did not read back as written/,
    );
    // Nothing was published, and nothing was left behind to be published later by accident.
    assert.equal(readFileSync(join(dir, "a.json"), "utf8"), '{"previous":"generation"}\n', "destination was touched");
    assert.ok(!existsSync(join(dir, "b.json")), "a sibling file was published from a refused generation");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".staging")), [], "staging files survived a refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a generation that validates is published whole, with no staging left behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-fixture-"));
  try {
    publishGeneration({ "a.json": { b: 2, a: 1 }, "b.json": [3, 1, 2] }, { dir });
    assert.deepEqual(readdirSync(dir).sort(), ["a.json", "b.json"]);
    // sortDeep is applied, and array order survives it.
    assert.equal(readFileSync(join(dir, "a.json"), "utf8"), '{\n  "a": 1,\n  "b": 2\n}\n');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "b.json"), "utf8")), [3, 1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- token plumbing, fixed vectors ---------------------------------------------------

test("canonicalization sorts keys recursively and keeps array order", () => {
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}');
});

test("the token proxy is the pinned version with fixed known vectors", () => {
  assert.equal(TOKEN_PROXY_VERSION, "bytes-div-4/v1");
  assert.equal(proxyTokens(""), 0);
  assert.equal(proxyTokens("abcd"), 1);
  assert.equal(proxyTokens("abcde"), 2);
  const measured = measureToolDefinition({ name: "t", inputSchema: { b: 1, a: 2 } });
  assert.equal(measured.canonicalBytes, canonicalize({ inputSchema: { a: 2, b: 1 }, name: "t" }).length);
  assert.equal(measured.proxyTokens, Math.ceil(measured.canonicalBytes / 4));
  assert.deepEqual(measured.fields, ["inputSchema", "name"]);
});

test("the byte count is UTF-8 bytes, not code units — a non-ASCII vector with a literal expectation", () => {
  // ASCII-only vectors cannot tell Buffer.byteLength from String.length (review round 1).
  // {"name":"é中🙂"} is 11 ASCII bytes of syntax and key, plus 2 + 3 + 4 bytes of value = 20.
  const measured = measureToolDefinition({ name: "é中🙂" });
  assert.equal(measured.canonicalBytes, 20);
  assert.equal(canonicalize({ name: "é中🙂" }).length, 15, "code-unit length, which must NOT be what is recorded");
  assert.equal(measured.proxyTokens, Math.ceil(20 / 4));
  assert.equal(proxyTokens("é"), 1); // 2 bytes -> ceil(2/4)
  assert.equal(proxyTokens("🙂🙂"), 2); // 8 bytes -> 2
});

test("REAL_CLIENTS and EvidenceError are the exported shapes act2 tooling will rely on", () => {
  assert.deepEqual(REAL_CLIENTS, ["claude-code", "codex"]);
  assert.ok(new EvidenceError("x") instanceof Error);
});

// ---------------------------------------------------------------------------
// Review round 2, chunk 11: read-backs that reported success without having
// observed the thing they claim to check.
// ---------------------------------------------------------------------------

test("a blocker list that is a STRING is refused, not substring-matched", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps();
  const inner = deps.graph.readTicket;
  deps.graph.readTicket = (id) => {
    // `("T-9001").includes("T-900")` is true, so the transaction used to complete cleanly
    // having never seen a blocker LIST at all — T-013 was not blocked by anything.
    if (id === "T-013") return { id, blockedBy: "T-9001" };
    return inner(id);
  };
  await assert.rejects(() => act1(decide(verified), verified, deps), (e) => {
    assert.equal(e.step, "read-back-t013");
    assert.match(e.message, /not an array/);
    return true;
  });
});

test("a blocker list that merely contains the id as a substring is refused", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps();
  const inner = deps.graph.readTicket;
  deps.graph.readTicket = (id) => (id === "T-013" ? { id, blockedBy: ["T-9001"] } : inner(id));
  await assert.rejects(() => act1(decide(verified), verified, deps), /does not contain T-900/);
});

test("a T-013 read-back that is not an object is a transition error, not a TypeError", async () => {
  for (const bad of [null, "T-013", ["T-013"], 7]) {
    const verified = verifiedFixture("fail", "fail");
    const deps = spyDeps();
    const inner = deps.graph.readTicket;
    deps.graph.readTicket = (id) => (id === "T-013" ? bad : inner(id));
    await assert.rejects(
      () => act1(decide(verified), verified, deps),
      (e) => {
        assert.equal(e.constructor.name, "TransitionError", `${JSON.stringify(bad)} escaped as ${e.constructor.name}`);
        return true;
      },
    );
  }
});

test("a resolution ticket read back with no status is not treated as open", async () => {
  const verified = verifiedFixture("fail", "fail");
  // `["done","cancelled"].includes(undefined)` is false, so a ticket whose state was never
  // reported used to read as open and get attached as T-013's blocker.
  const deps = spyDeps({
    resolutionTicketBack: { id: "T-900", title: "No supported MCP SDK (T-009:no-supported-sdk:5:2.0.0/6:1.30.0)" },
  });
  await assert.rejects(() => act1(decide(verified), verified, deps), /no usable status/);
});

test("a read-back for a DIFFERENT ticket is refused even when its title is canonical", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps({
    resolutionTicketBack: {
      id: "T-901",
      title: "No supported MCP SDK (T-009:no-supported-sdk:5:2.0.0/6:1.30.0)",
      status: "open",
    },
  });
  // The id that gets attached to T-013 is the located/created one, so a read-back of some
  // other ticket verified nothing about it.
  await assert.rejects(() => act1(decide(verified), verified, deps), /not the "T-900" that was located or created/);
});

test("malformed evidence refuses as a transition error, not an uncaught Error", async () => {
  const verified = verifiedFixture("fail", "fail");
  delete verified.cells.v2["scripted:initialize"];
  await assert.rejects(
    () => act1({ outcome: "blocked", aggregates: { v2: "fail", v1: "fail" } }, verified, spyDeps()),
    (e) => {
      assert.equal(e.constructor.name, "TransitionError");
      assert.equal(e.step, "decision-recompute");
      return true;
    },
  );
});

test("the dedupe key cannot be forged by a version that contains the separator", () => {
  // `+` is legal inside SemVer build metadata, so joining the pair with it was ambiguous:
  // (1.0.0+2.0.0, 3.0.0) and (1.0.0, 2.0.0+3.0.0) produced the same key, and a later blocked
  // decision would have reused the wrong resolution ticket.
  assert.notEqual(
    versionTuple({ v2: "1.0.0+2.0.0", v1: "3.0.0" }),
    versionTuple({ v2: "1.0.0", v1: "2.0.0+3.0.0" }),
  );
  assert.notEqual(versionTuple({ v2: "1/2", v1: "3" }), versionTuple({ v2: "1", v1: "2/3" }));
  assert.equal(versionTuple({ v2: "2.0.0", v1: "1.30.0" }), "5:2.0.0/6:1.30.0");
});

test("every line terminator and a literal backslash-pipe are neutralised in the document", () => {
  const verified = verifiedFixture("fail", "fail");
  verified.report.notes = [
    "carriage\rreturn",
    "line separator",
    "paragraph separator",
    "a\\|b split",
    "bidi‮override",
  ];
  const doc = renderDecisionDoc(verified, decide(verified));
  for (const [name, ch] of [["CR", "\r"], ["U+2028", " "], ["U+2029", " "], ["bidi", "‮"]]) {
    assert.ok(!doc.includes(ch), `${name} survived into the decision document`);
  }
  // The backslash is escaped FIRST, so what follows is a literal pipe inside the cell rather
  // than an escaped backslash followed by a live table delimiter.
  assert.ok(doc.includes("a\\\\\\|b split"), `backslash-pipe was not neutralised: ${JSON.stringify(doc.slice(-400))}`);
});

// ---------------------------------------------------------------------------
// Review round 2, chunk 12: the verifier is the last guard. Everything else in
// this pipeline is bypassed at once if it can be made to return a clean result.
// ---------------------------------------------------------------------------

test("an inherited Object.prototype name is an unknown field, not a declared one", () => {
  // `key in spec` consults the prototype chain, so `constructor` and `toString` read as
  // DECLARED — and Object.entries(spec) never iterates them, so their values went unchecked
  // too. A record could carry them through a primitive whose contract is an exact field set.
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    for (const field of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      mutate("token-cost.json", (t) => {
        for (const k of ["constructor", "toString", "valueOf", "hasOwnProperty"]) delete t.v2[k];
        t.v2[field] = "smuggled";
      });
      assert.throws(
        () => verifyEvidence({ evidenceDir, repoRoot }),
        new RegExp(`carries unknown field '${field}'`),
        `${field} was accepted as a declared field`,
      );
    }
  });
});

test("a count that is not a non-negative integer is refused", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    // 1e999 parses to Infinity, and Math.ceil(Infinity / 4) === Infinity — so the token-cost
    // arithmetic check passed on a number that means nothing.
    const p = join(evidenceDir, "token-cost.json");
    const raw = readFileSync(p, "utf8");
    writeFileSync(p, raw.replace(/"canonicalBytes":\s*\d+/, '"canonicalBytes": 1e999'));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /not a non-negative integer/);

    for (const bad of [-1, 0.5]) {
      mutate("supply-chain.json", (sc) => (sc.v2.packages = bad));
      assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /not a non-negative integer/);
      mutate("supply-chain.json", (sc) => (sc.v2.packages = sc.v2.verified));
    }
  });
});

test("an installed-tree rescan that covered part of the closure is refused", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    // `packagesScanned > 0` let a record claim 93 verified packages while the rescan — the
    // check that the bytes on disk carry no install hooks — looked at one of them.
    mutate("supply-chain.json", (sc) => (sc.v2.installedRescan.packagesScanned = 1));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /rescan covered 1 of \d+ packages/);
  });
});

test("per-case isolation records are read, not merely counted", () => {
  // Every one of these leaves the aggregate booleans — ok, everyCaseInstrumented — saying the
  // run was clean, which is exactly what made counting the keys and trusting the aggregate a
  // check that observed nothing. A FRESH fixture per case: they are alternatives, not a
  // sequence, and mutating one on top of the last tests a record no run can produce.
  const cases = [
    [(iso) => (iso.perCase["initialize"] = { error: "boom" }), /isolation was not observed: boom/],
    [(iso) => (iso.perCase["initialize"].total = 0), /enumerated zero resolutions/],
    [(iso) => (iso.perCase["initialize"].violations = 3), /resolved 3 module\(s\) outside its root/],
    [(iso) => (iso.perCase["initialize"].descendants = 1), /uninstrumented descendant/],
    [(iso) => (iso.perCase["initialize"].sdkResolutions = 0), /did not exercise it/],
  ];
  for (const [break_, pattern] of cases) {
    withFixture(({ evidenceDir, repoRoot, mutate }) => {
      mutate("scripted.json", (s) => break_(s.v2.isolation));
      assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), pattern);
    });
  }
});

test("the isolation total must follow from the per-case records", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => (s.v2.isolation.resolutionsTotal += 1));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /per-case records sum to/);
  });
});

test("which clients can isolate their user configuration is a literal, not a manifest claim", () => {
  // The integration path — a codex manifest asserting userConfigIsolated:true — cannot be
  // exercised while the real cells are not-run pending recapture, because the manifest is never
  // read. What IS pinned now is the table the check consults, so a silent edit of it fails here.
  // The end-to-end refusal is covered once the captures are retaken.
  assert.deepEqual(CAN_ISOLATE_USER_CONFIG, { "claude-code": true, codex: false });
  assert.equal(
    CAN_ISOLATE_USER_CONFIG.codex,
    false,
    "codex exec -c has no equivalent of --strict-mcp-config plus --settings; claiming otherwise drops the qualification",
  );
});
