// Test-support egress observer (review round 1): preloaded into a child via `--import`, it
// records every attempt to reach the network through Node's own APIs — TCP (which HTTP, TLS
// and fetch/undici all ride), UDP, DNS, and the global fetch entry point — as one JSON line
// per attempt in SPENDBAR_NET_LOG. It observes and never blocks: the exfiltration tests
// assert on the recorded attempts, and their positive control proves the recording works by
// moving a canary through this exact interception path.
//
// Scope, stated honestly: this sees Node-API egress only. A native addon could bypass it,
// which is precluded separately — the supply-chain gate refuses any closure that carries
// native-build machinery.

import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
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
wrapMethod(dns, "lookup", "dns.lookup");
wrapMethod(dns.promises, "lookup", "dns.promises.lookup");
if (typeof globalThis.fetch === "function") wrapMethod(globalThis, "fetch", "fetch");
