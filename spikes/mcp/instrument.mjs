// Resolution instrumentation preload (plan §2), copied into each assembled isolated root and
// loaded with `node --import ./instrument.mjs server.mjs`.
//
// It records EVERY module resolution to the ndjson file named by SPENDBAR_RESOLVE_LOG, on BOTH
// resolution paths: an ESM loader hook (registered below, running in the loader thread) and a
// CommonJS `Module._resolveFilename` patch (running here, in the main thread). An ESM hook
// alone would claim complete enumeration while silently missing everything reached through
// `require` — which for an SDK closure of this size is most of it. The CJS-only mutation in
// isolate.test.mjs exists to kill exactly that regression.
//
// It also records the creation of any DESCENDANT — a child process or a Worker. Those resolve
// their own modules in a process this instrument was never loaded into, so their resolutions
// cannot be enumerated here and "every resolution was inside the root" would be a claim about
// only part of what ran (review round 1, chunk 16). checkResolutions treats such an entry as a
// violation: the honest reading of an uninstrumented descendant is not "clean", it is "unknown".
//
// Recording is append-only writes to one file; the instrument resolves nothing itself and
// changes no resolution result.

import { register } from "node:module";
import Module from "node:module";
import child_process from "node:child_process";
import worker_threads from "node:worker_threads";
import { appendFileSync } from "node:fs";

const logPath = process.env.SPENDBAR_RESOLVE_LOG;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  const resolved = origResolve.call(this, request, ...rest);
  if (logPath) {
    appendFileSync(logPath, JSON.stringify({ kind: "cjs", request, resolved }) + "\n");
  }
  return resolved;
};

/**
 * Note an execution context whose resolutions this instrument cannot see.
 *
 * Written to a SIDECAR file, not into the resolution log: a descendant is not a resolution, and
 * the log's reader is entitled to assume every line in it is one. The conformance runner reads
 * this file and treats any entry as an isolation violation.
 */
const noteDescendant = (api) => {
  if (logPath) appendFileSync(`${logPath}.descendants`, JSON.stringify({ api }) + "\n");
};
// Same two-place patching as net-observe.mjs, and for the same reason: a builtin's ESM named
// exports are snapshotted before this preload can patch the module object, so the asynchronous
// funnel `ChildProcess.prototype.spawn` is what catches an `import { spawn }` call site.
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  if (typeof child_process[name] !== "function") continue;
  const original = child_process[name];
  child_process[name] = function (...args) {
    noteDescendant(`child_process.${name}`);
    return original.apply(this, args);
  };
}
if (typeof child_process.ChildProcess?.prototype?.spawn === "function") {
  const originalSpawn = child_process.ChildProcess.prototype.spawn;
  child_process.ChildProcess.prototype.spawn = function (...args) {
    noteDescendant("child_process.ChildProcess.spawn");
    return originalSpawn.apply(this, args);
  };
}
if (typeof worker_threads.Worker === "function") {
  const OriginalWorker = worker_threads.Worker;
  worker_threads.Worker = function Worker(...args) {
    noteDescendant("worker_threads.Worker");
    return new OriginalWorker(...args);
  };
  worker_threads.Worker.prototype = OriginalWorker.prototype;
}

register(new URL("./instrument-hooks.mjs", import.meta.url), { data: { logPath } });
