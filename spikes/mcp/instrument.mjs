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
// That claim was FALSE until review round 2, chunk 4 [sic: chunk 6]. Patching a property on the
// builtin's module object does not touch the named exports Node already snapshotted for ESM, so
// `import { spawnSync } from "node:child_process"` held the ORIGINAL function and created a
// descendant that was never recorded — while the resolution log still showed in-root entries and
// zero violations. Demonstrated directly: with the property patched and nothing else, a named
// import records nothing; with `syncBuiltinESMExports()` after the patches, it records. That call
// is now the last thing this preload does, and it is what makes the enumeration claim true.
//
// Recording is append-only writes to one file; the instrument resolves nothing itself and
// changes no resolution result.

import { register, syncBuiltinESMExports } from "node:module";
import Module from "node:module";
import child_process from "node:child_process";
import worker_threads from "node:worker_threads";
import { appendFileSync, writeFileSync } from "node:fs";

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
const DESCENDANT_SIDECAR = logPath ? `${logPath}.descendants` : null;
// Created EMPTY at preload, before anything can spawn. Without it, an absent sidecar meant both
// "no descendant was created" and "the instrument never ran / could not write", and the reader
// resolved that ambiguity in favour of clean (review round 2, chunk 6). Its existence is now the
// instrument's own witness; descendantsFor refuses when it is missing.
if (DESCENDANT_SIDECAR) writeFileSync(DESCENDANT_SIDECAR, "");

const noteDescendant = (api) => {
  // Deliberately NOT swallowed. If the record cannot be written, the honest outcome is a process
  // that fails loudly, not one that creates an unobserved descendant and looks clean.
  if (DESCENDANT_SIDECAR) appendFileSync(DESCENDANT_SIDECAR, JSON.stringify({ api }) + "\n");
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
// A Proxy with only a `construct` trap, not a replacement function (review round 2, chunk 6).
// The plain function changed the constructor's semantics on the observed process: it could be
// called without `new`, a subclass constructed an OriginalWorker instead of the subclass, and
// static properties were lost. An observer that alters the thing it observes invalidates the
// run. `Reflect.construct(target, args, newTarget)` preserves the subclass, and everything not
// trapped — statics, prototype, name, instanceof — passes straight through to the original.
if (typeof worker_threads.Worker === "function") {
  const OriginalWorker = worker_threads.Worker;
  worker_threads.Worker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      noteDescendant("worker_threads.Worker");
      return Reflect.construct(target, args, newTarget);
    },
  });
}

// LAST, after every property replacement above: this is what pushes the wrapped functions into
// the ESM named exports that `import { spawnSync } from "node:child_process"` already bound.
syncBuiltinESMExports();

register(new URL("./instrument-hooks.mjs", import.meta.url), { data: { logPath } });
