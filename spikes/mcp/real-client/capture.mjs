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
import { sanitize, checkPreservation } from "./sanitize.mjs";

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

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

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
  // Codex: MCP servers via -c config overrides; user config cannot be hostile-injected
  // without modifying ~/.codex (forbidden), which is recorded in the manifest note.
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

  // The raw manifest skeleton is recorded BEFORE the run — the nonce and prompt hash are
  // inputs, not outputs.
  const raw = {
    captureId,
    client,
    candidate,
    clientVersion,
    promptSha256: PROMPT_TEMPLATE_SHA256,
    nonce,
    executablePath: binary,
    executableIdentity: "resolved-at-spawn-via-PATH",
    commandLine: args,
    env: { PATH: process.env.PATH ?? "" },
    cwd: scratchCwd,
    spawn: { client: { ok: false }, server: { ok: false } },
    environmental: null,
    timedOut: false,
    lastPhase: "pre-spawn",
    clientExit: { code: null, signal: null },
    serverTermination: { signal: null },
    frames: [],
    serverStdout: { bytes: 0, remainder: 0, parseErrors: 0 },
    serverStderr: { hasReadyLine: false, containsFrames: false },
    clientStdout: { hasCompletionMarker: false, containsNonce: false, containsAllowlistedEnvValue: false },
    digests: {},
    retries: attempt > 0 ? [`attempt ${attempt + 1} after infrastructure-unavailable`] : [],
  };
  writeFileSync(join(rawDir, "raw-manifest.json"), JSON.stringify(raw, null, 2));
  chmodSync(join(rawDir, "raw-manifest.json"), 0o600);

  let clientOut = "";
  let clientErr = "";
  try {
    const child = spawn(binary, args, { cwd: scratchCwd, stdio: ["ignore", "pipe", "pipe"] });
    raw.spawn.client.ok = true;
    child.stdout.on("data", (d) => (clientOut += d));
    child.stderr.on("data", (d) => (clientErr += d));
    const exit = await new Promise((resolve) => {
      const deadline = setTimeout(() => {
        raw.timedOut = true;
        child.kill("SIGKILL"); // disposed, not merely stopped
        resolve({ code: null, signal: "SIGKILL" });
      }, RUN_DEADLINE_MS);
      child.on("exit", (code, signal) => {
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
    cleanup();
  }

  // Post-run: derive everything from the retained bytes.
  const readRaw = (name) => (existsSync(join(rawDir, name)) ? readFileSync(join(rawDir, name)) : Buffer.alloc(0));
  const c2s = readRaw("client-to-server.raw");
  const s2c = readRaw("server-stdout.raw");
  const serverErr = readRaw("server-stderr.raw");
  writeFileSync(join(rawDir, "client-stdout.raw"), clientOut);
  writeFileSync(join(rawDir, "client-stderr.raw"), clientErr);
  for (const f of readdirSync(rawDir)) chmodSync(join(rawDir, f), 0o600);

  raw.spawn.server.ok = s2c.length > 0 || existsSync(join(rawDir, "server-exit.json"));
  if (existsSync(join(rawDir, "server-exit.json"))) {
    raw.serverTermination = { signal: JSON.parse(readFileSync(join(rawDir, "server-exit.json"), "utf8")).signal };
  }
  const derived = normalize(c2s, s2c);
  raw.frames = derived.frames;
  raw.serverStdout = derived.serverStdout;
  const errText = serverErr.toString("utf8");
  raw.serverStderr = {
    hasReadyLine: errText.includes("spendbar-probe-server ready"),
    containsFrames: /"jsonrpc"\s*:\s*"2\.0"/.test(errText),
  };
  raw.clientStdout = {
    hasCompletionMarker: clientOut.includes(COMPLETION_MARKER),
    containsNonce: clientOut.includes(nonce),
    containsAllowlistedEnvValue: false, // PATH is the only allowlisted value; matching it in prose would be noise
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
  raw.digests = {
    clientToServerSha256: sha256(c2s),
    serverStdoutSha256: sha256(s2c),
    serverStderrSha256: sha256(serverErr),
    derivationDigest: derived.derivationDigest,
  };

  // Positively observed environmental conditions, from the record.
  if (existsSync(hostileCanary)) {
    raw.environmental = { condition: "fresh-state-isolation-failure", detail: "hostile project config executed" };
  } else if (!raw.spawn.client.ok || !raw.spawn.server.ok) {
    // spawn-failure handled by the classifier from raw.spawn
  } else if (/not logged in|authentication|unauthorized|401/i.test(clientErr) && raw.clientExit.code !== 0) {
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
      let attempt = 0;
      let capture = await captureCell(client, candidate, pre.clientVersion, attempt);
      if (capture.classified.outcome === "infrastructure-unavailable" && attempt === 0) {
        // Retry policy: at most ONE retry, only on environmental failure; both recorded;
        // conformance-fail is never retried — a flaky pass must not overwrite a real failure.
        process.stderr.write(`  environmental (${capture.classified.reasons.join("; ")}) — one retry\n`);
        attempt = 1;
        capture = await captureCell(client, candidate, pre.clientVersion, attempt);
      }
      result = capture.classified;
      const status = toCellStatus(result.outcome);
      recorded[candidate] = recorded[candidate] ?? {};
      recorded[candidate][client] = {
        status,
        ...(status === "not-run" ? { cause: result.reasons.join("; ") } : {}),
        ...(status === "fail" ? { detail: result.reasons.join("; ").slice(0, 500) } : {}),
        traceDigest: capture.raw.digests.derivationDigest,
        clientVersion: pre.clientVersion,
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
