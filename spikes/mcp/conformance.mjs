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

/** Newline-JSON scripted client around a spawned server process. */
class Harness {
  constructor(child) {
    this.child = child;
    this.stdoutRaw = "";
    this.stderrRaw = "";
    this.messages = [];
    this.byId = new Map();
    this.exited = null;
    this.listeners = new Set();
    let buf = "";
    child.stdout.on("data", (d) => {
      this.stdoutRaw += d;
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
    });
    child.stderr.on("data", (d) => {
      this.stderrRaw += d;
      this.#notify();
    });
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      this.#notify();
    });
  }

  #notify() {
    for (const fn of [...this.listeners]) fn();
  }

  /** Await `predicate()`; on deadline, dispose of the child and fail the case. */
  async waitFor(predicate, timeoutMs, what) {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onEvent);
        this.dispose();
        reject(new CaseFailure(`timed out after ${timeoutMs}ms waiting for ${what}`));
      }, timeoutMs);
      const onEvent = () => {
        if (predicate()) {
          clearTimeout(timer);
          this.listeners.delete(onEvent);
          resolve();
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

  async waitExit(timeoutMs) {
    try {
      await this.waitFor(() => this.exited !== null, timeoutMs, "process exit");
    } catch (error) {
      if (error instanceof CaseFailure) return null; // caller owns the verdict on a non-exit
      throw error;
    }
    return this.exited;
  }

  settle(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  dispose() {
    if (this.exited === null) this.child.kill("SIGKILL");
    this.child.stdin.destroy();
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
      const exited = await h.waitExit(EXIT_DEADLINE);
      check(exited !== null, `server still alive ${EXIT_DEADLINE}ms after client EOF`);
      check(exited.code === 0, `server exited ${exited.code}/${exited.signal} on EOF, expected 0`);
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
      await h.waitExit(EXIT_DEADLINE);
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

/** Run one case against a fresh child; expected failures come back as data, never throws. */
export async function runCase(def, spawnFn) {
  const h = new Harness(spawnFn());
  try {
    await def.run(h);
    return { status: "pass" };
  } catch (error) {
    return { status: "fail", detail: String(error.message ?? error) };
  } finally {
    h.dispose();
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
    const spawnFn = () =>
      spawn(process.execPath, ["--import", "./instrument.mjs", "server.mjs"], {
        cwd: root,
        env: buildServerEnv({ resolveLog }),
        stdio: ["pipe", "pipe", "pipe"],
      });
    const cases = {};
    for (const def of CASES) {
      cases[def.name] = await runCase(def, spawnFn); // every case runs; failures accumulate
    }

    const resolutions = checkResolutions(resolveLog, root);
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

    const isolationOk = resolutions.violations.length === 0 && oppositeSdkProbe === "not-found";
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
