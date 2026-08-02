// Tests for decide()/act1 (plan §1), the evidence verifier (§6) and the token plumbing (§7).
//
// Runs under `node --test` or directly (`node spikes/mcp/decide.test.mjs`); test:mcp-spike
// uses direct execution. (An earlier runner hang traced to mutant-server.mjs executing on
// import; it is fixed — see conformance.test.mjs.)

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  TransitionError,
} from "./decide.mjs";
import { verifyEvidence, BOUND_INPUTS, EVIDENCE_DIR, EvidenceError } from "./verify-evidence.mjs";
import { canonicalize, proxyTokens, measureToolDefinition, TOKEN_PROXY_VERSION } from "./token-cost.mjs";
import { runStages, buildStages } from "./matrix.mjs";
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
              title: "No supported MCP SDK (T-009:no-supported-sdk:2.0.0+1.30.0)",
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
    "locate:T-009:no-supported-sdk:2.0.0+1.30.0",
    "create:T-009:no-supported-sdk:2.0.0+1.30.0",
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
    "locate:T-009:no-supported-sdk:2.0.0+1.30.0",
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
      title: "No supported MCP SDK (T-009:no-supported-sdk:2.0.0+1.30.0)",
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
  // The recorded verdict, pinned: both candidates pass everywhere, so the ticket's own
  // go/no-go answers adopt-v2 — v1 is unselected, not failed. A future recapture that
  // changes this must change this line WITH the evidence, never instead of it.
  assert.equal(decide(verified).outcome, "adopt-v2");
  // The Codex cells passed with the operator's own configuration reachable — a real pass, but
  // not a fresh-state one. Pinned here because it is the caveat most likely to be quietly lost:
  // the run succeeded, so nothing downstream has a reason to mention it (review round 1,
  // chunk 17). If a recapture ever isolates Codex, this expectation is what has to change.
  assert.deepEqual(
    verified.report.qualifications.map((q) => `${q.candidate}/${q.cell}:${q.kind}`).sort(),
    ["v1/real:codex:user-config-not-isolated", "v2/real:codex:user-config-not-isolated"],
  );
});

test("a cell that ran without user-config isolation is qualified, not silently passed", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    // Flip the one client that IS isolated today. If the qualification were hardcoded to Codex,
    // or read from anywhere but the manifest, this would not move.
    mutate("real-clients/claude-code-v2.manifest.json", (m) => (m.isolation.userConfigIsolated = false));
    const verified = verifyEvidence({ evidenceDir, repoRoot });
    assert.ok(
      verified.report.qualifications.some((q) => q.candidate === "v2" && q.cell === "real:claude-code"),
      "an unisolated capture produced no qualification",
    );
    // Still a pass and still adopt-v2: the qualification records what the cell proves, it does
    // not overrule the classifier that judged it.
    assert.equal(verified.cells.v2["real:claude-code"].status, "pass");
    assert.equal(decide(verified).outcome, "adopt-v2");
  });
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
