// Mutant probe servers for the conformance suite (plan §5): a hand-rolled JSON-RPC stdio
// responder whose SPENDBAR_MUTANT env var selects one named defect. Each conformance case
// must FAIL against its mutant(s) — that is what proves the case measures behavior instead of
// passing vacuously. `SPENDBAR_MUTANT=none` is the correct baseline and must pass all eight.
//
// Hand-rolled on purpose: a mutant built on either SDK would test the SDK's ability to
// misbehave, not the suite's ability to notice.

import { createInterface } from "node:readline";
import { isDirectEntry } from "../../scripts/direct-entry.mjs";

const MUTANT = process.env.SPENDBAR_MUTANT ?? "none";

export const MUTANTS = [
  "none",
  "blank-version", // initialize reports an empty protocolVersion
  "tool-absent", // tools/list omits the probe tool
  "schema-drop", // tools/list keeps the tool but drops its schema fields
  "no-structured", // tools/call succeeds without structuredContent
  "empty-text", // tools/call text fallback is an empty string
  "framing-wrong-code", // malformed line answered with -32601 instead of -32700/silence
  "framing-garbage", // malformed line answered with non-JSON bytes on stdout
  "framing-late", // malformed line answered with -32601, but only after the grace window
  "framing-dies", // malformed line kills the server
  "args-accept", // schema-violating arguments accepted silently
  "args-crash", // schema-violating arguments kill the server
  "cancel-ignored", // cancellation notification does nothing; the handler burns its full blockMs
  "cancel-wedged", // honors the cancellation, then stops answering entirely
  "eof-alive", // the process outlives client EOF
  "stdout-noise", // a non-JSON-RPC line is written to stdout
  "stdout-blank-lines", // stray empty lines on the protocol stream — framing never produces one
  "stdout-unterminated", // a final frame is written at EOF without its newline
  "stderr-silent", // no log line ever reaches stderr
];

// Everything below runs ONLY when this file is the entry point. Importing MUTANTS must be
// side-effect free: executing the server on import attaches a readline interface to the
// IMPORTING process's stdin — which is exactly the lingering reference that kept test-runner
// child processes alive (review round 1 found the root cause the earlier header guessed at).
function main() {
const out = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
  // Stray empty lines: newline framing never produces one, so these are unaccounted-for bytes
  // on a stream whose purity is the asserted property.
  if (MUTANT === "stdout-blank-lines") process.stdout.write("\n\n");
};
const log = (line) => {
  if (MUTANT !== "stderr-silent") process.stderr.write(`${line}\n`);
};

const PROBE_SCHEMA = {
  type: "object",
  properties: {
    nonce: { type: "string", minLength: 1 },
    blockMs: { type: "integer", minimum: 0, maximum: 60000 },
  },
  required: ["nonce"],
  additionalProperties: false,
};

if (MUTANT === "stdout-noise") process.stdout.write("log: mutant server starting\n");
log(`spendbar-probe-server ready mutant:${MUTANT}`);

let wedged = false;
const pendingBlocks = new Map(); // request id -> {timer, respond, nonce}

function respondProbe(id, args) {
  const nonce = args.nonce;
  const structuredContent = { nonce, blocked: Boolean(args.blockMs) };
  const result = {
    content: [{ type: "text", text: MUTANT === "empty-text" ? "" : `probe nonce=${nonce} blocked=${structuredContent.blocked}` }],
  };
  if (MUTANT !== "no-structured") result.structuredContent = structuredContent;
  out({ jsonrpc: "2.0", id, result });
}

function handle(msg) {
  if (wedged) return;
  const { id, method, params } = msg;
  if (method === "initialize") {
    out({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MUTANT === "blank-version" ? "" : params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "spendbar-probe-mutant", version: "0.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") {
    if (MUTANT === "cancel-ignored") return;
    const pending = pendingBlocks.get(params?.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingBlocks.delete(params.requestId);
      log(`probe-handler-released ${pending.nonce} aborted=true`);
      // Per MCP, a cancelled request gets no response.
    }
    // cancel-wedged honors the cancellation itself, then stops answering ANYTHING — so its
    // kill exercises the wedged-server clause, not cancel-ignored's release-witness clause.
    if (MUTANT === "cancel-wedged") wedged = true;
    return;
  }
  if (method === "tools/list") {
    const tools =
      MUTANT === "tool-absent"
        ? []
        : [
            {
              name: "spendbar_probe",
              description: "mutant probe",
              inputSchema: MUTANT === "schema-drop" ? { type: "object" } : PROBE_SCHEMA,
              outputSchema: {
                type: "object",
                properties: { nonce: { type: "string" }, blocked: { type: "boolean" } },
                required: ["nonce", "blocked"],
                additionalProperties: false,
              },
            },
          ];
    out({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const args = params?.arguments ?? {};
    const badType = typeof args.nonce !== "string" || args.nonce.length === 0;
    const badBlock =
      args.blockMs !== undefined &&
      (typeof args.blockMs !== "number" || !Number.isInteger(args.blockMs) || args.blockMs < 0 || args.blockMs > 60000);
    const extraKeys = Object.keys(args).filter((k) => k !== "nonce" && k !== "blockMs");
    if (badType || badBlock || extraKeys.length > 0) {
      if (MUTANT === "args-accept") return respondProbe(id, { ...args, nonce: String(args.nonce) });
      if (MUTANT === "args-crash") process.exit(1);
      out({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "Input validation error: invalid arguments for tool spendbar_probe" }],
          isError: true,
        },
      });
      return;
    }
    log(`probe-handler-started ${args.nonce}`);
    if (args.blockMs > 0) {
      const timer = setTimeout(() => {
        pendingBlocks.delete(id);
        log(`probe-handler-released ${args.nonce} aborted=false`);
        respondProbe(id, args);
      }, args.blockMs);
      pendingBlocks.set(id, { timer, nonce: args.nonce });
      return;
    }
    respondProbe(id, args);
    return;
  }
  if (id !== undefined) {
    out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    if (MUTANT === "framing-dies") process.exit(1);
    if (MUTANT === "framing-wrong-code") {
      out({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "parse error" } });
    }
    if (MUTANT === "framing-garbage") {
      // Neither silence nor a JSON-RPC error: bytes on the protocol stream that no reader can
      // frame. A suite that only inspects PARSED null-id errors sees this as silence.
      process.stdout.write("E: could not parse that\n");
    }
    if (MUTANT === "framing-late") {
      // The same wrong code, delivered after any fixed grace window has closed. A suite that
      // decides silence-versus-wrong-code at a deadline never sees it.
      setTimeout(() => out({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "late parse error" } }), 1_200);
    }
    // Correct baseline: drop the malformed line and keep serving (matches both real SDKs).
    return;
  }
  handle(msg);
});
rl.on("close", () => {
  if (MUTANT === "eof-alive") setInterval(() => {}, 1 << 30);
  // A final frame written WITHOUT its newline, at the moment the stream ends. The bytes are
  // valid JSON, so a reader that splits on newline and drops the tail sees a clean stream —
  // which is indistinguishable from a stream that was cut off mid-write.
  if (MUTANT === "stdout-unterminated") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } }));
  }
});
}

if (isDirectEntry(import.meta.url)) main();
