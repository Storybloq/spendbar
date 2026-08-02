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
// Recording is append-only writes to one file; the instrument resolves nothing itself and
// changes no resolution result.

import { register } from "node:module";
import Module from "node:module";
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

register(new URL("./instrument-hooks.mjs", import.meta.url), { data: { logPath } });
