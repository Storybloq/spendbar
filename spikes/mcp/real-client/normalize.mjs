// Normalization: raw captured bytes -> the frame trace the classifier consumes (plan §6b/§9).
//
// A PURE function over the two retained streams (client->server, server->client), so the
// receipt verifier can re-run it over the retained raw capture and require byte-identical
// output — "the derivation is reproducible" is a checkable claim only because nothing here
// reads anything but its arguments.
//
// Framing is done on BYTES (review round 1). Decoding the whole stream as UTF-8 first is
// lossy in exactly the direction that matters: an invalid sequence becomes U+FFFD, the line
// still parses or still fails, and the corruption is never counted. So the buffer is split on
// 0x0A and each line is decoded with a FATAL decoder — a line that is not valid UTF-8 is
// counted as an encoding error and never silently repaired.
//
// Three failure counters per direction, and they are the point: `encodingErrors` (line was not
// UTF-8), `parseErrors` (decoded but was not JSON), `protocolErrors` (was JSON but not a
// well-formed JSON-RPC 2.0 message, or reused a request id). Anything the parser could not
// account for lands in one of them; nothing is dropped silently. The classifier requires all
// three to be zero, so "the trace looked fine because the junk vanished" is not reachable.
//
// The tail after the final newline is ALWAYS remainder, even when it happens to be valid JSON
// (review round 1). An unterminated line is indistinguishable from a truncated one, and
// admitting it as a frame lets a stream that was cut mid-write pass as a clean one.

import { createHash } from "node:crypto";

/** Bumped whenever the derivation changes; it is part of the digest, so old traces cannot silently match. */
export const TRACE_VERSION = "normalize/3";

const NEWLINE = 0x0a;
// `ignoreBOM: true` is the option whose name means the opposite of what it reads like: it tells
// the decoder to leave a leading U+FEFF ALONE. The default STRIPS it, so a BOM-prefixed JSON
// line decoded clean, parsed clean, and became a message with every counter at zero — three
// bytes on a stream whose purity is asserted, accounted for by nothing (review round 2, chunk
// 7). Kept, U+FEFF is not valid JSON, so the line lands in parseErrors where it belongs.
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The response methods this probe attributes; anything else is an unattributed frame. */
export const PROBE_METHODS = ["initialize", "tools/list", "tools/call"];

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
// SAFE integer, not merely integer. Two distinct JSON integers above 2^53 parse to the SAME
// Number — 9007199254740993 and ...992 are indistinguishable once parsed — so accepting them
// let two different request ids collide in the attribution map (review round 2, chunk 7).
// Anything outside the safe range is a protocol error rather than a silently merged id.
const isValidId = (v) => typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));
/** Ids are compared across directions, and `1` is not `"1"`. */
const idKey = (id) => (typeof id === "string" ? `s:${id}` : `n:${id}`);

/** Split on 0x0A. Every element of `lines` was newline-terminated; `tail` never was. */
function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NEWLINE) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  return { lines, tail: buf.subarray(start) };
}

/**
 * Message shape check, exact. Returns a typed message or `null` for "not a well-formed
 * message" — which the caller counts as a protocol error rather than ignoring.
 *
 * The standard applied is MCP's, not bare JSON-RPC 2.0, and the difference is deliberate in
 * exactly two places (review round 1, chunk 11 was right that JSON-RPC alone permits both):
 * JSON-RPC says a request id MUST be a String, Number or NULL and merely DISCOURAGES null and
 * fractional numbers, while MCP's base protocol requires a string or integer id and states
 * that it MUST NOT be null. This is an MCP transport, so MCP's rule is the one in force.
 *
 * Where neither standard imposes a rule, none is invented: an empty method name is a legal
 * string and is accepted, because pinning a stricter rule than the protocol into the judge of
 * a third-party client is how a conformant client gets recorded as a protocol violation.
 */
export function classifyMessage(value) {
  if (!isPlainObject(value)) return null;
  if (value.jsonrpc !== "2.0") return null;

  if ("method" in value) {
    if (typeof value.method !== "string") return null;
    if ("params" in value && !isPlainObject(value.params) && !Array.isArray(value.params)) return null;
    if ("result" in value || "error" in value) return null; // a request is not also a response
    if (!("id" in value)) return { kind: "notification", method: value.method, value };
    if (!isValidId(value.id)) return null; // MCP: a request id is a string or integer, never null
    return { kind: "request", id: value.id, method: value.method, value };
  }

  // No method: it must be a response.
  if (!("id" in value)) return null;
  if (!isValidId(value.id) && value.id !== null) return null;
  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (hasResult === hasError) return null; // exactly one, never both and never neither
  if (hasError) {
    const e = value.error;
    if (!isPlainObject(e) || !Number.isInteger(e.code) || typeof e.message !== "string") return null;
  }
  return { kind: "response", id: value.id, value };
}

/**
 * Frame one direction. Returns per-direction statistics plus the well-formed messages, in
 * order. A JSON-RPC batch (a top-level array) is expanded; an empty batch is a protocol error.
 */
function scanDirection(buf) {
  const { lines, tail } = splitLines(buf);
  const stats = {
    bytes: buf.length,
    lines: lines.length,
    messages: 0,
    // Always the unterminated tail, whether or not it would have parsed.
    remainder: tail.length,
    encodingErrors: 0,
    parseErrors: 0,
    protocolErrors: 0,
  };
  const messages = [];

  for (const raw of lines) {
    // A blank or whitespace-only TERMINATED line is stray output, not framing: newline-delimited
    // framing never produces one (a trailing newline ends the last line, it does not begin an
    // empty one), so "\n\n" on a stream whose purity is being asserted is unaccounted-for
    // content. Skipping it silently let bytes onto the protocol stream with every counter at
    // zero — the exact thing the stdout-purity oracle claims cannot happen (review round 1).
    if (raw.length === 0) {
      stats.protocolErrors += 1;
      continue;
    }
    let text;
    try {
      text = DECODER.decode(raw);
    } catch {
      stats.encodingErrors += 1;
      continue;
    }
    if (text.trim() === "") {
      stats.protocolErrors += 1;
      continue;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      stats.parseErrors += 1;
      continue;
    }
    const batch = Array.isArray(value);
    if (batch && value.length === 0) {
      stats.protocolErrors += 1;
      continue;
    }
    for (const item of batch ? value : [value]) {
      const msg = classifyMessage(item);
      if (msg === null) {
        stats.protocolErrors += 1;
        continue;
      }
      stats.messages += 1;
      messages.push(msg);
    }
  }

  return { stats, messages };
}

/** Recursively key-sorted JSON, so the digest cannot drift with object construction order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Only the protocol fields this probe judges, and only when they have the right type.
 *
 * Two round-2 corrections, both the same defect: a malformed observation was collapsed into a
 * value a well-formed one could also produce.
 *
 *   * `kind` records whether the response carried `result` or `error`. Without it an error
 *     response to tools/call produced a frame byte-identical to a result response with empty
 *     content — the run still failed, but for a reason the trace no longer contained.
 *   * A field of the WRONG TYPE (`protocolVersion: 42`, a tool entry that is not an object)
 *     used to become the same empty string an honest empty field produces. It is now counted as
 *     a protocol error, so the difference survives into the statistics, into the digest, and
 *     into the classifier — which requires that counter to be zero.
 */
function buildFrame(method, kind, result, noteProtocolError) {
  const frame = { type: "response", method, kind };
  const mistyped = () => noteProtocolError();
  if (method === "initialize") {
    if (result?.protocolVersion !== undefined && typeof result.protocolVersion !== "string") mistyped();
    frame.protocolVersion = typeof result?.protocolVersion === "string" ? result.protocolVersion : "";
  }
  if (method === "tools/list") {
    if (result?.tools !== undefined && !Array.isArray(result.tools)) mistyped();
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    frame.toolNames = tools.map((t) => {
      if (isPlainObject(t) && typeof t.name === "string") return t.name;
      mistyped();
      return "";
    });
  }
  if (method === "tools/call") {
    const nonce = result?.structuredContent?.nonce;
    if (nonce !== undefined && typeof nonce !== "string") mistyped();
    frame.structuredNonce = typeof nonce === "string" ? nonce : null;
    if (result?.content !== undefined && !Array.isArray(result.content)) mistyped();
    const content = Array.isArray(result?.content) ? result.content : [];
    const textPart = content.find((c) => isPlainObject(c) && c.type === "text" && typeof c.text === "string");
    frame.text = textPart ? textPart.text : "";
    if (result?.isError !== undefined && typeof result.isError !== "boolean") mistyped();
    frame.isError = result?.isError === true;
  }
  return frame;
}

export function normalize(clientToServerBuf, serverToClientBuf) {
  // `ArrayBuffer.isView` is true for Uint16Array, Float64Array and DataView as well, none of
  // which have single-byte elements — so newline scanning, `bytes` and `subarray` would all
  // mean something different, and DataView has no `subarray` at all (review round 2, chunk 7).
  for (const [name, buf] of [["clientToServerBuf", clientToServerBuf], ["serverToClientBuf", serverToClientBuf]]) {
    if (!(buf instanceof Uint8Array)) throw new TypeError(`normalize: ${name} must be a Buffer/Uint8Array`);
  }

  // Method attribution: responses carry only ids, so the request direction maps id -> method.
  const c2s = scanDirection(clientToServerBuf);
  const methodById = new Map();
  const ambiguous = new Set();
  for (const msg of c2s.messages) {
    if (msg.kind !== "request") continue;
    const key = idKey(msg.id);
    if (methodById.has(key) || ambiguous.has(key)) {
      // A repeated id destroys attribution: the previous mapping was silently overwritten
      // before (review round 1), so a response could be attributed to the wrong method. Neither
      // mapping survives.
      //
      // It is NOT counted as a protocol error (review round 2, chunk 7). MCP permits reusing an
      // id once its response has been received, and the two directions are captured as separate
      // streams with no interleaving between them — so nothing here can tell a legal sequential
      // reuse from an illegal in-flight one. Counting it asserted a verdict the evidence cannot
      // support, and would have recorded a conformant client as violating the protocol, which
      // is the exact failure this file warns about two comments above. Refusing to attribute is
      // what the evidence does support, and the classifier still fails a run whose response
      // cannot be attributed.
      methodById.delete(key);
      ambiguous.add(key);
    } else {
      methodById.set(key, msg.method);
    }
  }

  const s2c = scanDirection(serverToClientBuf);
  const frames = [];
  for (const msg of s2c.messages) {
    if (msg.kind !== "response") continue;
    const key = msg.id === null ? null : idKey(msg.id);
    const method = key === null ? "unknown" : ambiguous.has(key) ? "ambiguous" : (methodById.get(key) ?? "unknown");
    const kind = "result" in msg.value ? "result" : "error";
    frames.push(buildFrame(method, kind, kind === "result" ? msg.value.result : null, () => {
      s2c.stats.protocolErrors += 1;
    }));
  }

  // The digest covers the frames, both directions' statistics, AND a digest of each input
  // buffer. Frames alone let a stream carrying unaccounted bytes reproduce as a match (review
  // round 1). Frames plus counters was still not enough (review round 2, chunk 7): two captures
  // whose valid frames agree and whose rejected content differs only in CONTENT — a different
  // malformed line of the same length, a different unterminated tail of the same length, a
  // different invalid UTF-8 sequence — produce identical statistics and therefore digested
  // identically. Counts are not a substitute for the bytes they count, so the bytes are in.
  const trace = {
    version: TRACE_VERSION,
    frames,
    clientToServer: c2s.stats,
    serverStdout: s2c.stats,
    inputs: {
      clientToServerSha256: createHash("sha256").update(clientToServerBuf).digest("hex"),
      serverToClientSha256: createHash("sha256").update(serverToClientBuf).digest("hex"),
    },
  };
  return {
    frames,
    clientToServer: c2s.stats,
    serverStdout: s2c.stats,
    derivationDigest: createHash("sha256").update(canonicalJson(trace)).digest("hex"),
  };
}
