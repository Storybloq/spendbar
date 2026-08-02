// The decision predicate and Act 1 (plan §1).
//
// decide(verified) -> "adopt-v2" | "adopt-v1" | "blocked" | "incomplete"
//
// Four outcomes because "could not run" is not "failed": a per-candidate result is
// three-valued (pass | fail | not-run), and not-run DOMINATES — a gate that could not run has
// no verdict to give, and routing that into `blocked` would record "both SDKs failed" when the
// truth was "a client was not logged in". Dependency weight and token cost are not inputs;
// they are reported.
//
// Act 1 records what actually happened and touches the ticket graph only where it needs
// protecting. Act 2 — completing T-009 — is a separate, owner-gated act that lives outside
// this module on purpose: open questions 2 and 3 are owner decisions, and a script that
// completed the ticket would be encoding them.

// The mandatory set, per candidate (checked against a separate literal oracle in tests):
// the eight scripted conformance cases and both real-client captures. §5's isolation and
// supply-chain results are evidence-VALIDITY inputs enforced by the verifier, not cells.
export const SCRIPTED_CASES = [
  "initialize",
  "tools-list",
  "tools-call",
  "broken-framing",
  "schema-violation",
  "cancellation",
  "client-eof",
  "stdout-purity",
];
export const REAL_CLIENTS = ["claude-code", "codex"];
export const MANDATORY_CELLS = [
  ...SCRIPTED_CASES.map((c) => `scripted:${c}`),
  ...REAL_CLIENTS.map((c) => `real:${c}`),
];
export const STATUSES = ["pass", "fail", "not-run"];

export const EXIT_CODES = {
  "adopt-v2": 0,
  "adopt-v1": 0,
  blocked: 3, // a verdict, recorded — but the gate command exits nonzero (§13)
  incomplete: 4, // distinct: names what was unavailable, never completes the ticket
  invalidEvidence: 2,
  transitionError: 5,
};

/** Aggregate one candidate's mandatory cells. not-run dominates; then any fail; else pass. */
export function aggregate(cells) {
  const statuses = MANDATORY_CELLS.map((name) => {
    const cell = cells[name];
    if (!cell || !STATUSES.includes(cell.status)) {
      throw new Error(`cell ${name} is absent or malformed — the verifier should have refused this`);
    }
    return cell.status;
  });
  if (statuses.includes("not-run")) return "not-run";
  if (statuses.includes("fail")) return "fail";
  return "pass";
}

/**
 * The truth table, verbatim from the plan. "Unselected" is a disposition, not a result — the
 * both-pass row adopts v2 while v1 is unselected and fully passing.
 */
export function decide(verified) {
  const v2 = aggregate(verified.cells.v2);
  const v1 = aggregate(verified.cells.v1);
  let outcome;
  if (v2 === "not-run" || v1 === "not-run") outcome = "incomplete";
  else if (v2 === "pass") outcome = "adopt-v2";
  else if (v1 === "pass") outcome = "adopt-v1";
  else outcome = "blocked";
  return { outcome, aggregates: { v2, v1 } };
}

/** The canonical resolution-ticket title. Locate uses EXACT equality on this — substring
 *  matching could reuse an unrelated ticket that merely mentions the key (review round 1). */
/** An injective encoding of the version pair: length-prefixed, so no separator can be forged. */
export const versionTuple = ({ v2, v1 }) => `${String(v2).length}:${v2}/${String(v1).length}:${v1}`;

export const resolutionTicketTitle = (dedupeKey) => `No supported MCP SDK (${dedupeKey})`;

export class TransitionError extends Error {
  constructor(step, message) {
    super(`act1 step '${step}' failed: ${message}`);
    this.step = step;
    this.exitCode = EXIT_CODES.transitionError;
  }
}

function collectNotRun(verified) {
  const unavailable = [];
  for (const candidate of ["v2", "v1"]) {
    for (const name of MANDATORY_CELLS) {
      const cell = verified.cells[candidate][name];
      if (cell.status === "not-run") {
        unavailable.push({ candidate, cell: name, cause: cell.cause ?? "unspecified" });
      }
    }
  }
  return unavailable;
}

/** Evidence-controlled strings rendered into Markdown: single line, pipes escaped, bounded —
 *  an embedded newline or table pipe must not make the document visually disagree with the
 *  structured evidence it was generated from (review round 1). */
const md = (value) => {
  const s = String(value)
    // EVERY line terminator, not just CRLF and LF: a bare CR and the Unicode separators
    // U+2028/U+2029 all break a Markdown table row, and all three survived (round 2, chunk 11).
    .replace(/[\n\r\u2028\u2029]/g, " ")
    // Other C0/C1 controls and the bidi overrides, which can make rendered text read in a
    // different order from the bytes the evidence actually holds.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    // Backslash FIRST. Escaping the pipe alone turned an input containing a literal `\|` into
    // `\\|` — an escaped backslash followed by a LIVE table delimiter, so the cell still split.
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
};

/** The decision document is GENERATED from the verifier output so prose cannot disagree. */
export function renderDecisionDoc(verified, decision) {
  const { outcome, aggregates } = decision;
  const lines = [];
  lines.push(`# T-009 decision: ${outcome}`);
  lines.push("");
  lines.push(`Generated by decide() from verified evidence — do not edit by hand.`);
  lines.push("");
  lines.push(`| candidate | SDK | version | result |`);
  lines.push(`|---|---|---|---|`);
  for (const c of ["v2", "v1"]) {
    lines.push(`| ${c} | ${md(verified.sdk[c])} | ${md(verified.versions[c])} | ${aggregates[c]} |`);
  }
  lines.push("");
  for (const c of ["v2", "v1"]) {
    lines.push(`## ${c} cells`);
    for (const name of MANDATORY_CELLS) {
      const cell = verified.cells[c][name];
      lines.push(`- ${name}: ${cell.status}${cell.detail ? ` — ${md(cell.detail)}` : ""}`);
    }
    lines.push("");
  }
  // Qualifications come BEFORE the reported-not-gating section and are never folded into it:
  // a dependency count is context, but "this cell passed on one machine rather than from a
  // fresh state" is a limit on what the table above means. A reader who stops at the cell list
  // must not come away with an unconditional pass (review round 1, chunk 17).
  const qualifications = verified.report.qualifications ?? [];
  if (qualifications.length > 0) {
    lines.push(`## Qualified passes — read the table above with these`);
    for (const q of qualifications) {
      lines.push(`- ${md(q.candidate)} ${md(q.cell)} (${md(q.kind)}): ${md(q.detail)}`);
    }
    lines.push("");
  }
  lines.push(`## Reported, not gating`);
  lines.push(`- dependency closure: v2 ${verified.report.closureSize.v2} packages, v1 ${verified.report.closureSize.v1} packages`);
  lines.push(
    `- token cost (${verified.report.tokenCost.proxyVersion}): ` +
      `v2 ${verified.report.tokenCost.v2.canonicalBytes}B/${verified.report.tokenCost.v2.proxyTokens}t, ` +
      `v1 ${verified.report.tokenCost.v1.canonicalBytes}B/${verified.report.tokenCost.v1.proxyTokens}t — ` +
      `no acceptance threshold; that is open question 3, an owner decision`,
  );
  for (const note of verified.report.notes ?? []) lines.push(`- ${md(note)}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Act 1 — branch by outcome:
 *   blocked    -> idempotent resolution ticket by semantic dedupe key, attach to T-013,
 *                 TRUST THE READ-BACK, then the decision document AND machine record.
 *   adopt-*    -> decision document and machine record. No ticket, no blocker.
 *   incomplete -> stale verdict artifacts cleared, then the typed attempt report — the two
 *                 kinds of artifact are mutually exclusive: a run that reached no verdict
 *                 must not leave an older verdict visible to packaging (review round 1).
 *
 * ALL artifacts are written inside the step wrapper, so a failed write surfaces as that
 * step's TransitionError instead of escaping after the graph already mutated (review
 * round 1). Graph and filesystem effects are injected so every branch and every step
 * failure is testable; the live implementations are in gate.mjs.
 */
export async function act1(decision, verified, deps) {
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      throw new TransitionError(name, String(error?.message ?? error));
    }
  };

  // The supplied decision is never trusted (review round 1): recompute it from the verified
  // evidence and refuse any disagreement — otherwise an inconsistent or unknown outcome
  // would fall through to the blocked branch and mutate the ticket graph.
  // Inside `step`: `aggregate` throws a plain Error for an absent or malformed cell, which
  // escaped Act 1 as an uncaught exception with an undocumented exit code rather than the
  // TransitionError this function promises for every way it can refuse (round 2, chunk 11).
  const expected = await step("decision-recompute", () => decide(verified));
  if (
    decision.outcome !== expected.outcome ||
    JSON.stringify(decision.aggregates) !== JSON.stringify(expected.aggregates)
  ) {
    throw new TransitionError(
      "decision-recompute",
      `supplied decision ${JSON.stringify(decision)} does not equal the recomputed ${JSON.stringify(expected)}`,
    );
  }

  // The machine-readable record packaging keys off. It carries the qualifications too, so a
  // consumer reading only decision.json cannot conclude more than DECISION.md says.
  const decisionRecord = () => ({
    outcome: decision.outcome,
    aggregates: decision.aggregates,
    versions: verified.versions,
    qualifications: verified.report.qualifications ?? [],
  });

  if (decision.outcome === "incomplete") {
    await step("clear-stale-verdict", () => deps.removeDecisionArtifacts());
    await step("attempt-report", () =>
      deps.writeAttemptReport({
        type: "t009-attempt-report",
        outcome: "incomplete",
        unavailable: collectNotRun(verified),
      }),
    );
    return { exitCode: EXIT_CODES.incomplete, wrote: ["attempt-report"] };
  }

  if (decision.outcome === "adopt-v2" || decision.outcome === "adopt-v1") {
    await step("decision-doc", () => deps.writeDecisionDoc(renderDecisionDoc(verified, decision)));
    await step("decision-record", () => deps.writeDecisionRecord(decisionRecord()));
    return { exitCode: EXIT_CODES[decision.outcome], wrote: ["decision-doc", "decision-record"] };
  }

  // blocked — the dedupe key is SEMANTIC (versions only): evidence hashes belong in the ticket
  // body, never its identity, or a legitimate recapture would duplicate the ticket.
  // The version pair is length-prefixed rather than joined with `+`, which is legal INSIDE a
  // SemVer build-metadata suffix: `1.0.0+2.0.0` with `3.0.0` and `1.0.0` with `2.0.0+3.0.0`
  // produced the same key, so a later blocked decision would have reused the wrong resolution
  // ticket (round 2, chunk 11). Still semantic — versions only, no evidence hashes, or a
  // legitimate recapture would duplicate the ticket.
  const dedupeKey = `T-009:no-supported-sdk:${versionTuple(verified.versions)}`;
  let ticket = await step("locate-resolution-ticket", () => deps.graph.findOpenTicketByDedupeKey(dedupeKey));
  if (!ticket) {
    ticket = await step("create-resolution-ticket", () =>
      deps.graph.createResolutionTicket(dedupeKey, decision, verified),
    );
  }
  // Locate/create results are not trusted either: re-read the ticket and require that it
  // exists, is open, and carries the semantic dedupe key before it touches T-013 (review
  // round 1) — a stale or malformed result must fail closed, not attach.
  const back = await step("read-back-resolution-ticket", () => deps.graph.readTicket(ticket.id));
  if (!back || typeof back !== "object" || Array.isArray(back)) {
    throw new TransitionError("read-back-resolution-ticket", `ticket ${ticket.id} could not be read back`);
  }
  // The read-back must be OF THIS TICKET. Without the identity check the graph could answer
  // with a different ticket that happens to carry the canonical title, and the original,
  // never-verified id was the one attached to T-013 (round 2, chunk 11).
  if (back.id !== ticket.id) {
    throw new TransitionError(
      "read-back-resolution-ticket",
      `read-back returned ${JSON.stringify(back.id)}, not the ${JSON.stringify(ticket.id)} that was located or created`,
    );
  }
  if (back.title !== resolutionTicketTitle(dedupeKey)) {
    throw new TransitionError(
      "read-back-resolution-ticket",
      `ticket ${ticket.id} title ${JSON.stringify(back.title)} is not the canonical dedupe title`,
    );
  }
  // A MISSING status used to pass this: `["done","cancelled"].includes(undefined)` is false, so
  // a ticket whose state was never reported read as open. The status must be present and be a
  // string before the terminal set is consulted. It is not checked against an allowlist of
  // active states, deliberately — this file does not own storybloq's status vocabulary, and
  // inventing one here would reject a legitimate state the day a new one is added, which is the
  // mirror of the bug being fixed.
  if (typeof back.status !== "string" || back.status === "") {
    throw new TransitionError(
      "read-back-resolution-ticket",
      `ticket ${ticket.id} read back with no usable status (${JSON.stringify(back.status)}) — unknown is not open`,
    );
  }
  if (["done", "cancelled"].includes(back.status)) {
    throw new TransitionError("read-back-resolution-ticket", `ticket ${ticket.id} is ${back.status}, not open`);
  }
  await step("attach-blocker", () => deps.graph.attachBlocker("T-013", ticket.id));
  const t013 = await step("read-back-t013", () => deps.graph.readTicket("T-013"));
  // Shape-checked before it is questioned. `(t013.blockedBy ?? []).includes(id)` on a STRING
  // does substring matching, so a `blockedBy` of "T-1234" reported that it contained "T-12" and
  // the transaction completed cleanly having never seen a blocker list at all; and a null ticket
  // threw a TypeError from outside `step` (round 2, chunk 11).
  if (!t013 || typeof t013 !== "object" || Array.isArray(t013)) {
    throw new TransitionError("read-back-t013", "T-013 could not be read back");
  }
  if (!Array.isArray(t013.blockedBy)) {
    throw new TransitionError(
      "read-back-t013",
      `T-013.blockedBy is ${Array.isArray(t013.blockedBy) ? "an array" : typeof t013.blockedBy}, not an array — the blocker list was never observed`,
    );
  }
  if (!t013.blockedBy.some((id) => id === ticket.id)) {
    throw new TransitionError("read-back-t013", `T-013.blockedBy does not contain ${ticket.id}`);
  }
  await step("decision-doc", () => deps.writeDecisionDoc(renderDecisionDoc(verified, decision)));
  await step("decision-record", () => deps.writeDecisionRecord(decisionRecord()));
  return {
    exitCode: EXIT_CODES.blocked,
    wrote: ["resolution-ticket", "decision-doc", "decision-record"],
    ticketId: ticket.id,
  };
}
