// Normalization: raw captured bytes -> the frame trace the classifier consumes (plan §6b/§9).
//
// A PURE function over the two retained streams (client->server, server->client), so the
// receipt verifier can re-run it over the retained raw capture and require byte-identical
// output — "the derivation is reproducible" is a checkable claim only because nothing here
// reads anything but its arguments.
//
// The server->client stream is fed through a streaming line parser with three recorded facts
// the pass oracle checks against the bytes that existed, not the frames that survived: total
// raw bytes, remainder length (an unterminated, unparseable tail), and parse-error count
// (complete lines that were not JSON).

import { createHash } from "node:crypto";

export function normalize(clientToServerBuf, serverToClientBuf) {
  // Method attribution: responses only carry ids; the request direction maps id -> method.
  const methodById = new Map();
  for (const line of clientToServerBuf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.method) methodById.set(msg.id, msg.method);
    } catch {
      // Client-direction noise is the client's business; only the server's stream has a
      // purity requirement.
    }
  }

  const text = serverToClientBuf.toString("utf8");
  const lines = text.split("\n");
  // Every element but the last is a newline-terminated complete line; the last is the tail
  // after the final newline ("" when the stream ended cleanly).
  const tail = lines.pop();
  const frames = [];
  let parseErrors = 0;

  const consume = (line) => {
    if (line === "") return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      parseErrors += 1;
      return;
    }
    if (msg.id === undefined || (!("result" in msg) && !("error" in msg))) return;
    const method = methodById.get(msg.id) ?? "unknown";
    const frame = { type: "response", method };
    if (method === "initialize") frame.protocolVersion = msg.result?.protocolVersion ?? "";
    if (method === "tools/list") frame.toolNames = (msg.result?.tools ?? []).map((t) => t.name);
    if (method === "tools/call") {
      frame.structuredNonce = msg.result?.structuredContent?.nonce;
      frame.text = msg.result?.content?.find((c) => c.type === "text")?.text ?? "";
      frame.isError = msg.result?.isError === true;
    }
    frames.push(frame);
  };

  for (const line of lines) consume(line);

  let remainder = 0;
  if (tail !== "") {
    // A tail that parses is a complete message that merely lacks its newline at EOF;
    // anything else is unconsumed remainder, measured in bytes.
    try {
      JSON.parse(tail);
      consume(tail);
    } catch {
      remainder = Buffer.byteLength(tail, "utf8");
    }
  }

  return {
    frames,
    serverStdout: { bytes: serverToClientBuf.length, remainder, parseErrors },
    derivationDigest: createHash("sha256").update(JSON.stringify(frames)).digest("hex"),
  };
}
