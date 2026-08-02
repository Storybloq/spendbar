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

import { createHash } from "node:crypto";

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

/**
 * Exact, mutually-exclusive counter accounting. Asserting "the intended counter went up" is
 * satisfied by an implementation that increments two counters, or that returns a constant
 * remainder; this pins the WHOLE statistics object, so exactly one thing may differ from the
 * clean baseline (review round 1, chunk 11).
 */
function assertStats(actual, expected, label) {
  assert.deepEqual(
    {
      bytes: actual.bytes,
      lines: actual.lines,
      messages: actual.messages,
      remainder: actual.remainder,
      encodingErrors: actual.encodingErrors,
      parseErrors: actual.parseErrors,
      protocolErrors: actual.protocolErrors,
    },
    expected,
    label,
  );
}

/** The statistics of the clean fixture handshake, stated as literals rather than derived. */
const S2C_CLEAN_STATS = { bytes: HANDSHAKE_S2C.length, lines: 3, messages: 3, ...CLEAN };
const C2S_CLEAN_STATS = { bytes: HANDSHAKE_C2S.length, lines: 3, messages: 3, ...CLEAN };

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
  const tail = Buffer.from(JSON.stringify(res(4, {})));
  const truncated = Buffer.concat([HANDSHAKE_S2C, tail]);
  const t = normalize(HANDSHAKE_C2S, truncated);
  assert.equal(t.frames.length, 3, "the unterminated message was admitted as a frame");
  // The EXACT byte count, not merely "more than zero": a constant would satisfy that.
  assertStats(t.serverStdout, { ...S2C_CLEAN_STATS, bytes: truncated.length, remainder: tail.length }, "truncated tail");
});

test("a line that is not valid UTF-8 is counted as an encoding error, not repaired", () => {
  // Decoding the whole stream up front replaced the bad bytes with U+FFFD, after which the
  // line either parsed anyway or counted as a parse error. Either way the corruption vanished.
  const bad = Buffer.concat([HANDSHAKE_S2C, Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])]);
  const t = normalize(HANDSHAKE_C2S, bad);
  assertStats(t.serverStdout, { ...S2C_CLEAN_STATS, bytes: bad.length, lines: 4, encodingErrors: 1 }, "invalid utf-8");
  assert.equal(t.frames.length, 3);
});

test("a complete line that is not JSON is a parse error", () => {
  const noisy = Buffer.concat([HANDSHAKE_S2C, Buffer.from("server crashed\n")]);
  const t = normalize(HANDSHAKE_C2S, noisy);
  assertStats(t.serverStdout, { ...S2C_CLEAN_STATS, bytes: noisy.length, lines: 4, parseErrors: 1 }, "non-JSON line");
});

test("JSON that is not a JSON-RPC 2.0 message is COUNTED, not silently ignored", () => {
  const notMessages = [
    { hello: "world" }, // no jsonrpc
    { jsonrpc: "1.0", id: 9, result: {} }, // wrong version
    { jsonrpc: "2.0", id: 9 }, // neither result nor error
    { jsonrpc: "2.0", id: 9, result: {}, error: { code: -1, message: "x" } }, // both
    { jsonrpc: "2.0", id: 1.5, method: "x" }, // MCP: a request id is a string or INTEGER
    { jsonrpc: "2.0", id: null, method: "x" }, // MCP: a request id MUST NOT be null
    { jsonrpc: "2.0", id: 9, error: { code: "boom", message: "x" } }, // non-integer error code
    "[]", // an empty batch
    "42", // a bare scalar
  ];
  for (const item of notMessages) {
    const bytes = Buffer.concat([HANDSHAKE_S2C, stream(item)]);
    const t = normalize(HANDSHAKE_C2S, bytes);
    assertStats(
      t.serverStdout,
      { ...S2C_CLEAN_STATS, bytes: bytes.length, lines: 4, protocolErrors: 1 },
      JSON.stringify(item),
    );
    assert.equal(t.frames.length, 3, `${JSON.stringify(item)} became a frame`);
  }
});

test("what JSON-RPC permits but merely discourages is judged by MCP's rule, not invented", () => {
  // Review round 1, chunk 11: bare JSON-RPC allows a null or fractional request id and an empty
  // method name. MCP's base protocol requires a string-or-integer id and forbids null, so those
  // two stay violations — but an empty method name is legal in both, so it is accepted rather
  // than pinned stricter than the protocol the client is being judged against.
  const empty = Buffer.concat([HANDSHAKE_S2C, stream({ jsonrpc: "2.0", method: "" })]);
  const t = normalize(HANDSHAKE_C2S, empty);
  assertStats(t.serverStdout, { ...S2C_CLEAN_STATS, bytes: empty.length, lines: 4, messages: 4 }, "empty method name");
  assert.equal(classifyMessage({ jsonrpc: "2.0", method: "" }).kind, "notification");
  // And the two MCP tightenings, stated as such.
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: null, method: "x" }), null, "MCP: a request id is never null");
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: 1.5, method: "x" }), null, "MCP: a request id is an integer");
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
  const mixed = Buffer.from(JSON.stringify([res(1, { protocolVersion: "2025-06-18" }), { nope: true }]) + "\n");
  const t = normalize(stream(req(1, "initialize")), mixed);
  assert.deepEqual(t.frames.map((f) => f.method), ["initialize"]);
  assertStats(
    t.serverStdout,
    { bytes: mixed.length, lines: 1, messages: 1, remainder: 0, encodingErrors: 0, parseErrors: 0, protocolErrors: 1 },
    "mixed batch",
  );

  // An all-valid batch: every member becomes a message and a frame, so "handles the first and
  // counts one generic error" does not satisfy this.
  const c2s = stream(req(1, "initialize"), req(2, "tools/list"));
  const allValid = Buffer.from(
    JSON.stringify([res(1, { protocolVersion: "2025-06-18" }), res(2, { tools: [{ name: "spendbar_probe" }] })]) + "\n",
  );
  const u = normalize(c2s, allValid);
  assert.deepEqual(u.frames.map((f) => f.method), ["initialize", "tools/list"]);
  assertStats(
    u.serverStdout,
    { bytes: allValid.length, lines: 1, messages: 2, remainder: 0, encodingErrors: 0, parseErrors: 0, protocolErrors: 0 },
    "all-valid batch",
  );

  // Two invalid members increment twice, not once.
  const twoBad = Buffer.from(JSON.stringify([{ nope: true }, { alsoNope: true }]) + "\n");
  assert.equal(normalize(c2s, twoBad).serverStdout.protocolErrors, 2);
});

test("the client direction is judged by the same rules, not merely read for attribution", () => {
  // Every framing failure has a client-direction counterpart. Without these an implementation
  // that computed the client counters as constants would pass the whole suite.
  const cases = [
    ["invalid utf-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]), { lines: 4, encodingErrors: 1 }],
    ["non-JSON", Buffer.from("client noise\n"), { lines: 4, parseErrors: 1 }],
    ["non-JSON-RPC JSON", stream({ hello: "world" }), { lines: 4, protocolErrors: 1 }],
    ["stray blank line", Buffer.from("\n"), { lines: 4, protocolErrors: 1 }],
  ];
  for (const [label, extra, delta] of cases) {
    const c2s = Buffer.concat([HANDSHAKE_C2S, extra]);
    const t = normalize(c2s, HANDSHAKE_S2C);
    assertStats(t.clientToServer, { ...C2S_CLEAN_STATS, bytes: c2s.length, ...delta }, label);
    // Attribution still works for the requests that WERE well formed.
    assert.deepEqual(t.frames.map((f) => f.method), ["initialize", "tools/list", "tools/call"], label);
  }

  // An unterminated client tail is remainder, and the request inside it is never attributed.
  const tail = Buffer.from(JSON.stringify(req(4, "tools/call")));
  const c2s = Buffer.concat([stream(req(1, "initialize")), tail]);
  const t = normalize(c2s, stream(res(1, { protocolVersion: "x" }), res(4, {})));
  assert.equal(t.clientToServer.remainder, tail.length);
  assert.deepEqual(t.frames.map((f) => f.method), ["initialize", "unknown"]);
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

test("a blank or whitespace-only line on a purity-checked stream is unaccounted-for content", () => {
  // Newline-delimited framing never produces an empty terminated line — a trailing newline ends
  // the last line rather than starting a new one. Tolerating them silently let bytes sit on the
  // protocol stream with every counter at zero, which is what stdout-purity claims cannot happen.
  const stray = Buffer.concat([HANDSHAKE_S2C, Buffer.from("\n   \n")]);
  const t = normalize(HANDSHAKE_C2S, stray);
  assertStats(t.serverStdout, { ...S2C_CLEAN_STATS, bytes: stray.length, lines: 5, protocolErrors: 2 }, "stray blank lines");
  assert.equal(t.frames.length, 3, "the frames themselves are unaffected");
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

test("the digest is over the documented canonical form, version included", () => {
  // Asserting the exported constant proves nothing about the digest — the implementation could
  // omit the version entirely and still pass. This recomputes the documented representation
  // INDEPENDENTLY (a separate key-sorting serializer) and requires the digest to equal it, so
  // both the structure and the version's presence in it are pinned.
  const canonical = (v) => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object") {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
    }
    return JSON.stringify(v ?? null);
  };
  const t = normalize(HANDSHAKE_C2S, HANDSHAKE_S2C);
  const expected = createHash("sha256")
    .update(
      canonical({
        version: TRACE_VERSION,
        frames: t.frames,
        clientToServer: t.clientToServer,
        serverStdout: t.serverStdout,
      }),
    )
    .digest("hex");
  assert.equal(t.derivationDigest, expected, "the digest is not over {version, frames, both directions' stats}");

  // The negative control: the same structure under a different version digests differently, so
  // the version is load-bearing rather than merely present in the source.
  const other = createHash("sha256")
    .update(canonical({ version: "normalize/1", frames: t.frames, clientToServer: t.clientToServer, serverStdout: t.serverStdout }))
    .digest("hex");
  assert.notEqual(expected, other);
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
