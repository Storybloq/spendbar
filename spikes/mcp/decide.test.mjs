// Tests for decide()/act1 (plan §1), the evidence verifier (§6) and the token plumbing (§7).
//
// RUN DIRECTLY (`node spikes/mcp/decide.test.mjs`) — see conformance.test.mjs for why.

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

test("aggregate: not-run dominates fail, fail dominates pass, a full pass is pass", () => {
  assert.equal(aggregate(cellsAll("pass")), "pass");
  assert.equal(aggregate(withCell(cellsAll("pass"), "scripted:cancellation", "fail")), "fail");
  assert.equal(aggregate(withCell(cellsAll("fail"), "real:codex", "not-run")), "not-run");
  assert.equal(aggregate(withCell(cellsAll("pass"), "real:claude-code", "not-run")), "not-run");
});

test("aggregate refuses an absent or malformed cell — the verifier's job, asserted twice", () => {
  const missing = cellsAll("pass");
  delete missing["real:codex"];
  assert.throws(() => aggregate(missing), /absent or malformed/);
  assert.throws(() => aggregate(withCell(cellsAll("pass"), "real:codex", "maybe")), /absent or malformed/);
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

function verifiedFixture(v2Status, v1Status) {
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
    },
  };
}

function spyDeps({ existingTicket = null, failAt = null, blockedByAfterAttach = true } = {}) {
  const calls = [];
  const fail = (step) => {
    if (failAt === step) throw new Error(`injected ${step} failure`);
  };
  const ticket = { id: "T-900" };
  return {
    calls,
    docs: [],
    reports: [],
    writeDecisionDoc(doc) {
      calls.push("decision-doc");
      fail("decision-doc");
      this.docs.push(doc);
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
  assert.ok(deps.calls.every((c) => c === "attempt-report"), `graph was touched: ${deps.calls}`);
});

test("act1 on adopt-v2: decision document only — no ticket, no blocker", async () => {
  const verified = verifiedFixture("pass", "pass");
  const deps = spyDeps();
  const r = await act1(decide(verified), verified, deps);
  assert.equal(r.exitCode, 0);
  assert.equal(deps.docs.length, 1);
  assert.ok(deps.docs[0].includes("adopt-v2"));
  assert.ok(deps.docs[0].includes("open question 3, an owner decision"));
  assert.deepEqual(deps.calls, ["decision-doc"]);
});

test("act1 on blocked: dedupe-keyed ticket, attach, read-back, then the document, exit 3", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps();
  const r = await act1(decide(verified), verified, deps);
  assert.equal(r.exitCode, EXIT_CODES.blocked);
  assert.deepEqual(deps.calls, [
    "locate:T-009:no-supported-sdk:2.0.0+1.30.0",
    "create:T-009:no-supported-sdk:2.0.0+1.30.0",
    "attach:T-013:T-900",
    "read:T-013",
    "decision-doc",
  ]);
  assert.equal(deps.docs.length, 1);
});

test("act1 on blocked is idempotent: an existing open ticket is reused, never duplicated", async () => {
  const verified = verifiedFixture("fail", "fail");
  const deps = spyDeps({ existingTicket: { id: "T-900" } });
  await act1(decide(verified), verified, deps);
  assert.ok(!deps.calls.some((c) => c.startsWith("create:")), `created a duplicate: ${deps.calls}`);
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

test("act1: an injected failure at each step surfaces as that step's transition error", async () => {
  const verified = verifiedFixture("fail", "fail");
  for (const step of [
    "locate-resolution-ticket",
    "create-resolution-ticket",
    "attach-blocker",
    "read-back-t013",
    "decision-doc",
  ]) {
    const deps = spyDeps({ failAt: step });
    await assert.rejects(
      () => act1(decide(verified), verified, deps),
      (e) => e instanceof TransitionError && e.step === step && e.exitCode === EXIT_CODES.transitionError,
      `step ${step}`,
    );
  }
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
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /missing case 'cancellation'/);
  });
});

test("an unknown scripted case is rejected", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    mutate("scripted.json", (s) => (s.v2.cases["bonus-case"] = { status: "pass" }));
    assert.throws(() => verifyEvidence({ evidenceDir, repoRoot }), /unknown case 'bonus-case'/);
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

test("even a fully failing scripted matrix cannot reach blocked while real cells are absent", () => {
  withFixture(({ evidenceDir, repoRoot, mutate }) => {
    rmSync(join(evidenceDir, "real-clients"), { recursive: true, force: true });
    mutate("scripted.json", (s) => {
      for (const c of ["v1", "v2"]) {
        for (const name of Object.keys(s[c].cases)) s[c].cases[name] = { status: "fail" };
      }
    });
    const verified = verifyEvidence({ evidenceDir, repoRoot });
    assert.equal(decide(verified).outcome, "incomplete");
  });
});

test("real-client cells with recorded outcomes complete the matrix and unlock a verdict", () => {
  withFixture(({ evidenceDir, repoRoot }) => {
    mkdirSync(join(evidenceDir, "real-clients"), { recursive: true });
    const cell = { status: "pass", clientVersion: "0.0.0-fixture" };
    writeFileSync(
      join(evidenceDir, "real-clients", "cells.json"),
      JSON.stringify({
        v1: { "claude-code": cell, codex: cell },
        v2: { "claude-code": cell, codex: cell },
      }),
    );
    const verified = verifyEvidence({ evidenceDir, repoRoot });
    assert.equal(decide(verified).outcome, "adopt-v2");
  });
});

test("the committed matrix recorded every scripted case for both candidates — no short-circuit", () => {
  // The live no-short-circuit assertion over the real evidence: all eight cases present per
  // candidate regardless of status (an early failure may end its case, never the matrix).
  const scripted = JSON.parse(readFileSync(join(EVIDENCE_DIR, "scripted.json"), "utf8"));
  for (const c of ["v1", "v2"]) {
    assert.deepEqual(Object.keys(scripted[c].cases).sort(), [...SCRIPTED_CASES].sort());
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

test("REAL_CLIENTS and EvidenceError are the exported shapes act2 tooling will rely on", () => {
  assert.deepEqual(REAL_CLIENTS, ["claude-code", "codex"]);
  assert.ok(new EvidenceError("x") instanceof Error);
});
