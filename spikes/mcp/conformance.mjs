#!/usr/bin/env node
// Scripted conformance suite (plan §5): eight cases, each with a named mutant that must kill
// it, run against a candidate server in its assembled isolated root (§2).
//
// Oracles are independent literals — the expected tool name, schema fields, error codes and
// witness lines are written here, never imported from the code under test. Every wait has a
// deadline that DISPOSES of the child rather than merely stopping. The per-candidate runner
// exits nonzero on any failed case; the matrix orchestrator consumes `runCandidate()`
// programmatically, records failures as evidence, and continues (§1: no short-circuiting).
//
// One empirical note pinned during §4 (2026-08-01): NEITHER installed SDK answers a malformed
// stdio line with a -32700 response — both drop it and keep serving. The broken-framing oracle
// therefore accepts -32700 or silence, and rejects any other response code or a dead server;
// its two mutants (`framing-wrong-code`, `framing-dies`) prove both rejections fire.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleCandidateRoot,
  buildServerEnv,
  checkResolutions,
  resolveFromRoot,
} from "./isolate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const REQ_TIMEOUT = 10_000;
const CANCEL_BLOCK_MS = 15_000; // far above the release deadline, so "ignored" is observable
const RELEASE_DEADLINE = 5_000;
const EXIT_DEADLINE = 5_000;
const FRAMING_GRACE = 800;

class CaseFailure extends Error {}
const check = (cond, msg) => {
  if (!cond) throw new CaseFailure(msg);
};

// Candidate-controlled output is bounded: a runaway server must fail its case, not exhaust
// the runner (review round 1). The raw byte COUNT keeps accumulating past the cap so the
// diagnostic can say how much was discarded.
const MAX_STREAM_BYTES = 5_000_000;

/** Newline-JSON scripted client around a spawned server process. */
class Harness {
  constructor(child) {
    this.child = child;
    this.stdoutRaw = "";
    this.stderrRaw = "";
    this.messages = [];
    this.byId = new Map();
    this.exited = null;
    this.closed = null; // exit AND both stdio streams drained — what waits should key on
    this.spawnError = null;
    this.overflow = null;
    this.listeners = new Set();
    let buf = "";
    child.on("error", (error) => {
      // A spawn failure (or late child error) is harness STATE, never an uncaught throw
      // that would abort the remaining cases of a no-short-circuit run.
      this.spawnError = error;
      this.#notify();
    });
    child.stdin.on("error", () => {
      // EPIPE from a server that died mid-write (framing-dies, args-crash): the death itself
      // is what the case observes; the broken pipe must not crash the suite.
    });
    child.stdout.on("data", (d) => {
      if (this.stdoutRaw.length < MAX_STREAM_BYTES) this.stdoutRaw += d;
      else this.overflow ??= "stdout";
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = { __unparseable: line };
        }
        this.messages.push(msg);
        if (msg && msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
          this.byId.set(msg.id, msg);
        }
        this.#notify();
      }
      if (this.overflow) this.#notify();
    });
    child.stderr.on("data", (d) => {
      if (this.stderrRaw.length < MAX_STREAM_BYTES) this.stderrRaw += d;
      else this.overflow ??= "stderr";
      this.#notify();
    });
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      this.#notify();
    });
    child.on("close", (code, signal) => {
      this.closed = { code, signal };
      this.#notify();
    });
  }

  #notify() {
    for (const fn of [...this.listeners]) fn();
  }

  /** Await `predicate()`; spawn errors and stream overflow fail the case immediately; on
   *  deadline, dispose of the child and fail the case. */
  async waitFor(predicate, timeoutMs, what) {
    const trouble = () => {
      if (this.spawnError) return `server process error: ${this.spawnError.message}`;
      if (this.overflow) return `server ${this.overflow} exceeded ${MAX_STREAM_BYTES} bytes`;
      return null;
    };
    const early = trouble();
    if (early && !predicate()) {
      await this.dispose();
      throw new CaseFailure(early);
    }
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onEvent);
        this.dispose().then(() => reject(new CaseFailure(`timed out after ${timeoutMs}ms waiting for ${what}`)));
      }, timeoutMs);
      const onEvent = () => {
        if (predicate()) {
          clearTimeout(timer);
          this.listeners.delete(onEvent);
          resolve();
          return;
        }
        const bad = trouble();
        if (bad) {
          clearTimeout(timer);
          this.listeners.delete(onEvent);
          this.dispose().then(() => reject(new CaseFailure(bad)));
        }
      };
      this.listeners.add(onEvent);
    });
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  writeRaw(text) {
    this.child.stdin.write(text);
  }

  async request(id, method, params, timeoutMs = REQ_TIMEOUT) {
    this.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    await this.waitFor(
      () => this.byId.has(id) || this.exited !== null,
      timeoutMs,
      `a response to ${method} (id ${id})`,
    );
    if (!this.byId.has(id)) {
      throw new CaseFailure(
        `server exited (code ${this.exited.code}, signal ${this.exited.signal}) before answering ${method}`,
      );
    }
    return this.byId.get(id);
  }

  async waitStderr(substring, timeoutMs, what) {
    await this.waitFor(() => this.stderrRaw.includes(substring), timeoutMs, what);
  }

  /** Await exit AND drained stdio ('close'), so stream inspection sees every byte. Returns
   *  null on deadline — callers that treat a non-close as a verdict must check for it. */
  async waitClose(timeoutMs) {
    try {
      await this.waitFor(() => this.closed !== null, timeoutMs, "process close (exit + drained stdio)");
    } catch (error) {
      if (error instanceof CaseFailure) return null;
      throw error;
    }
    return this.closed;
  }

  settle(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Asynchronous and idempotent: kill if alive, then await 'close' (bounded) so the next
   *  case never starts while this child still holds the root or its streams. */
  async dispose() {
    if (this.disposing) return this.disposing;
    this.disposing = (async () => {
      this.child.stdin.destroy();
      if (this.exited === null) this.child.kill("SIGKILL");
      if (this.closed === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3_000); // best effort; an unkillable child cannot block the run forever
          this.child.on("close", () => {
            clearTimeout(timer);
            resolve();
          });
          if (this.closed !== null) {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    })();
    return this.disposing;
  }
}

let nextId = 100;
async function initialize(h) {
  const init = await h.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "spendbar-conformance", version: "0.0.0" },
  });
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return init;
}

async function callProbe(h, args, id = nextId++) {
  return h.request(id, "tools/call", { name: "spendbar_probe", arguments: args });
}

/** Oracle for a rejected tools/call: an in-band tool error or a JSON-RPC invalid-params. */
function checkRejected(response, what) {
  if (response.error !== undefined) {
    check(response.error.code === -32602, `${what}: rejected with code ${response.error.code}, expected -32602`);
    return;
  }
  check(response.result?.isError === true, `${what}: accepted instead of rejected`);
  check(response.result?.structuredContent === undefined, `${what}: rejection still carries structuredContent`);
}

export const CASES = [
  {
    name: "initialize",
    mutants: ["blank-version"],
    async run(h) {
      const init = await initialize(h);
      const version = init.result?.protocolVersion;
      check(typeof version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(version),
        `negotiated protocolVersion ${JSON.stringify(version)} is not a date-shaped string`);
      check(typeof init.result?.serverInfo?.name === "string" && init.result.serverInfo.name.length > 0,
        "serverInfo.name missing or empty");
    },
  },
  {
    name: "tools-list",
    mutants: ["tool-absent", "schema-drop"],
    async run(h) {
      await initialize(h);
      const list = await h.request(2, "tools/list");
      const tool = (list.result?.tools ?? []).find((t) => t.name === "spendbar_probe");
      check(tool !== undefined, "tool spendbar_probe absent from tools/list");
      const schema = tool.inputSchema ?? {};
      check(schema.properties?.nonce?.type === "string", "inputSchema lost the nonce field");
      check(schema.properties?.blockMs !== undefined, "inputSchema lost the blockMs field");
      check(Array.isArray(schema.required) && schema.required.includes("nonce"), "nonce not required");
      check(schema.additionalProperties === false, "inputSchema is not strict (additionalProperties)");
      check(tool.outputSchema?.properties?.nonce !== undefined, "outputSchema missing or lost nonce");
    },
  },
  {
    name: "tools-call",
    mutants: ["no-structured", "empty-text"],
    async run(h) {
      await initialize(h);
      const r = await callProbe(h, { nonce: "case-nonce-3" });
      check(r.result?.isError !== true, `probe call errored: ${JSON.stringify(r.result?.content)}`);
      check(r.result?.structuredContent?.nonce === "case-nonce-3", "structuredContent missing or nonce not echoed");
      const text = r.result?.content?.find((c) => c.type === "text")?.text;
      check(typeof text === "string" && text.length > 0, "text fallback missing or empty");
      check(text.includes("case-nonce-3"), "text fallback does not carry the nonce");
    },
  },
  {
    name: "broken-framing",
    mutants: ["framing-wrong-code", "framing-dies"],
    async run(h) {
      await initialize(h);
      h.writeRaw("{this line is not JSON\n");
      await h.settle(FRAMING_GRACE);
      check(h.exited === null, "server died on a malformed line");
      for (const msg of h.messages) {
        if (msg.error !== undefined && (msg.id === null || msg.id === undefined)) {
          check(msg.error.code === -32700,
            `malformed line answered with code ${msg.error.code}; only -32700 or silence is conformant`);
        }
      }
      const list = await h.request(3, "tools/list");
      check(list.result?.tools !== undefined, "server stopped serving after a malformed line");
    },
  },
  {
    name: "schema-violation",
    mutants: ["args-accept", "args-crash"],
    async run(h) {
      await initialize(h);
      checkRejected(await callProbe(h, { nonce: 42 }), "wrong-typed nonce");
      checkRejected(await callProbe(h, { nonce: "x", extra: true }), "extra property");
      checkRejected(await callProbe(h, { nonce: "x", blockMs: 0.5 }), "fractional blockMs");
      checkRejected(await callProbe(h, { nonce: "x", blockMs: -1 }), "negative blockMs");
      checkRejected(await callProbe(h, { nonce: "x", blockMs: 60001 }), "over-limit blockMs");
      const ok = await callProbe(h, { nonce: "still-alive" });
      check(ok.result?.structuredContent?.nonce === "still-alive", "server unhealthy after rejections");
    },
  },
  {
    name: "cancellation",
    mutants: ["cancel-ignored", "cancel-wedged"],
    async run(h) {
      await initialize(h);
      h.send({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "spendbar_probe", arguments: { nonce: "case-cancel", blockMs: CANCEL_BLOCK_MS } },
      });
      await h.waitStderr("probe-handler-started case-cancel", REQ_TIMEOUT, "the handler-started witness");
      h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9, reason: "conformance" } });
      await h.waitStderr(
        "probe-handler-released case-cancel aborted=true",
        RELEASE_DEADLINE,
        "the aborted release witness (cancellation ignored?)",
      );
      const after = await callProbe(h, { nonce: "post-cancel" }, 10);
      check(after.result?.structuredContent?.nonce === "post-cancel", "server wedged after cancellation");
    },
  },
  {
    name: "client-eof",
    mutants: ["eof-alive"],
    async run(h) {
      await initialize(h);
      h.child.stdin.end();
      const closed = await h.waitClose(EXIT_DEADLINE);
      check(closed !== null, `server still alive ${EXIT_DEADLINE}ms after client EOF`);
      check(closed.code === 0, `server exited ${closed.code}/${closed.signal} on EOF, expected 0`);
    },
  },
  {
    name: "stdout-purity",
    mutants: ["stdout-noise", "stderr-silent"],
    async run(h) {
      await initialize(h);
      await h.request(2, "tools/list");
      await callProbe(h, { nonce: "purity" });
      h.child.stdin.end();
      // The clean close is REQUIRED before inspection: a null here (still alive, undrained
      // streams) must fail the case, not let it judge a partial capture (review round 1).
      const closed = await h.waitClose(EXIT_DEADLINE);
      check(closed !== null, `server did not close within ${EXIT_DEADLINE}ms; stream inspection would be partial`);
      check(closed.code === 0, `server exited ${closed.code}/${closed.signal}, expected 0`);
      for (const line of h.stdoutRaw.split("\n").filter((l) => l.trim() !== "")) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          throw new CaseFailure(`non-JSON bytes on stdout`);
        }
        check(msg.jsonrpc === "2.0", "a stdout line is JSON but not JSON-RPC 2.0");
      }
      check(h.stderrRaw.length > 0, "no log output on stderr — logs are missing or going to stdout");
    },
  },
];

/** Run one case against a fresh child; expected failures come back as data, never throws —
 *  including a spawn that fails synchronously, which must be a recorded case failure rather
 *  than an abort of the remaining cases. Disposal is awaited so the child is fully closed
 *  before the caller reuses (or removes) anything the child referenced. */
export async function runCase(def, spawnFn) {
  let h = null;
  try {
    h = new Harness(spawnFn(def.name));
    await def.run(h);
    return { status: "pass" };
  } catch (error) {
    return { status: "fail", detail: String(error.message ?? error) };
  } finally {
    if (h) await h.dispose();
  }
}

/** Spawn a named mutant server (test harness for the suite itself). */
export function spawnMutant(mutant) {
  return spawn(process.execPath, [join(HERE, "mutant-server.mjs")], {
    env: { SPENDBAR_MUTANT: mutant },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * The per-candidate runner: assemble the isolated root once, run all eight cases against
 * fresh server processes, then attach the §2 isolation evidence (complete resolution
 * enumeration + the opposite-SDK probe). Isolation failure fails the candidate — a case
 * result from a root that resolved outside itself proves nothing.
 */
export async function runCandidate(candidate) {
  const { root, resolveLog, cleanup } = assembleCandidateRoot(candidate);
  try {
    // One resolution log PER CASE PROCESS, validated immediately after that child closes.
    // A shared log cannot prove every server was instrumented: records from an earlier
    // process would keep it nonempty while a later uninstrumented child contributed nothing
    // (review round 1). runCase awaits disposal, so each log is complete when checked.
    const logFor = (name) => `${resolveLog}.${name}`;
    const spawnFn = (caseName) =>
      spawn(process.execPath, ["--import", "./instrument.mjs", "server.mjs"], {
        cwd: root,
        env: buildServerEnv({ resolveLog: logFor(caseName) }),
        stdio: ["pipe", "pipe", "pipe"],
      });
    const cases = {};
    const perCase = {};
    const resolutions = { total: 0, builtins: 0, inside: 0, violations: [] };
    let everyCaseInstrumented = true;
    for (const def of CASES) {
      cases[def.name] = await runCase(def, spawnFn); // every case runs; failures accumulate
      try {
        const r = checkResolutions(logFor(def.name), root);
        perCase[def.name] = { total: r.total, violations: r.violations.length };
        resolutions.total += r.total;
        resolutions.builtins += r.builtins;
        resolutions.inside += r.inside;
        resolutions.violations.push(...r.violations);
      } catch (error) {
        // Includes the empty-log case: this child ran WITHOUT working instrumentation, so
        // its result proves nothing about isolation — recorded, and it breaks the aggregate.
        perCase[def.name] = { error: String(error.message ?? error) };
        everyCaseInstrumented = false;
      }
    }
    const sdk = candidate === "v1" ? "@modelcontextprotocol/sdk" : "@modelcontextprotocol/server";
    const opposite = candidate === "v1" ? "@modelcontextprotocol/server" : "@modelcontextprotocol/sdk";
    let oppositeSdkProbe;
    try {
      resolveFromRoot(root, opposite);
      oppositeSdkProbe = "resolved";
    } catch (error) {
      oppositeSdkProbe = error.code === "MODULE_NOT_FOUND" ? "not-found" : `error:${error.code}`;
    }
    const sdkVersion = JSON.parse(
      readFileSync(join(root, "node_modules", ...sdk.split("/"), "package.json"), "utf8"),
    ).version;

    const isolationOk =
      everyCaseInstrumented && resolutions.violations.length === 0 && oppositeSdkProbe === "not-found";
    const failedCases = Object.values(cases).filter((c) => c.status === "fail").length;
    return {
      candidate,
      sdk,
      sdkVersion,
      cases,
      isolation: {
        resolutionsTotal: resolutions.total,
        builtins: resolutions.builtins,
        insidePrefix: resolutions.inside,
        violations: resolutions.violations,
        perCase,
        everyCaseInstrumented,
        oppositeSdkProbe,
        ok: isolationOk,
      },
      failed: failedCases + (isolationOk ? 0 : 1),
    };
  } finally {
    cleanup();
  }
}

async function main() {
  const candidates = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["v1", "v2"];
  const results = {};
  for (const candidate of candidates) {
    const r = await runCandidate(candidate);
    results[candidate] = r;
    const failedNames = Object.entries(r.cases)
      .filter(([, c]) => c.status === "fail")
      .map(([name]) => name);
    process.stderr.write(
      `${candidate} (${r.sdk}@${r.sdkVersion}): ` +
        `${Object.keys(r.cases).length - failedNames.length}/${Object.keys(r.cases).length} cases, ` +
        `isolation ${r.isolation.ok ? "ok" : "BROKEN"}` +
        (failedNames.length ? ` — FAILED: ${failedNames.join(", ")}` : "") +
        "\n",
    );
  }
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  process.exit(Object.values(results).some((r) => r.failed > 0) ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
