// ESM loader hooks for the resolution instrument (plan §2) — the loader-thread half of
// instrument.mjs. Runs in Node's hooks thread; appends one ndjson line per ESM resolution.

import { appendFileSync } from "node:fs";

let logPath;

export function initialize(data) {
  logPath = data?.logPath;
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (logPath) {
    appendFileSync(
      logPath,
      JSON.stringify({ kind: "esm", request: specifier, resolved: result.url }) + "\n",
    );
  }
  return result;
}
