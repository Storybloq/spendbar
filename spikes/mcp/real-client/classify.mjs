// Real-client run classifier (plan §9): a PURE FUNCTION over the recorded run.
//
// Typed outcomes and their §1 mapping:
//   pass                       -> pass
//   conformance-fail           -> fail
//   infrastructure-unavailable -> not-run   (forcing `incomplete`, never `blocked`)
//
// The classification is derived from the record, never asserted by the code that produced
// it — and the burden sits on the ENVIRONMENTAL claim: once both processes have spawned,
// a timeout is conformance-fail by default; `infrastructure-unavailable` requires an
// independently observable condition (binary missing, auth failure, verified outage, spawn
// failure, or positively-detected fresh-state isolation failure). A post-spawn pre-handshake
// timeout can be an SDK startup, framing or transport defect — a harness that ran and
// failed, never one that could not run.

export const OUTCOMES = ["pass", "conformance-fail", "infrastructure-unavailable"];

/** The only conditions that may claim `infrastructure-unavailable` — positively observed. */
export const ENVIRONMENTAL_CONDITIONS = [
  "binary-missing",
  "auth-failure",
  "network-outage",
  "spawn-failure",
  "fresh-state-isolation-failure",
];

/**
 * Classify one recorded run. `expected` carries the committed literals the record is judged
 * against: { promptSha256, nonce, completionMarker }.
 *
 * Returns { outcome, reasons } — EVERY failed clause is reported, not just the first, so the
 * record explains itself.
 */
export function classify(record, expected) {
  // Environmental claims first, and only from the enumerated observable conditions.
  if (record.environmental != null) {
    if (!ENVIRONMENTAL_CONDITIONS.includes(record.environmental.condition)) {
      return {
        outcome: "conformance-fail",
        reasons: [
          `environmental claim '${record.environmental.condition}' is not an enumerated observable condition — the default stands`,
        ],
      };
    }
    return {
      outcome: "infrastructure-unavailable",
      reasons: [`${record.environmental.condition}: ${record.environmental.detail ?? "observed"}`],
    };
  }
  if (!record.spawn?.client?.ok || !record.spawn?.server?.ok) {
    // A spawn failure IS an observable condition; a record that failed to spawn but claimed
    // nothing environmental still classifies as unavailable — with the reason recorded.
    return {
      outcome: "infrastructure-unavailable",
      reasons: [`spawn-failure: client ok=${Boolean(record.spawn?.client?.ok)}, server ok=${Boolean(record.spawn?.server?.ok)}`],
    };
  }

  // Both spawned, no environmental condition: everything from here is conformance.
  const reasons = [];
  const clause = (ok, why) => {
    if (!ok) reasons.push(why);
  };

  // 1. Exact prompt — a hashed input, never a paraphrase.
  clause(record.promptSha256 === expected.promptSha256, "prompt hash does not match the committed literal");
  // 2. Nonce recorded before the run and echoed back through the tool result.
  clause(record.nonce === expected.nonce, "recorded nonce does not match this run's record");

  // 3. Ordered frame sequence over the normalized server trace.
  const frames = record.frames ?? [];
  const idxInit = frames.findIndex(
    (f) => f.type === "response" && f.method === "initialize" && typeof f.protocolVersion === "string" && f.protocolVersion.length > 0,
  );
  const idxList = frames.findIndex((f) => f.type === "response" && f.method === "tools/list");
  const idxCall = frames.findIndex((f) => f.type === "response" && f.method === "tools/call");
  clause(idxInit >= 0, "no initialize response with a non-empty negotiated protocolVersion");
  clause(idxList >= 0, "no tools/list response (fresh state was verified, so enumeration must occur)");
  if (idxList >= 0) {
    const listed = frames[idxList].toolNames ?? [];
    clause(
      JSON.stringify(listed) === JSON.stringify(["spendbar_probe"]),
      `advertised tool set is [${listed.join(", ")}], expected exactly [spendbar_probe]`,
    );
  }
  clause(idxCall >= 0, "no tools/call response for the probe");
  if (idxCall >= 0) {
    const call = frames[idxCall];
    clause(call.structuredNonce === expected.nonce, "tools/call result does not echo the nonce in structuredContent");
    clause(
      typeof call.text === "string" && call.text.length > 0 && call.text.includes(expected.nonce),
      "tools/call result lacks a non-empty text fallback carrying the nonce",
    );
  }
  clause(
    idxInit >= 0 && idxList > idxInit && idxCall > idxList,
    "frame order is not initialize -> tools/list -> tools/call (order is part of the protocol claim)",
  );

  // 4. Stream discipline, per channel, on raw bytes.
  const so = record.serverStdout ?? {};
  clause(so.bytes > 0, "server stdout carried zero bytes");
  clause(so.remainder === 0, `server stdout parser left ${so.remainder} unconsumed bytes`);
  clause(so.parseErrors === 0, `server stdout produced ${so.parseErrors} parse errors`);
  clause(record.serverStderr?.hasReadyLine === true, "server stderr lacks the expected log line");
  clause(record.serverStderr?.containsFrames === false, "server stderr contains JSON-RPC frames");
  clause(record.clientStdout?.hasCompletionMarker === true, `client stdout lacks the completion marker`);
  clause(record.clientStdout?.containsNonce === false, "client stdout leaks the nonce-secret");
  clause(record.clientStdout?.containsAllowlistedEnvValue === false, "client stdout leaks an environment value");

  // 5. Exit status.
  clause(record.clientExit?.code === 0, `client exited ${record.clientExit?.code} (signal ${record.clientExit?.signal})`);
  clause(record.serverTermination?.signal == null, `server terminated by signal ${record.serverTermination?.signal}`);

  // 7. Deadline (clause 6, retries, is enforced by the harness; the record only classifies).
  clause(record.timedOut !== true, `timed out after spawn (last phase: ${record.lastPhase}) — conformance-fail by default`);

  return reasons.length === 0 ? { outcome: "pass", reasons: [] } : { outcome: "conformance-fail", reasons };
}

/** §1 mapping from typed capture outcome to a three-valued cell status. */
export function toCellStatus(outcome) {
  return { pass: "pass", "conformance-fail": "fail", "infrastructure-unavailable": "not-run" }[outcome];
}
