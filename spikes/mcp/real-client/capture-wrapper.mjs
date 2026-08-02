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
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildServerEnv } from "../isolate.mjs";
import { isDirectEntry } from "../../../scripts/direct-entry.mjs";

/**
 * What this process must exit with, given how the child left (review round 2, chunk 4).
 *
 * Pulled out as a pure function because the previous version was three inline expressions that
 * could not be tested without spawning a real client, and one of them was wrong in two ways at
 * once: it recomputed the code from scratch after a spawn FAILURE, discarding the 3 the error
 * handler had set — on this machine a spawn that never happened closes with code -2, the raw
 * negative errno — and it mapped an unexplained null code to 0, which publishes "no server ever
 * started" as success.
 */
export function exitCodeFor({ spawnFailed, code, signal, signals = osConstants.signals }) {
  if (spawnFailed) return 3;
  if (signal) return 128 + (signals[signal] ?? 0);
  // A null code with no signal means the child left for a reason nobody recorded. That is a
  // failure to observe the run, and it is never success.
  return code ?? 1;
}

// Everything below runs only when node was pointed at this file — which is how the real client
// spawns it. Importing the module for `exitCodeFor` must not spawn a server.
if (isDirectEntry(import.meta.url)) {

const [root, rawDir] = process.argv.slice(2);
if (!root || !rawDir) {
  process.stderr.write("capture-wrapper: usage: capture-wrapper.mjs <root> <raw-dir>\n");
  process.exit(2);
}

const tee = (name) => join(rawDir, name);
writeFileSync(tee("client-to-server.raw"), "");
writeFileSync(tee("server-stdout.raw"), "");
writeFileSync(tee("server-stderr.raw"), "");

// Wrapper state. Rewritten in full on every change — but WRITTEN TO A TEMPORARY FILE AND
// RENAMED over the real one (review round 2, chunk 4). The previous spelling was a plain
// writeFileSync, which truncates first and then writes: a SIGKILL between those two steps left
// an empty or half-written witness, and the comment here used to claim the opposite. rename(2)
// is atomic within a directory, so a reader sees either the previous complete state or the new
// complete state, never a partial one.
const status = { spawned: false, closed: false, forwardErrors: 0, errorCode: null };
let statusSeq = 0;
const writeStatus = () => {
  const tmp = tee(`.wrapper-status.${process.pid}.${statusSeq++}.tmp`);
  writeFileSync(tmp, JSON.stringify(status) + "\n");
  renameSync(tmp, tee("wrapper-status.json"));
};
const failForward = () => {
  status.forwardErrors += 1;
  writeStatus();
};
writeStatus();

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  // NOT audited, said out loud. A real-client capture runs the candidate server as the client's
  // MCP server, and adding a resolution log here would put a fifth stream in the retained
  // capture that the receipt roster, the manifest schema and the sanitizer all know nothing
  // about. The resolution audit is therefore the scripted matrix's guarantee, not this cell's,
  // and verify-evidence qualifies every real-client pass accordingly rather than letting a
  // reader assume otherwise (review round 2, chunk 5).
  env: buildServerEnv({ unaudited: "real-client capture: resolutions are audited by the scripted matrix, not here" }),
  stdio: ["pipe", "pipe", "pipe"],
});

// The spawn witness, taken from the events themselves. Inferring "the server started" from
// "some bytes came back" reports a server that started and then hung as one that never started
// — the difference between a conformance failure and a not-run.
child.on("spawn", () => {
  status.spawned = true;
  writeStatus();
});
// A spawn failure is remembered, not just written down. `error` used to set exitCode = 3 and
// stop there — but Node emits `close` after a failed spawn too, and the close handler
// recomputed the code from scratch. Observed on this machine: a spawn that never happened
// closes with code = -2 (the raw negative errno), so the documented 3 was overwritten by a
// number that means nothing to a shell, and a close reporting a null code with no signal would
// have been published as SUCCESS.
let spawnFailed = false;
child.on("error", (error) => {
  spawnFailed = true;
  status.spawned = false;
  status.errorCode = error?.code ?? "unknown";
  writeStatus();
  process.exitCode = 3;
});

/**
 * Tee `source` to `file`, forward to `sink`, and hold the source back until the sink drains.
 *
 * The backpressure pairing has to survive the sink dying (review round 2, chunk 4). The first
 * version paused the source and waited for a single `drain`; if the sink errored or closed
 * while the source was paused, that `drain` never arrived and the source stayed paused
 * FOREVER. For the client->server direction that means `end` never fires on stdin, so
 * `child.stdin.end()` is never called, so the server never sees EOF and the whole wrapper hangs
 * holding a paid run. Every path that can end the sink now also releases the source.
 */
function teeAndForward(source, file, sink) {
  let waitingForDrain = null;
  let dead = false;

  const release = () => {
    if (waitingForDrain) {
      sink.off("drain", waitingForDrain);
      waitingForDrain = null;
    }
    source.resume();
  };
  // The sink is gone: stop forwarding, keep TEEING. What the client sent is evidence whether or
  // not it was delivered, and the delivery failure is counted rather than hidden.
  const kill = () => {
    if (dead) return;
    dead = true;
    failForward();
    release();
  };

  source.on("data", (chunk) => {
    appendFileSync(tee(file), chunk); // evidence first: what was sent is recorded even if delivery fails
    if (dead) return;
    let accepted = false;
    try {
      accepted = sink.write(chunk);
    } catch {
      kill();
      return;
    }
    if (!accepted) {
      source.pause();
      waitingForDrain = () => {
        waitingForDrain = null;
        source.resume();
      };
      sink.once("drain", waitingForDrain);
    }
  });
  source.on("error", failForward);
  sink.on("error", kill);
  sink.on("close", kill);
  return { stop: kill };
}

const fromClient = teeAndForward(process.stdin, "client-to-server.raw", child.stdin);
teeAndForward(child.stdout, "server-stdout.raw", process.stdout);
teeAndForward(child.stderr, "server-stderr.raw", process.stderr);

process.stdin.on("end", () => child.stdin.end());

// `close` — every stdio stream of the child is drained and closed by the time it fires, so the
// tee files and the forwarded streams both hold the complete run.
child.on("close", (code, signal) => {
  writeFileSync(tee("server-exit.json"), JSON.stringify({ code, signal }) + "\n");
  status.closed = true;
  writeStatus();
  // The server is gone, so nothing can consume client input any more. Leaving the stdin reader
  // attached kept a referenced handle open — the wrapper could outlive its own purpose waiting
  // for a client that was itself waiting for the wrapper — and any bytes still arriving were
  // written at a closed pipe. Detach, record anything further as the delivery failure it is,
  // and let the process leave.
  fromClient.stop();
  process.stdin.pause();
  process.stdin.unref?.();
  // Set the code and let Node leave once its own pending writes have flushed. Calling
  // process.exit() here would truncate whatever is still queued on stdout.
  process.exitCode = exitCodeFor({ spawnFailed, code, signal });
});

}
