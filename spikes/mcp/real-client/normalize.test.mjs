// Tests for the capture normalizer (plan §6b/§9), added in review round 1.
//
// Normalization is the ONLY thing standing between the raw bytes and the classifier, and it
// used to be silently lossy in three ways at once: the whole stream was decoded as UTF-8 with
// replacement characters before framing, JSON that was not a JSON-RPC message was dropped
// without being counted, and a valid-looking unterminated tail was admitted as a frame. Each
// one turns "the parser could not account for these bytes" into "there was nothing there".
//
// Runs under `node --test` or directly (`node spikes/mcp/real-client/normalize.test.mjs`).

import test from "node:test";
import assert from "node:assert/strict";

import { normalize, classifyMessage, TRACE_VERSION } from "./normalize.mjs";

/** Newline-terminated stream: objects are serialized, strings are written verbatim. */
const stream = (...parts) =>
  Buffer.from(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\n") + "\n");

const req = (id, method) => ({ jsonrpc: "2.0", id, method });
const res = (id, result) => ({ jsonrpc: "2.0", id, result });

const HANDSHAKE_C2S = stream(req(1, "initialize"), req(2, "tools/list"), req(3, "tools/call"));
const HANDSHAKE_S2C = stream(
  res(1, { protocolVersion: "2025-06-18" }),
  res(2, { tools: [{ name: "spendbar_probe" }] }),
  res(3, { structuredContent: { nonce: "n1" }, content: [{ type: "text", text: "nonce n1" }], isError: false }),
);

const CLEAN = { encodingErrors: 0, parseErrors: 0, protocolErrors: 0, remainder: 0 };
const counters = (s) => ({
  encodingErrors: s.encodingErrors,
  parseErrors: s.parseErrors,
  protocolErrors: s.protocolErrors,
  remainder: s.remainder,
});

test("a clean handshake produces the three attributed frames and no failure counters", () => {
  const t = normalize(HANDSHAKE_C2S, HANDSHAKE_S2C);
  assert.deepEqual(
    t.frames.map((f) => f.method),
    ["initialize", "tools/list", "tools/call"],
  );
  assert.equal(t.frames[0].protocolVersion, "2025-06-18");
  assert.deepEqual(t.frames[1].toolNames, ["spendbar_probe"]);
  assert.equal(t.frames[2].structuredNonce, "n1");
  assert.equal(t.frames[2].text, "nonce n1");
  assert.equal(t.frames[2].isError, false);
  assert.deepEqual(counters(t.serverStdout), CLEAN);
  assert.deepEqual(counters(t.clientToServer), CLEAN);
  assert.equal(t.serverStdout.messages, 3);
});

test("a valid but UNTERMINATED tail is remainder, never a frame", () => {
  // A line without its newline is indistinguishable from a line that was truncated mid-write.
  // Admitting it let a stream that was cut short pass as a complete one.
  const truncated = Buffer.concat([HANDSHAKE_S2C, Buffer.from(JSON.stringify(res(4, {})))]);
  const t = normalize(HANDSHAKE_C2S, truncated);
  assert.equal(t.frames.length, 3, "the unterminated message was admitted as a frame");
  assert.ok(t.serverStdout.remainder > 0, "the unterminated bytes were not counted as remainder");
});

test("a line that is not valid UTF-8 is counted as an encoding error, not repaired", () => {
  // Decoding the whole stream up front replaced the bad bytes with U+FFFD, after which the
  // line either parsed anyway or counted as a parse error. Either way the corruption vanished.
  const bad = Buffer.concat([HANDSHAKE_S2C, Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])]);
  const t = normalize(HANDSHAKE_C2S, bad);
  assert.equal(t.serverStdout.encodingErrors, 1);
  assert.equal(t.serverStdout.parseErrors, 0, "an undecodable line must not be misreported as bad JSON");
  assert.equal(t.frames.length, 3);
});

test("a complete line that is not JSON is a parse error", () => {
  const t = normalize(HANDSHAKE_C2S, Buffer.concat([HANDSHAKE_S2C, Buffer.from("server crashed\n")]));
  assert.equal(t.serverStdout.parseErrors, 1);
  assert.equal(t.serverStdout.protocolErrors, 0);
});

test("JSON that is not a JSON-RPC 2.0 message is COUNTED, not silently ignored", () => {
  const notMessages = [
    { hello: "world" }, // no jsonrpc
    { jsonrpc: "1.0", id: 9, result: {} }, // wrong version
    { jsonrpc: "2.0", id: 9 }, // neither result nor error
    { jsonrpc: "2.0", id: 9, result: {}, error: { code: -1, message: "x" } }, // both
    { jsonrpc: "2.0", id: 1.5, method: "x" }, // fractional id
    { jsonrpc: "2.0", id: null, method: "x" }, // only error responses may carry a null id
    { jsonrpc: "2.0", method: "" }, // empty method
    { jsonrpc: "2.0", id: 9, error: { code: "boom", message: "x" } }, // non-integer error code
    "[]", // an empty batch
    "42", // a bare scalar
  ];
  for (const item of notMessages) {
    const t = normalize(HANDSHAKE_C2S, Buffer.concat([HANDSHAKE_S2C, stream(item)]));
    assert.equal(t.serverStdout.protocolErrors, 1, JSON.stringify(item));
    assert.equal(t.serverStdout.parseErrors, 0, JSON.stringify(item));
    assert.equal(t.frames.length, 3, `${JSON.stringify(item)} became a frame`);
  }
});

test("notifications and server-initiated requests are legal traffic, not errors and not frames", () => {
  const extra = stream(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 100, method: "sampling/createMessage", params: {} },
  );
  const t = normalize(HANDSHAKE_C2S, Buffer.concat([HANDSHAKE_S2C, extra]));
  assert.deepEqual(counters(t.serverStdout), CLEAN);
  assert.equal(t.frames.length, 3, "a non-response message became a frame");
  assert.equal(t.serverStdout.messages, 5);
});

test("a batch is expanded and each member is judged on its own", () => {
  const batch = Buffer.from(JSON.stringify([res(1, { protocolVersion: "2025-06-18" }), { nope: true }]) + "\n");
  const t = normalize(stream(req(1, "initialize")), batch);
  assert.equal(t.frames.length, 1);
  assert.equal(t.serverStdout.protocolErrors, 1);
});

test("a reused request id is counted AND makes the response unattributable, never misattributed", () => {
  // The old map overwrote silently, so the response to request 1 was reported as whichever
  // method happened to be written last — a wrong method with no trace that anything was wrong.
  const c2s = stream(req(1, "initialize"), req(1, "tools/call"));
  const t = normalize(c2s, stream(res(1, { protocolVersion: "2025-06-18" })));
  assert.equal(t.clientToServer.protocolErrors, 1);
  assert.deepEqual(
    t.frames.map((f) => f.method),
    ["ambiguous"],
  );
});

test("a response to an id that was never requested is unattributed, not guessed", () => {
  const t = normalize(stream(req(1, "initialize")), stream(res(7, {})));
  assert.deepEqual(
    t.frames.map((f) => f.method),
    ["unknown"],
  );
});

test("a string id and the numeric id that prints the same are different requests", () => {
  const c2s = stream(req(1, "initialize"), req("1", "tools/list"));
  const t = normalize(c2s, stream(res(1, { protocolVersion: "x" }), res("1", { tools: [] })));
  assert.deepEqual(
    t.frames.map((f) => f.method),
    ["initialize", "tools/list"],
  );
  assert.equal(t.clientToServer.protocolErrors, 0, "distinct id types were treated as a collision");
});

test("blank and whitespace-only framing lines are neither messages nor failures", () => {
  const t = normalize(HANDSHAKE_C2S, Buffer.concat([HANDSHAKE_S2C, Buffer.from("\n   \n")]));
  assert.deepEqual(counters(t.serverStdout), CLEAN);
  assert.equal(t.frames.length, 3);
});

test("CRLF-terminated frames parse: the trailing carriage return is JSON whitespace", () => {
  const crlf = Buffer.from(JSON.stringify(res(1, { protocolVersion: "2025-06-18" })) + "\r\n");
  const t = normalize(stream(req(1, "initialize")), crlf);
  assert.equal(t.frames.length, 1);
  assert.deepEqual(counters(t.serverStdout), CLEAN);
});

// ---------- the derivation digest --------------------------------------------------------------

test("the digest covers the stream statistics, not only the frames", () => {
  // Two runs whose surviving frames are identical but whose streams differ: digesting only the
  // frames made the second reproduce as the first, and the unaccounted-for bytes disappeared.
  const clean = normalize(HANDSHAKE_C2S, HANDSHAKE_S2C);
  const noisy = normalize(HANDSHAKE_C2S, Buffer.concat([HANDSHAKE_S2C, Buffer.from("garbage\n")]));
  assert.deepEqual(noisy.frames, clean.frames, "the fixture must differ only in the statistics");
  assert.notEqual(noisy.derivationDigest, clean.derivationDigest);
});

test("the digest is stable across repeated derivation of the same bytes", () => {
  const a = normalize(HANDSHAKE_C2S, HANDSHAKE_S2C);
  const b = normalize(Buffer.from(HANDSHAKE_C2S), Buffer.from(HANDSHAKE_S2C));
  assert.equal(a.derivationDigest, b.derivationDigest);
  assert.match(a.derivationDigest, /^[0-9a-f]{64}$/);
});

test("the digest changes when the client direction changes, even with identical server bytes", () => {
  const a = normalize(HANDSHAKE_C2S, HANDSHAKE_S2C);
  const b = normalize(Buffer.concat([HANDSHAKE_C2S, Buffer.from("junk\n")]), HANDSHAKE_S2C);
  assert.notEqual(a.derivationDigest, b.derivationDigest);
});

test("the trace version is part of the derivation, so old traces cannot match a new one", () => {
  assert.equal(TRACE_VERSION, "normalize/2");
});

// ---------- inputs ------------------------------------------------------------------------------

test("non-buffer input is refused rather than coerced", () => {
  for (const bad of [null, undefined, "{}", 42, {}]) {
    assert.throws(() => normalize(bad, HANDSHAKE_S2C), TypeError);
    assert.throws(() => normalize(HANDSHAKE_C2S, bad), TypeError);
  }
});

test("empty streams derive an empty trace rather than failing", () => {
  const t = normalize(Buffer.alloc(0), Buffer.alloc(0));
  assert.deepEqual(t.frames, []);
  assert.equal(t.serverStdout.bytes, 0);
  assert.deepEqual(counters(t.serverStdout), CLEAN);
});

test("classifyMessage is exact about the three JSON-RPC shapes", () => {
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: 1, method: "x" }).kind, "request");
  assert.equal(classifyMessage({ jsonrpc: "2.0", method: "x" }).kind, "notification");
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: 1, result: {} }).kind, "response");
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: null, error: { code: -1, message: "x" } }).kind, "response");
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: 1, method: "x", result: {} }), null);
  assert.equal(classifyMessage(null), null);
  assert.equal(classifyMessage([{ jsonrpc: "2.0", id: 1, result: {} }]), null);
});
