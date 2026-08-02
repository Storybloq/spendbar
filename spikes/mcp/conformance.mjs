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
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleCandidateRoot,
  buildServerEnv,
  checkResolutions,
  resolveFromRoot,
} from "./isolate.mjs";
import { isDirectEntry } from "../../scripts/direct-entry.mjs";

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
export const MAX_STREAM_BYTES = 5_000_000;

/** Newline-JSON scripted client around a spawned server process. Exported so OTHER
 *  scripted exchanges (the matrix's token measurement) reuse its stream caps, error
 *  handling and awaited disposal instead of re-growing the defects it fixed. */
export class Harness {
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
    // The unframed remainder, as an OBSERVABLE field. It was a closure variable, so the test
    // asserting "the parse buffer is bounded" could only watch `overflow` flip — and an
    // implementation that set the flag while still appending every byte, which is exactly the
    // memory-exhaustion defect the bound exists to stop, satisfied it (review round 2, chunk 14).
    this.parseBuffer = "";
    // DECODE ACROSS CHUNK BOUNDARIES. A piped stdio stream emits Buffers, and `str += buf`
    // decodes each chunk on its own — so a multi-byte character split across two reads became
    // two replacement characters in both the retained stream and the framing buffer, corrupting
    // a line the harness then tried to parse. setEncoding runs the chunks through a
    // StringDecoder, which holds partial sequences back until they are complete.
    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");
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
      this.parseBuffer += d;
      // The advertised bound did not bound THIS: a server emitting megabytes with no newline
      // left `stdoutRaw` capped while the parse buffer grew without limit, so the cap that
      // exists to stop a runaway candidate exhausting the runner did not (round 2, chunk 9).
      if (this.parseBuffer.length > MAX_STREAM_BYTES) {
        this.overflow ??= "stdout";
        this.parseBuffer = "";
      }
      let idx;
      while ((idx = this.parseBuffer.indexOf("\n")) >= 0) {
        const line = this.parseBuffer.slice(0, idx);
        this.parseBuffer = this.parseBuffer.slice(idx + 1);
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
    // Trouble is checked BEFORE the predicate, always. It used to be the other way round, so an
    // event that both satisfied the predicate and recorded a stream overflow returned success:
    // a request answered, or a stdout-purity case judged, on a stream the harness KNEW it had
    // stopped capturing (review round 2, chunk 9). An observation that failed is not a pass,
    // however good the thing it happened to observe alongside it looks.
    const early = trouble();
    if (early) {
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
        const bad = trouble();
        if (bad) {
          clearTimeout(timer);
          this.listeners.delete(onEvent);
          this.dispose().then(() => reject(new CaseFailure(bad)));
          return;
        }
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
          // Bounded, because an unkillable child must not block the run forever — but the
          // timeout is RECORDED rather than swallowed (review round 2, chunk 9). Returning
          // quietly meant the caller went on to read a resolution log a live process was still
          // writing, and then deleted the isolated root out from under it.
          const timer = setTimeout(() => {
            this.disposeTimedOut = true;
            resolve();
          }, 3_000);
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
export async function initialize(h) {
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
    mutants: ["framing-wrong-code", "framing-garbage", "framing-late", "framing-dies"],
    async run(h) {
      await initialize(h);
      const from = h.messages.length;
      h.writeRaw("{this line is not JSON\n");
      await h.settle(FRAMING_GRACE);
      check(h.exited === null, "server died on a malformed line");
      // The tools/list round-trip is the BARRIER: its answer proves the server processed past
      // the malformed line, so anything it was going to emit about that line has been emitted
      // or is at least in flight. A second settle catches the in-flight case. The judgement
      // used to happen before this request, so a late answer landed in `messages` after the
      // loop had already declared silence (review round 2, chunk 9).
      const list = await h.request(3, "tools/list");
      check(list.result?.tools !== undefined, "server stopped serving after a malformed line");
      await h.settle(FRAMING_GRACE);
      // EVERYTHING emitted since, not just the parsed null-id errors. Unframeable bytes were
      // being read as silence — a server could answer the malformed line with garbage and pass.
      for (const msg of h.messages.slice(from)) {
        if (msg.id === 3 && msg.result !== undefined) continue; // the barrier's own answer
        check(msg.__unparseable === undefined,
          `malformed line answered with unframeable bytes: ${JSON.stringify(msg.__unparseable)}`);
        check(msg.error !== undefined && (msg.id === null || msg.id === undefined),
          `malformed line answered with ${JSON.stringify(msg)}; only a null-id error or silence is conformant`);
        check(msg.error.code === -32700,
          `malformed line answered with code ${msg.error.code}; only -32700 or silence is conformant`);
      }
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
    mutants: ["stdout-noise", "stdout-blank-lines", "stdout-unterminated", "stderr-silent"],
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
      // The same framing rules the capture normalizer applies, and for the same reasons. This
      // oracle used to DISCARD blank lines and admit an unterminated tail, so a server emitting
      // stray newlines, or cut off mid-message at EOF, earned a clean purity result — while the
      // normalizer next door counted both as protocol errors (review round 2, chunk 9).
      const parts = h.stdoutRaw.split("\n");
      const tail = parts.pop();
      check(tail === "", `stdout ends with an unterminated frame: ${JSON.stringify(tail.slice(0, 80))}`);
      for (const line of parts) {
        check(line.trim() !== "", "an empty line on the protocol stream — newline framing never produces one");
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
  let outcome;
  try {
    h = new Harness(spawnFn(def.name));
    await def.run(h);
    outcome = { status: "pass" };
  } catch (error) {
    outcome = { status: "fail", detail: String(error.message ?? error) };
  } finally {
    if (h) await h.dispose();
  }
  // A child that would not die is not a passing case: whatever it is still doing, it is doing
  // it to the same isolated root the next case runs in and the same log this one is about to
  // be judged on.
  if (h?.disposeTimedOut) {
    return { status: "fail", detail: `server did not close after SIGKILL; ${outcome.status === "fail" ? outcome.detail : "case assertions passed but the run is not trustworthy"}` };
  }
  return outcome;
}

/** Spawn a named mutant server (test harness for the suite itself). */
export function spawnMutant(mutant) {
  return spawn(process.execPath, [join(HERE, "mutant-server.mjs")], {
    env: { SPENDBAR_MUTANT: mutant },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Execution contexts a case's server created — a child process or a Worker, recorded by
 * instrument.mjs into a sidecar beside the resolution log.
 *
 * It is a separate file on purpose: a descendant is not a resolution, and every line of the
 * resolution log is one. Reading it here rather than inside checkResolutions also keeps the
 * clause in the layer that owns the run, which matters because isolate.mjs is pinned as a
 * capture input and this check has nothing to do with what a real-client capture observed.
 */
export function descendantsFor(logPath) {
  const sidecar = `${logPath}.descendants`;
  // An absent sidecar used to mean "no descendants". It also meant "the instrument never ran"
  // and "the sidecar could not be written", and the reader resolved that ambiguity in favour of
  // clean (review round 2, chunk 6). The instrument now creates it EMPTY before anything can
  // spawn, so absence is a broken observation and is refused; empty is the honest "none".
  if (!existsSync(sidecar)) {
    throw new Error(
      `descendant sidecar is absent for ${logPath} — the instrument did not run, so "no descendants" is unobserved, not observed`,
    );
  }
  return readFileSync(sidecar, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * How many of a case's in-root resolutions came from the candidate SDK package itself.
 *
 * Exported so the requirement is testable without a real candidate root. Built from the log's
 * OWN realpath'd root so a symlinked assembled root compares like with like rather than always
 * matching nothing — which would turn this check into one that fails everything, the mirror of
 * the one that passed everything.
 */
export function sdkWitness(resolutions, sdk) {
  const prefix = join(resolutions.rootReal, "node_modules", ...sdk.split("/")) + sep;
  return resolutions.insidePaths.filter((p) => p.startsWith(prefix)).length;
}

/**
 * One case's isolation record. A pure function of that case's resolution audit, so the
 * requirement below is falsifiable without assembling a candidate root.
 *
 * The candidate SDK must appear in this case's OWN resolutions. Requiring only "some resolution
 * inside the root" was satisfied by the instrument, the server entry and the local probe files,
 * so a server.mjs that had stopped importing the SDK altogether could pass all eight behavioural
 * cases and still report isolation.ok — evidence about neither v1 nor v2 (round 2, chunk 9).
 */
export function judgeCaseIsolation(resolutions, sdk, descendantCount) {
  const sdkResolutions = sdkWitness(resolutions, sdk);
  const record = {
    total: resolutions.total,
    violations: resolutions.violations.length,
    descendants: descendantCount,
    sdkResolutions,
  };
  if (sdkResolutions === 0) {
    record.error = `no module was resolved from ${sdk} — this case did not exercise the candidate SDK`;
  }
  return record;
}

/** The candidate-level isolation verdict, pure so every way it can be false is testable. */
export function aggregateIsolation({ perCase, violations, descendants, oppositeSdkProbe, expectedCases }) {
  // The case set is checked BEFORE the records are judged. `[].every(...)` is true, so an empty
  // `perCase` — or one holding a single case out of eight — reported everyCaseInstrumented and
  // a clean isolation verdict, which is the whole family of defect this function was added in
  // chunk 9 to close, surviving one level up (review round 2, chunk 14). "Every case" has to
  // mean every case, so the names are compared, not counted.
  const want = [...(expectedCases ?? CASES.map((c) => c.name))].sort();
  const got = Object.keys(perCase).sort();
  const caseSetComplete = want.length === got.length && want.every((name, i) => name === got[i]);
  const everyCaseInstrumented = caseSetComplete && Object.values(perCase).every((r) => r.error === undefined);
  return {
    caseSetComplete,
    everyCaseInstrumented,
    ok: everyCaseInstrumented && violations.length === 0 && descendants.length === 0 && oppositeSdkProbe === "not-found",
  };
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
    const sdk = candidate === "v1" ? "@modelcontextprotocol/sdk" : "@modelcontextprotocol/server";
    const cases = {};
    const perCase = {};
    const resolutions = { total: 0, builtins: 0, inside: 0, violations: [] };
    const descendants = [];
    for (const def of CASES) {
      cases[def.name] = await runCase(def, spawnFn); // every case runs; failures accumulate
      // A child process or Worker resolves its modules where the instrument was never loaded,
      // so its closure is UNKNOWN rather than clean; counting it as a violation is the only
      // reading that does not overstate what was enumerated (review round 1, chunk 16).
      try {
        // INSIDE the guard (review round 2, chunk 9). A missing or malformed sidecar threw
        // straight out of runCandidate, aborting this candidate and the rest of the matrix —
        // the opposite of the recorded isolation failure the catch below promises.
        const spawned = descendantsFor(logFor(def.name)).map((d) => ({ ...d, case: def.name }));
        descendants.push(...spawned);
        const r = checkResolutions(logFor(def.name), root);
        // The candidate SDK must appear in this case's OWN resolutions. Requiring only "some
        // resolution inside the root" was satisfied by the instrument, the server entry and the
        // local probe files, so a server.mjs that had stopped importing the SDK altogether
        // could pass all eight cases and report isolation.ok — evidence about neither v1 nor
        // v2 (review round 2, chunk 9).
        // Built from the log's OWN realpath'd root, so a symlinked assembled root compares
        // like with like rather than always matching nothing.
        perCase[def.name] = judgeCaseIsolation(r, sdk, spawned.length);
        resolutions.total += r.total;
        resolutions.builtins += r.builtins;
        resolutions.inside += r.inside;
        resolutions.violations.push(...r.violations);
      } catch (error) {
        // Includes the empty-log case: this child ran WITHOUT working instrumentation, so
        // its result proves nothing about isolation — recorded, and it breaks the aggregate.
        perCase[def.name] = { error: String(error.message ?? error) };
      }
    }
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

    const { everyCaseInstrumented, ok: isolationOk } = aggregateIsolation({
      perCase,
      violations: resolutions.violations,
      descendants,
      oppositeSdkProbe,
    });
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
        descendants,
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

if (isDirectEntry(import.meta.url)) {
  await main();
}
