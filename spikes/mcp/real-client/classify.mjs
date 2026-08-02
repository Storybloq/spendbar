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
//
// Two hardenings from review round 1, both closing the same laundering route — a
// conformance-fail re-labelled as "could not run", which turns a failing candidate into an
// `incomplete` verdict instead of a `fail`:
//
//   1. An environmental claim is honored only when the record carries the WITNESS specific to
//      that condition (a claim is a claim; the witness is the observation), and never when the
//      trace shows protocol progress that contradicts it. `fresh-state-isolation-failure` is
//      the one condition that survives progress, because a hostile config that executed
//      invalidates a run no matter how well the run then went.
//   2. Missing or malformed structural data is INVALID EVIDENCE (a thrown
//      InvalidRecordError), not an observation. Absent `spawn` used to read as "spawn was
//      observed to fail", so deleting one object from a manifest downgraded a fail to a
//      not-run.

/** The record is unusable — not a verdict about the run, a verdict about the record. */
export class InvalidRecordError extends Error {}

export const OUTCOMES = ["pass", "conformance-fail", "infrastructure-unavailable"];

/** The only conditions that may claim `infrastructure-unavailable` — positively observed. */
export const ENVIRONMENTAL_CONDITIONS = [
  "binary-missing",
  "auth-failure",
  "network-outage",
  "spawn-failure",
  "fresh-state-isolation-failure",
];

/** Conditions whose meaning survives protocol progress: the run is void regardless of how it went. */
const PROGRESS_IMMUNE = ["fresh-state-isolation-failure"];

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isBool = (v) => v === true || v === false;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Per-condition witnesses. Each is a fact recorded by the capture INDEPENDENTLY of the claim,
 * so a hand-written `environmental` block cannot mint a not-run on its own.
 */
const ENVIRONMENTAL_WITNESS = {
  "binary-missing": (r) =>
    r.spawn.client.ok !== true
      ? null
      : "the client process spawned, so the binary was present",
  "auth-failure": (r) =>
    r.clientExit?.code !== 0 && r.clientStdout?.hasCompletionMarker !== true
      ? null
      : "the client exited 0 or reported completion, so it was not turned away unauthenticated",
  "network-outage": (r) =>
    r.clientExit?.code !== 0 && r.clientStdout?.hasCompletionMarker !== true
      ? null
      : "the client completed successfully, so no outage stopped this run",
  "spawn-failure": (r) =>
    r.spawn.client.ok !== true || r.spawn.server.ok !== true
      ? null
      : "both processes spawned",
  "fresh-state-isolation-failure": (r) =>
    r.isolation?.hostileConfigExecuted === true
      ? null
      : "no hostile-config canary was observed",
};

/** Structural requirements. A record failing these is invalid evidence, never an outcome. */
function requireWellFormed(record) {
  const bad = (why) => {
    throw new InvalidRecordError(`record is not usable evidence: ${why}`);
  };
  if (!isPlainObject(record)) bad("not an object");

  const spawn = record.spawn;
  if (!isPlainObject(spawn)) bad("spawn is missing or not an object");
  for (const side of ["client", "server"]) {
    const s = spawn[side];
    if (!isPlainObject(s)) bad(`spawn.${side} is missing or not an object`);
    if (!isBool(s.ok)) bad(`spawn.${side}.ok is missing or not a boolean`);
  }

  if (!isPlainObject(record.isolation) || !isBool(record.isolation.hostileConfigExecuted)) {
    bad("isolation.hostileConfigExecuted is missing or not a boolean");
  }

  const env = record.environmental;
  if (env !== null && env !== undefined) {
    if (!isPlainObject(env)) bad("environmental is neither null nor an object");
    if (typeof env.condition !== "string") bad("environmental.condition is missing or not a string");
  }

  for (const direction of ["clientToServer", "serverStdout"]) {
    const s = record[direction];
    if (!isPlainObject(s)) bad(`${direction} statistics are missing or not an object`);
    for (const key of ["bytes", "remainder", "encodingErrors", "parseErrors", "protocolErrors"]) {
      if (!isCount(s[key])) bad(`${direction}.${key} is missing or not a non-negative integer`);
    }
  }

  if (!Array.isArray(record.frames)) bad("frames is missing or not an array");
}

/**
 * Classify one recorded run. `expected` carries the committed literals the record is judged
 * against: { promptSha256, nonce, completionMarker }.
 *
 * Returns { outcome, reasons } — EVERY failed clause is reported, not just the first, so the
 * record explains itself. Throws InvalidRecordError when the record cannot be judged at all.
 */
export function classify(record, expected) {
  requireWellFormed(record);

  const frames = record.frames;
  const progressed = frames.some(
    (f) => isPlainObject(f) && f.type === "response" && ["initialize", "tools/list", "tools/call"].includes(f.method),
  );

  // Environmental claims first — admitted only with their witness, and only when the trace
  // does not contradict them. A rejected claim does not end the classification: the record is
  // then judged on conformance, with the rejection recorded as its own reason.
  const rejected = [];
  const claim = record.environmental;
  if (claim != null) {
    if (!ENVIRONMENTAL_CONDITIONS.includes(claim.condition)) {
      rejected.push(`environmental claim '${claim.condition}' is not an enumerated observable condition — the default stands`);
    } else if (progressed && !PROGRESS_IMMUNE.includes(claim.condition)) {
      rejected.push(
        `environmental claim '${claim.condition}' contradicts the trace: the protocol made progress, so this run ran`,
      );
    } else {
      const missing = ENVIRONMENTAL_WITNESS[claim.condition](record);
      if (missing !== null) {
        rejected.push(`environmental claim '${claim.condition}' has no witness in the record: ${missing}`);
      } else {
        return {
          outcome: "infrastructure-unavailable",
          reasons: [`${claim.condition}: ${claim.detail ?? "observed"}`],
        };
      }
    }
  }

  if (record.isolation.hostileConfigExecuted === true) {
    // The canary is an observation, not a claim: a run whose hostile project config executed
    // is void whether or not the capture thought to say so.
    return {
      outcome: "infrastructure-unavailable",
      reasons: ["fresh-state-isolation-failure: the hostile project config executed"],
    };
  }

  if (record.spawn.client.ok !== true || record.spawn.server.ok !== true) {
    const recorded = `client ok=${record.spawn.client.ok}, server ok=${record.spawn.server.ok}`;
    if (!progressed) {
      // An OBSERVED spawn failure — the booleans are validated above, so this branch can no
      // longer be reached by omitting the data.
      return { outcome: "infrastructure-unavailable", reasons: [`spawn-failure: ${recorded}`] };
    }
    // Frames cannot exist without the processes that exchanged them. A record claiming both is
    // internally inconsistent, and the safe reading of an inconsistent record is a failure, not
    // a run that never happened.
    rejected.push(`spawn is recorded as failed (${recorded}) but the trace shows protocol progress — the record contradicts itself`);
  }

  // Both spawned, no admitted environmental condition: everything from here is conformance.
  const reasons = [...rejected];
  const clause = (ok, why) => {
    if (!ok) reasons.push(why);
  };

  // 1. Exact prompt — a hashed input, never a paraphrase.
  clause(record.promptSha256 === expected.promptSha256, "prompt hash does not match the committed literal");
  // 2. Nonce recorded before the run and echoed back through the tool result.
  clause(record.nonce === expected.nonce, "recorded nonce does not match this run's record");

  // 3. Ordered frame sequence over the normalized server trace.
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
  clause(
    !frames.some((f) => f.method === "ambiguous"),
    "a response could not be attributed to a request: the client reused a request id",
  );

  // 4. Stream discipline, per channel, on raw bytes. Every byte either became a message or was
  //    counted as a failure; a stream that carried something the parser could not account for
  //    is not a clean trace, whatever the surviving frames say.
  const so = record.serverStdout;
  clause(so.bytes > 0, "server stdout carried zero bytes");
  clause(so.remainder === 0, `server stdout parser left ${so.remainder} unconsumed bytes`);
  for (const [direction, stats] of [["server stdout", so], ["client->server", record.clientToServer]]) {
    clause(stats.encodingErrors === 0, `${direction} carried ${stats.encodingErrors} line(s) that were not valid UTF-8`);
    clause(stats.parseErrors === 0, `${direction} produced ${stats.parseErrors} parse errors`);
    clause(stats.protocolErrors === 0, `${direction} carried ${stats.protocolErrors} non-JSON-RPC-2.0 message(s)`);
  }
  clause(record.serverStderr?.hasReadyLine === true, "server stderr lacks the expected log line");
  clause(record.serverStderr?.containsFrames === false, "server stderr contains JSON-RPC frames");
  clause(record.clientStdout?.hasCompletionMarker === true, `client stdout lacks the completion marker`);
  clause(record.clientStdout?.containsNonce === false, "client stdout leaks the nonce-secret");
  clause(record.clientStdout?.containsAllowlistedEnvValue === false, "client stdout leaks an environment value");

  // 5. Exit status.
  clause(record.clientExit?.code === 0, `client exited ${record.clientExit?.code} (signal ${record.clientExit?.signal})`);
  clause(record.serverTermination?.signal == null, `server terminated by signal ${record.serverTermination?.signal}`);

  // 6. Deadline (clause 6 of §9, retries, is enforced by the harness; the record only classifies).
  clause(record.timedOut !== true, `timed out after spawn (last phase: ${record.lastPhase}) — conformance-fail by default`);

  return reasons.length === 0 ? { outcome: "pass", reasons: [] } : { outcome: "conformance-fail", reasons };
}

/** §1 mapping from typed capture outcome to a three-valued cell status. */
export function toCellStatus(outcome) {
  return { pass: "pass", "conformance-fail": "fail", "infrastructure-unavailable": "not-run" }[outcome];
}
