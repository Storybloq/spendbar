#!/usr/bin/env node
// capture:real-clients (plan §9) — the auth-required capture command. NEVER CI-runnable, and
// never claims to be: it drives the real Claude Code and Codex CLIs against both candidate
// servers (4 cells, at most one environmental retry each), records raw captures in the
// retained directory, classifies each run with the pure classifier, and writes the typed
// cells + sanitized manifests into spikes/mcp/evidence/real-clients/.
//
//   node spikes/mcp/real-client/capture.mjs [--cell <client>:<candidate>]...
//   node spikes/mcp/real-client/capture.mjs --purge     # explicit retained-capture purge
//
// Retained-capture directory: ~/.spendbar/t009-captures (mode 0700, files 0600) — separate
// from ephemeral scratch, exempt from scratch cleanup, holding exactly the four named streams
// per capture (client->server, server stdout, server stderr, client stdout+stderr) plus the
// raw manifest. Raw captures are deleted the moment their receipt is written
// (receipt.mjs); captures that never produced a receipt are swept after 7 days by the
// startup sweep here, by the next capture run, or by --purge.
//
// Cost, stated honestly: no per-run monetary cap is enforceable for these CLIs. This command
// runs a FIXED number of cells (4) with at most one environmental retry each, and records
// what happened. Spent quota is irreversible.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleCandidateRoot, assertOutsideRepo } from "../isolate.mjs";
import { classify, toCellStatus } from "./classify.mjs";
import { normalize } from "./normalize.mjs";
import { captureInputDigests } from "./provenance.mjs";
import { sanitize, checkPreservation, STREAM_STAT_KEYS } from "./sanitize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_REAL = join(HERE, "..", "evidence", "real-clients");
export const RETAINED_DIR = join(homedir(), ".spendbar", "t009-captures");
export const RETENTION_DAYS = 7;

// The fixed prompt, committed as a literal and hashed — {{NONCE}} is the one substitution,
// recorded separately before the run. The instructions exist to make the oracle checkable:
// the marker proves completion on the client's own stdout, and keeping the nonce out of the
// prose keeps the TRACE, not the model's text, as the evidence carrier.
export const PROMPT_TEMPLATE =
  'Call the MCP tool "spendbar_probe" exactly once, with the argument object {"nonce": "{{NONCE}}"}. ' +
  "Do not call any other tool. Do not repeat, quote, or mention the nonce value anywhere in your reply. " +
  'After the tool call succeeds, reply with exactly this single line and nothing else: SPENDBAR_PROBE_DONE';
export const PROMPT_TEMPLATE_SHA256 = createHash("sha256").update(PROMPT_TEMPLATE).digest("hex");
export const COMPLETION_MARKER = "SPENDBAR_PROBE_DONE";
const RUN_DEADLINE_MS = 240_000;
/** After SIGKILL, how long to wait for the pipes to close before recording that they did not. */
const DRAIN_DEADLINE_MS = 30_000;
/** Client output is held in memory to derive the disclosure predicates; bounded, and recorded when it bites. */
const MAX_CLIENT_STREAM_BYTES = 8 * 1024 * 1024;

/**
 * The environment the real client is spawned with, as a literal allowlist (review round 1,
 * chunk 10). It used to inherit the entire parent environment while the manifest recorded
 * `{ PATH }` — a false claim about the run, and a route for every unrelated credential in the
 * shell (npm, cloud, provider tokens) to reach a paid third-party client and any hook it runs.
 *
 * HOME is on the list and cannot come off it: it is the documented credential channel for BOTH
 * clients, and a real-client conformance test that cannot authenticate is not a test. What the
 * allowlist buys is that HOME is the ONLY credential channel, and that the manifest records
 * exactly what was passed instead of a smaller, prettier claim.
 */
export const CLIENT_ENV_ALLOWLIST = [
  "PATH", // resolving the client binary
  "HOME", // the documented credential channel: ~/.claude*, ~/.codex
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  // Without these a perfectly authenticated run fails as if the network were down, which is
  // the one misclassification this whole ticket exists to avoid.
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
];

/** The client's environment, built from the allowlist — never inherited. */
export function buildClientEnv(source = process.env) {
  const env = {};
  for (const name of CLIENT_ENV_ALLOWLIST) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  return env;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
/** A fresh zeroed stat block per direction — the key set is the sanitizer's, not a second copy. */
const emptyStreamStats = () => Object.fromEntries(STREAM_STAT_KEYS.map((key) => [key, 0]));

/**
 * Resolve the client binary and identify it by its bytes. "resolved-at-spawn-via-PATH" was a
 * placeholder standing in for capture identity: it recorded that a lookup would happen, not
 * what was found. Every branch here is a recorded reason, so an unidentifiable executable is
 * stated rather than implied.
 */
function resolveExecutable(binary, env) {
  const found = spawnSync("/usr/bin/env", ["sh", "-c", `command -v ${binary}`], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  const path = found.status === 0 ? found.stdout.trim().split("\n")[0] : "";
  if (!path) return { path: "", identity: "unresolved-on-PATH" };
  try {
    if (!statSync(path).isFile()) return { path, identity: "not-a-regular-file" };
    return { path, identity: `sha256:${sha256(readFileSync(path))}` };
  } catch {
    return { path, identity: "unreadable" };
  }
}

/** Buffer a child stream with a byte ceiling, so a runaway client cannot exhaust memory. */
function boundedCollector() {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (bytes + chunk.length > MAX_CLIENT_STREAM_BYTES) {
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    },
    // Concatenate THEN decode: decoding each chunk separately inserts replacement characters
    // whenever a multibyte sequence straddles a chunk boundary, so the ".raw" files stopped
    // being the bytes the client emitted (review round 1, chunk 10).
    finish() {
      const buf = Buffer.concat(chunks);
      return { buf, text: buf.toString("utf8"), truncated };
    },
  };
}

/** Exact, anchored authentication diagnostics — see the environmental claim rules in classify.mjs. */
const AUTH_DIAGNOSTICS = [
  /\bnot logged in\b/i,
  /\bplease run\b[^\n]{0,24}\blogin\b/i,
  /\b401 unauthorized\b/i,
  /\bauthentication (failed|required)\b/i,
];

// ---------- retained-capture lifecycle ------------------------------------------------------

function ensureRetainedDir() {
  mkdirSync(RETAINED_DIR, { recursive: true });
  chmodSync(RETAINED_DIR, 0o700);
}

/** Sweep abandoned captures (no receipt after RETENTION_DAYS). Receipted ones are already gone. */
export function sweepAbandoned(now = Date.now()) {
  if (!existsSync(RETAINED_DIR)) return [];
  const swept = [];
  for (const entry of readdirSync(RETAINED_DIR)) {
    const dir = join(RETAINED_DIR, entry);
    const age = now - statSync(dir).mtimeMs;
    if (age > RETENTION_DAYS * 24 * 3600 * 1000) {
      rmSync(dir, { recursive: true, force: true });
      swept.push(entry);
    }
  }
  return swept;
}

// ---------- preflights ----------------------------------------------------------------------

/** A required CLI flag is VALIDATED against --help, never assumed (plan §9 isolation). */
function validateFlags(binary, helpArgs, flags) {
  const help = spawnSync(binary, helpArgs, { encoding: "utf8", timeout: 30_000 });
  if (help.error || help.status !== 0) return { ok: false, missing: flags, detail: `${binary} ${helpArgs.join(" ")} failed` };
  const text = help.stdout + help.stderr;
  const missing = flags.filter((f) => !text.includes(f));
  return { ok: missing.length === 0, missing, detail: missing.length ? `flags not advertised: ${missing.join(", ")}` : "" };
}

function preflight(client) {
  const binary = client === "claude-code" ? "claude" : "codex";
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (version.error || version.status !== 0) {
    return { ok: false, environmental: { condition: "binary-missing", detail: `${binary} --version failed` } };
  }
  const flags =
    client === "claude-code"
      ? validateFlags(binary, ["--help"], ["--strict-mcp-config", "--mcp-config", "--settings", "-p"])
      : validateFlags(binary, ["exec", "--help"], ["--config", "--skip-git-repo-check"]);
  if (!flags.ok) {
    // Isolation cannot be established with this binary: a positively observed condition.
    return { ok: false, environmental: { condition: "binary-missing", detail: flags.detail } };
  }
  return { ok: true, clientVersion: version.stdout.trim().split("\n")[0] };
}

// ---------- per-cell capture ----------------------------------------------------------------

function buildClientInvocation(client, prompt, wrapperCmd, scratchCwd) {
  if (client === "claude-code") {
    // --strict-mcp-config: ONLY the servers in --mcp-config exist. Scratch cwd keeps project
    // settings/hooks out; --settings pins an explicit, empty settings source.
    const mcpConfig = { mcpServers: { "spendbar-probe": { command: wrapperCmd[0], args: wrapperCmd.slice(1) } } };
    const settingsPath = join(scratchCwd, "isolation-settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    return {
      binary: "claude",
      args: ["-p", prompt, "--strict-mcp-config", "--mcp-config", JSON.stringify(mcpConfig), "--settings", settingsPath],
    };
  }
  // Codex: MCP servers via -c config overrides. These are ADDITIVE — Codex still loads the
  // user's ~/.codex configuration, rules and any MCP servers declared there, so this cell does
  // NOT have the fresh-state isolation the Claude Code cell has. Relocating it with CODEX_HOME
  // would isolate the config and simultaneously remove the credentials, and copying those is
  // forbidden. The limitation is therefore recorded as a fact on every manifest
  // (`isolation.userConfigIsolated: false`) rather than described in a comment and forgotten;
  // closing it needs an owner decision about an isolated authentication path.
  const argsJson = JSON.stringify(wrapperCmd.slice(1));
  return {
    binary: "codex",
    args: [
      "exec",
      "--skip-git-repo-check",
      "-c", `mcp_servers.spendbar-probe.command=${JSON.stringify(wrapperCmd[0])}`,
      "-c", `mcp_servers.spendbar-probe.args=${argsJson}`,
      prompt,
    ],
  };
}

async function captureCell(client, candidate, clientVersion, attempt) {
  const captureId = `${client}-${candidate}-${randomBytes(4).toString("hex")}`;
  const rawDir = join(RETAINED_DIR, captureId);
  mkdirSync(rawDir, { recursive: true });
  chmodSync(rawDir, 0o700);

  const scratchCwd = mkdtempSync(join(tmpdir(), "t009-client-cwd-"));
  assertOutsideRepo(scratchCwd);
  const { root, cleanup } = assembleCandidateRoot(candidate);
  const nonce = `t009-${randomBytes(8).toString("hex")}`;
  const prompt = PROMPT_TEMPLATE.replace("{{NONCE}}", nonce);

  // Hostile project config (Claude Code): a server that would write a canary file if any
  // non-strict path executed it. Its absence after the run is the positive isolation proof.
  const hostileCanary = join(scratchCwd, "hostile-ran.canary");
  writeFileSync(
    join(scratchCwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "hostile-fixture": { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(hostileCanary)}, "ran")`] },
      },
    }),
  );

  const wrapperCmd = [process.execPath, join(HERE, "capture-wrapper.mjs"), root, rawDir];
  const { binary, args } = buildClientInvocation(client, prompt, wrapperCmd, scratchCwd);
  const clientEnv = buildClientEnv();
  const executable = resolveExecutable(binary, clientEnv);

  // The raw manifest skeleton is recorded BEFORE the run — the nonce, the prompt hashes, the
  // environment actually about to be passed, the executable's identity and the capture-input
  // digests are all INPUTS, recorded before anything can be influenced by the outcome.
  const raw = {
    captureId,
    client,
    candidate,
    clientVersion,
    promptSha256: PROMPT_TEMPLATE_SHA256,
    // The exact bytes handed to the client, not just the template they came from: a mutation
    // in prompt construction left the template hash untouched and still classified (review
    // round 1, chunk 10). The verifier recomputes this from the committed template + nonce.
    promptInstanceSha256: sha256(Buffer.from(prompt, "utf8")),
    nonce,
    executablePath: executable.path || binary,
    executableIdentity: executable.identity,
    commandLine: args,
    env: clientEnv,
    cwd: scratchCwd,
    captureInputs: captureInputDigests(),
    spawn: { client: { ok: false }, server: { ok: false } },
    environmental: null,
    // The hostile-config canary, recorded as a fact independently of any environmental claim:
    // the classifier admits a fresh-state-isolation claim only against this witness.
    // `userConfigIsolated` is the honest counterpart — see buildClientInvocation.
    isolation: { hostileConfigExecuted: false, userConfigIsolated: client === "claude-code" },
    timedOut: false,
    lastPhase: "pre-spawn",
    clientExit: { code: null, signal: null },
    serverTermination: { signal: null },
    wrapper: { spawned: false, closed: false, forwardErrors: 0 },
    frames: [],
    clientToServer: emptyStreamStats(),
    serverStdout: emptyStreamStats(),
    serverStderr: { hasReadyLine: false, containsFrames: false },
    clientStdout: {
      hasCompletionMarker: false,
      containsNonce: false,
      containsAllowlistedEnvValue: false,
      truncated: false,
    },
    digests: {},
    retries: attempt > 0 ? [`attempt ${attempt + 1} after infrastructure-unavailable`] : [],
  };
  writeFileSync(join(rawDir, "raw-manifest.json"), JSON.stringify(raw, null, 2));
  chmodSync(join(rawDir, "raw-manifest.json"), 0o600);

  const outCollector = boundedCollector();
  const errCollector = boundedCollector();
  let clientOut;
  let clientErr;
  try {
    const child = spawn(binary, args, { cwd: scratchCwd, env: clientEnv, stdio: ["ignore", "pipe", "pipe"] });
    raw.spawn.client.ok = true;
    child.stdout.on("data", (d) => outCollector.push(d));
    child.stderr.on("data", (d) => errCollector.push(d));
    const exit = await new Promise((resolve) => {
      // `close`, not `exit`: `exit` fires while stdout/stderr may still be draining, so the
      // post-run derivation could read a capture that was still being written, and the
      // assembled candidate root could be deleted out from under a live process.
      const deadline = setTimeout(() => {
        raw.timedOut = true;
        child.kill("SIGKILL"); // disposed, not merely stopped
        // A grandchild holding the pipes open can delay `close` indefinitely. Waiting forever
        // is not an option and neither is pretending it closed, so the wait is bounded and
        // the outcome is recorded either way.
        setTimeout(() => resolve({ code: null, signal: "SIGKILL" }), DRAIN_DEADLINE_MS).unref();
      }, RUN_DEADLINE_MS);
      child.on("close", (code, signal) => {
        clearTimeout(deadline);
        resolve({ code, signal });
      });
      child.on("error", (error) => {
        clearTimeout(deadline);
        raw.spawn.client = { ok: false, error: String(error) };
        resolve({ code: null, signal: null });
      });
    });
    raw.clientExit = exit;
  } finally {
    const out = outCollector.finish();
    const err = errCollector.finish();
    clientOut = out;
    clientErr = err;
    cleanup();
  }

  // Post-run: derive everything from the retained bytes.
  const readRaw = (name) => (existsSync(join(rawDir, name)) ? readFileSync(join(rawDir, name)) : Buffer.alloc(0));
  const c2s = readRaw("client-to-server.raw");
  const s2c = readRaw("server-stdout.raw");
  const serverErr = readRaw("server-stderr.raw");
  writeFileSync(join(rawDir, "client-stdout.raw"), clientOut.buf);
  writeFileSync(join(rawDir, "client-stderr.raw"), clientErr.buf);
  for (const f of readdirSync(rawDir)) chmodSync(join(rawDir, f), 0o600);

  // The wrapper's own witness. Server spawn used to be inferred from "some bytes came back or
  // an exit file exists", which reports a server that started and then hung as one that never
  // started — laundering a post-spawn conformance timeout into infrastructure-unavailable.
  const wrapperStatus = existsSync(join(rawDir, "wrapper-status.json"))
    ? JSON.parse(readFileSync(join(rawDir, "wrapper-status.json"), "utf8"))
    : null;
  raw.wrapper = {
    spawned: wrapperStatus?.spawned === true,
    closed: wrapperStatus?.closed === true,
    // No status file at all means the wrapper never got far enough to write one: that is a
    // delivery failure, counted as such rather than read as zero.
    forwardErrors: Number.isSafeInteger(wrapperStatus?.forwardErrors) ? wrapperStatus.forwardErrors : 1,
  };
  raw.spawn.server.ok = raw.wrapper.spawned;
  if (existsSync(join(rawDir, "server-exit.json"))) {
    raw.serverTermination = { signal: JSON.parse(readFileSync(join(rawDir, "server-exit.json"), "utf8")).signal };
  }
  const derived = normalize(c2s, s2c);
  raw.frames = derived.frames;
  raw.clientToServer = derived.clientToServer;
  raw.serverStdout = derived.serverStdout;
  const errText = serverErr.toString("utf8");
  raw.serverStderr = {
    hasReadyLine: errText.includes("spendbar-probe-server ready"),
    containsFrames: /"jsonrpc"\s*:\s*"2\.0"/.test(errText),
  };
  raw.clientStdout = {
    hasCompletionMarker: clientOut.text.includes(COMPLETION_MARKER),
    containsNonce: clientOut.text.includes(nonce),
    // Derived, not asserted. This was hardcoded `false`, which made the pass-oracle clause
    // that reads it incapable of ever failing — an environment disclosure would have been
    // recorded as clean. Short values are skipped because a two-character value matches
    // everything; every allowlisted value long enough to be identifying is checked.
    containsAllowlistedEnvValue: Object.values(clientEnv).some(
      (value) => value.length >= 8 && clientOut.text.includes(value),
    ),
    truncated: clientOut.truncated || clientErr.truncated,
  };
  raw.lastPhase = raw.frames.some((f) => f.method === "tools/call")
    ? "called"
    : raw.frames.some((f) => f.method === "tools/list")
      ? "listed"
      : raw.frames.some((f) => f.method === "initialize")
        ? "initialized"
        : raw.spawn.server.ok
          ? "spawned"
          : "pre-spawn";
  // All four retained streams are digest-bound, so the receipt can reproduce every derived
  // fact. Client stdout/stderr carried the completion-marker and disclosure predicates while
  // being bound to nothing at all, so those predicates were unverifiable after deletion.
  raw.digests = {
    clientToServerSha256: sha256(c2s),
    serverStdoutSha256: sha256(s2c),
    serverStderrSha256: sha256(serverErr),
    clientStdoutSha256: sha256(clientOut.buf),
    clientStderrSha256: sha256(clientErr.buf),
    derivationDigest: derived.derivationDigest,
  };

  // Positively observed environmental conditions, from the record. The canary is recorded as
  // a witness FIRST and separately: the classifier will not honor the claim without it.
  raw.isolation = {
    hostileConfigExecuted: existsSync(hostileCanary),
    userConfigIsolated: client === "claude-code",
  };
  if (raw.isolation.hostileConfigExecuted) {
    raw.environmental = { condition: "fresh-state-isolation-failure", detail: "hostile project config executed" };
  } else if (!raw.spawn.client.ok || !raw.spawn.server.ok) {
    // spawn-failure handled by the classifier from raw.spawn
  } else if (
    // Narrowed in review round 1, chunk 10. Matching "authentication" or "401" anywhere in
    // stderr after any nonzero exit let a protocol failure whose diagnostic happened to
    // mention auth override observed protocol progress and become a not-run. An auth failure
    // stops a run BEFORE it starts, so the absence of protocol progress is part of the claim.
    raw.frames.length === 0 &&
    raw.clientExit.code !== 0 &&
    AUTH_DIAGNOSTICS.some((re) => re.test(clientErr.text))
  ) {
    raw.environmental = { condition: "auth-failure", detail: "client reported an authentication error" };
  }

  writeFileSync(join(rawDir, "raw-manifest.json"), JSON.stringify(raw, null, 2));
  chmodSync(join(rawDir, "raw-manifest.json"), 0o600);
  rmSync(scratchCwd, { recursive: true, force: true });

  const expected = { promptSha256: PROMPT_TEMPLATE_SHA256, nonce, completionMarker: COMPLETION_MARKER };
  const classified = classify(raw, expected);
  return { raw, rawDir, classified };
}

// ---------- main ----------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--purge")) {
    ensureRetainedDir();
    const swept = sweepAbandoned(Infinity);
    process.stderr.write(`purged ${swept.length} retained capture(s)\n`);
    return;
  }
  ensureRetainedDir();
  const swept = sweepAbandoned();
  if (swept.length) process.stderr.write(`startup sweep removed ${swept.length} abandoned capture(s)\n`);

  const requested = argv.filter((a) => a.startsWith("--cell=")).map((a) => a.slice(7));
  const allCells = ["claude-code:v1", "claude-code:v2", "codex:v1", "codex:v2"];
  const cells = requested.length ? requested : allCells;

  mkdirSync(EVIDENCE_REAL, { recursive: true });
  const cellsPath = join(EVIDENCE_REAL, "cells.json");
  const recorded = existsSync(cellsPath) ? JSON.parse(readFileSync(cellsPath, "utf8")) : {};

  for (const cell of cells) {
    const [client, candidate] = cell.split(":");
    process.stderr.write(`\n=== ${client} x ${candidate} ===\n`);
    const pre = preflight(client);
    let result;
    if (!pre.ok) {
      result = { outcome: "infrastructure-unavailable", reasons: [pre.environmental.detail], raw: null };
      recorded[candidate] = recorded[candidate] ?? {};
      recorded[candidate][client] = { status: "not-run", cause: `${pre.environmental.condition}: ${pre.environmental.detail}` };
    } else {
      // Retry policy: at most ONE retry, only on environmental failure; BOTH recorded;
      // conformance-fail is never retried — a flaky pass must not overwrite a real failure.
      // The first attempt used to be overwritten by the second, so its capture id, outcome and
      // relationship to the retry never reached committed evidence and its receipt had nowhere
      // to belong (review round 1, chunk 10).
      const attempts = [await captureCell(client, candidate, pre.clientVersion, 0)];
      if (attempts[0].classified.outcome === "infrastructure-unavailable") {
        process.stderr.write(`  environmental (${attempts[0].classified.reasons.join("; ")}) — one retry\n`);
        attempts.push(await captureCell(client, candidate, pre.clientVersion, 1));
      }
      const capture = attempts[attempts.length - 1];
      result = capture.classified;
      const status = toCellStatus(result.outcome);
      recorded[candidate] = recorded[candidate] ?? {};
      recorded[candidate][client] = {
        status,
        ...(status === "not-run" ? { cause: result.reasons.join("; ") } : {}),
        ...(status === "fail" ? { detail: result.reasons.join("; ").slice(0, 500) } : {}),
        traceDigest: capture.raw.digests.derivationDigest,
        clientVersion: pre.clientVersion,
        // Ordered, the last being the attempt the status reflects. Every entry must have a
        // receipt; the superseded attempt's full manifest is not committed, because the receipt
        // already carries its digests, statistics and outcome.
        attempts: attempts.map((a) => ({ captureId: a.raw.captureId, outcome: a.classified.outcome })),
      };
      // Sanitized manifest -> committed evidence; preservation checked independently.
      const sanitized = sanitize(capture.raw);
      const violations = checkPreservation(capture.raw, sanitized);
      if (violations.length) throw new Error(`sanitizer preservation violated: ${violations.join("; ")}`);
      writeFileSync(
        join(EVIDENCE_REAL, `${client}-${candidate}.manifest.json`),
        JSON.stringify(sanitized, null, 2) + "\n",
      );
      process.stderr.write(`  ${result.outcome}${result.reasons.length ? ` — ${result.reasons.join("; ")}` : ""}\n`);
      process.stderr.write(`  raw capture retained at ${capture.rawDir} until its receipt is written\n`);
    }
    writeFileSync(cellsPath, JSON.stringify(recorded, null, 2) + "\n");
  }
  process.stderr.write(`\ncells recorded in ${cellsPath}\nNEXT: node spikes/mcp/real-client/receipt.mjs (receipt before any evidence commit)\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
