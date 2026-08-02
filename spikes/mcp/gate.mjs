#!/usr/bin/env node
// The gate command (plan §1): verify recorded evidence, decide, and run Act 1.
//
//   node spikes/mcp/gate.mjs
//
// Exit codes (pinned in decide.mjs EXIT_CODES): 0 adopt-v2/adopt-v1 with the decision
// document written; 3 blocked — a verdict, with the resolution-ticket transaction completed
// and read back; 4 incomplete — typed attempt report written, nothing else touched; 2 the
// evidence failed verification; 5 an Act 1 step failed (T-009 stays in progress).
//
// Act 2 — completing T-009 — is deliberately NOT here: it is owner-gated on open questions
// 3 (and 2 on adopt-*), and a command that closed the ticket would be encoding those answers.

import { execFileSync } from "node:child_process";
import { writeFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { decide, act1, EXIT_CODES, TransitionError, resolutionTicketTitle } from "./decide.mjs";
import { verifyEvidence, EVIDENCE_DIR, EvidenceError } from "./verify-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/** storybloq CLI wrapper; every command failure surfaces as the step's transition error. */
function sb(args, { stdin } = {}) {
  const out = execFileSync("storybloq", args, {
    cwd: REPO,
    encoding: "utf8",
    ...(stdin !== undefined ? { input: stdin } : {}),
  });
  return out;
}
const sbJson = (args) => JSON.parse(sb([...args, "--format", "json", "--raw"]));

// The live graph. The dedupe key is embedded in the ticket TITLE — stable, human-visible,
// and locatable without metadata queries. A wrong assumption about any CLI surface fails the
// step loudly (TransitionError), never silently: the read-back is the trust anchor.
const cliGraph = {
  findOpenTicketByDedupeKey(key) {
    // EXACT equality with the canonical title — substring matching could reuse an unrelated
    // ticket that merely mentions the key (review round 1). `ticket list` returns the full
    // unpaginated set for this CLI; a wrong assumption there surfaces as a duplicate whose
    // creation act1's read-back then validates against the same canonical title.
    const tickets = sbJson(["ticket", "list"]);
    const rows = Array.isArray(tickets) ? tickets : tickets.tickets ?? [];
    const canonical = resolutionTicketTitle(key);
    return rows.find((t) => t.title === canonical && !["done", "cancelled"].includes(t.status)) ?? null;
  },
  createResolutionTicket(key, decision, verified) {
    const description = [
      `Resolution ticket created by T-009's gate: no supported MCP SDK.`,
      ``,
      `Dedupe key: ${key}`,
      `Aggregates: v2=${decision.aggregates.v2}, v1=${decision.aggregates.v1}`,
      `Evidence: spikes/mcp/evidence/ (input digests bind it; see DECISION.md).`,
    ].join("\n");
    const created = sbJson([
      "ticket",
      "create",
      "--title",
      resolutionTicketTitle(key),
      "--type",
      "task",
      "--description",
      description,
    ]);
    return { id: created.id ?? created.displayId };
  },
  attachBlocker(target, ticketId) {
    sb(["ticket", "update", target, "--blocked-by", ticketId]);
  },
  readTicket(id) {
    return sbJson(["ticket", "get", id]);
  },
};

/** Write-then-rename so a crash mid-write never leaves a torn artifact behind. */
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const deps = {
  graph: cliGraph,
  writeDecisionDoc(doc) {
    writeAtomic(join(EVIDENCE_DIR, "DECISION.md"), doc);
  },
  // The machine-readable record packaging keys off (§10) — written INSIDE act1's transaction,
  // and mutually exclusive with the attempt report (review round 1).
  writeDecisionRecord(record) {
    writeAtomic(join(EVIDENCE_DIR, "decision.json"), JSON.stringify(record, null, 2) + "\n");
    rmSync(join(EVIDENCE_DIR, "attempt-report.json"), { force: true });
  },
  removeDecisionArtifacts() {
    rmSync(join(EVIDENCE_DIR, "DECISION.md"), { force: true });
    rmSync(join(EVIDENCE_DIR, "decision.json"), { force: true });
  },
  writeAttemptReport(report) {
    writeAtomic(join(EVIDENCE_DIR, "attempt-report.json"), JSON.stringify(report, null, 2) + "\n");
  },
};

let verified;
try {
  verified = verifyEvidence();
} catch (error) {
  if (error instanceof EvidenceError) {
    process.stderr.write(`gate: evidence INVALID — ${error.message}\n`);
    process.exit(EXIT_CODES.invalidEvidence);
  }
  throw error;
}

const decision = decide(verified);
process.stderr.write(
  `gate: outcome ${decision.outcome} (v2=${decision.aggregates.v2}, v1=${decision.aggregates.v1})\n`,
);

try {
  const result = await act1(decision, verified, deps);
  process.stderr.write(`gate: wrote ${result.wrote.join(", ")}\n`);
  process.exit(result.exitCode);
} catch (error) {
  if (error instanceof TransitionError) {
    process.stderr.write(`gate: ${error.message}\nT-009 remains in progress.\n`);
    process.exit(error.exitCode);
  }
  throw error;
}
