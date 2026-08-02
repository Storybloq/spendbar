// The tee wrapper the real client spawns as its "MCP server" (plan §9).
//
//   node capture-wrapper.mjs <isolated-root> <raw-capture-dir>
//
// It spawns the actual candidate server from the assembled isolated root and tees both
// directions raw, BEFORE any parsing: client->server bytes, server->client bytes, server
// stderr. This is what makes the stream-discipline oracle a claim about bytes that existed
// rather than frames that survived — and it is also where the §2 environment allowlist is
// ENFORCED AT PROCESS CREATION: whatever environment the client hands this wrapper, the
// candidate server's env is constructed from the literal allowlist, never inherited.
//
// Three corrections from review round 1 chunk 10, all the same shape — the tee must not claim
// more than it observed:
//
//   * BACKPRESSURE. Writes were fired and forgotten. If the server stopped reading, the tee
//     recorded bytes that were never delivered, and an EPIPE on a dead pipe took the wrapper
//     down with no exit record at all. Each direction now holds its source back until the sink
//     drains, and a delivery failure is COUNTED into a witness file rather than being either
//     invisible or fatal.
//   * `close`, NOT `exit`. `exit` fires before the child's stdout/stderr are drained, so the
//     tail of a run could be missing from both the tee and the client's view of the server.
//   * SIGNAL TERMINATION. `process.exit(code ?? 0)` reported a killed server as a clean exit,
//     and exiting mid-write truncated whatever was still queued. A signal now leaves through
//     the conventional 128+n, and the process is allowed to drain rather than being cut off.
//
// Every witness is on disk before the process leaves, so "the wrapper died telling us nothing"
// stays distinguishable from "the server ran and exited".

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildServerEnv } from "../isolate.mjs";

const [root, rawDir] = process.argv.slice(2);
if (!root || !rawDir) {
  process.stderr.write("capture-wrapper: usage: capture-wrapper.mjs <root> <raw-dir>\n");
  process.exit(2);
}

const tee = (name) => join(rawDir, name);
writeFileSync(tee("client-to-server.raw"), "");
writeFileSync(tee("server-stdout.raw"), "");
writeFileSync(tee("server-stderr.raw"), "");

// Wrapper state, rewritten in full on every change so the file is always complete rather than
// appended-to and possibly half-written.
const status = { spawned: false, closed: false, forwardErrors: 0, errorCode: null };
const writeStatus = () => writeFileSync(tee("wrapper-status.json"), JSON.stringify(status) + "\n");
const failForward = () => {
  status.forwardErrors += 1;
  writeStatus();
};
writeStatus();

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: buildServerEnv({}),
  stdio: ["pipe", "pipe", "pipe"],
});

// The spawn witness, taken from the events themselves. Inferring "the server started" from
// "some bytes came back" reports a server that started and then hung as one that never started
// — the difference between a conformance failure and a not-run.
child.on("spawn", () => {
  status.spawned = true;
  writeStatus();
});
child.on("error", (error) => {
  status.spawned = false;
  status.errorCode = error?.code ?? "unknown";
  writeStatus();
  process.exitCode = 3;
});

/** Tee `source` to `file`, forward to `sink`, and hold the source back until the sink drains. */
function teeAndForward(source, file, sink) {
  source.on("data", (chunk) => {
    appendFileSync(tee(file), chunk); // evidence first: what was sent is recorded even if delivery fails
    let accepted = false;
    try {
      accepted = sink.write(chunk);
    } catch {
      failForward();
      return;
    }
    if (!accepted) {
      source.pause();
      sink.once("drain", () => source.resume());
    }
  });
  source.on("error", failForward);
  sink.on("error", failForward);
}

teeAndForward(process.stdin, "client-to-server.raw", child.stdin);
teeAndForward(child.stdout, "server-stdout.raw", process.stdout);
teeAndForward(child.stderr, "server-stderr.raw", process.stderr);

process.stdin.on("end", () => child.stdin.end());

// `close` — every stdio stream of the child is drained and closed by the time it fires, so the
// tee files and the forwarded streams both hold the complete run.
child.on("close", (code, signal) => {
  writeFileSync(tee("server-exit.json"), JSON.stringify({ code, signal }) + "\n");
  status.closed = true;
  writeStatus();
  // Set the code and let Node leave once its own pending writes have flushed. Calling
  // process.exit() here would truncate whatever is still queued on stdout.
  process.exitCode = signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 0);
});
