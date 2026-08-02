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
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
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
import { isDirectEntry } from "../../../scripts/direct-entry.mjs";

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
export const MAX_CLIENT_STREAM_BYTES = 8 * 1024 * 1024;

// The two literals the server-stderr predicates are computed from, named and exported so the
// receipt can re-derive those predicates from the retained bytes using the SAME definitions
// rather than a copy that can drift (review round 2, chunk 8). No /g flag: this regex is
// shared, and a stateful one would answer differently on alternate calls.
export const READY_LINE = "spendbar-probe-server ready";
export const SERVER_FRAME_ON_STDERR = /"jsonrpc"\s*:\s*"2\.0"/;

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

/**
 * Record a client stream to disk AND keep a bounded prefix in memory.
 *
 * Review round 2, chunk 4 — the critical finding. Client stdout and stderr used to exist only
 * in memory until the run finished, and were written to the retained directory afterwards. A
 * capture process killed at any point before that — the operator's ^C, an OOM, a laptop lid —
 * destroyed the entire client-side transcript of a run that had already been PAID FOR, leaving
 * a retained directory holding the wrapper's streams and a manifest still in its pre-spawn
 * skeleton. Nothing about that is recoverable.
 *
 * Every chunk now lands on disk as it arrives, so the bytes survive the process that observed
 * them. The in-memory copy is kept only to derive the disclosure predicates, and it stays
 * bounded so a runaway client cannot exhaust memory; when the bound bites, `truncated` says so
 * and the predicates are known to describe a prefix. The DIGEST is taken from the file, which
 * is the complete stream, so it binds everything the client emitted rather than everything that
 * fit in memory.
 */
function streamRecorder(path) {
  writeFileSync(path, "");
  chmodSync(path, 0o600);
  const chunks = [];
  let bytes = 0;
  let totalBytes = 0;
  let truncated = false;
  let writeErrors = 0;
  return {
    push(chunk) {
      try {
        appendFileSync(path, chunk); // durability first — this is the copy that outlives us
      } catch {
        writeErrors += 1;
      }
      totalBytes += chunk.length;
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
      return { buf, text: buf.toString("utf8"), truncated, totalBytes, writeErrors, path };
    },
  };
}

/** Replace `path` atomically: a reader sees the whole previous file or the whole new one. */
function writeFileAtomic(path, contents, mode = 0o600) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
}

/**
 * Environment variables whose value is a bare word that a client transcript will legitimately
 * contain for reasons that have nothing to do with disclosure — a locale, a terminal type.
 * These are the ONLY ones exempt, and they are exempt by NAME, not by length.
 */
const NON_IDENTIFYING_ENV = new Set(["LANG", "LC_ALL", "TERM", "NO_PROXY"]);

/**
 * Did the client's own output disclose one of the environment values it was given?
 *
 * The rule used to be a blanket "skip anything under 8 characters", which is the same defect
 * found in the sanitizer's preservation check one chunk earlier: a short account name is still
 * an account name, and a short proxy credential is still a credential. USER and LOGNAME are
 * exactly the identifying values most likely to be short, and they were the ones being skipped.
 *
 * Identifying values are searched for at ANY length; the ones short enough to collide with
 * ordinary prose (`USER`, `LOGNAME`) are matched on word boundaries so "amy" does not fire on
 * "dynamic". Nothing is exempt for being short — only for being named above.
 */
export function disclosesEnvValue(env, text) {
  const wordBounded = new Set(["USER", "LOGNAME", "SHELL"]);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (NON_IDENTIFYING_ENV.has(name)) continue;
    if (wordBounded.has(name)) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text)) return true;
      continue;
    }
    if (text.includes(value)) return true;
  }
  return false;
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

/**
 * The name a capture directory must have to be one of ours: exactly what captureCell builds.
 * A recursive delete inside the operator's home directory gets a name it can prove it wrote.
 */
export const CAPTURE_ID = /^(claude-code|codex)-(v1|v2)-[0-9a-f]{8}$/;
/** Written into every capture directory, so ownership is a fact on disk and not just a name. */
export const OWNER_MARKER = "spendbar-t009-capture";

/**
 * Sweep abandoned captures (no receipt after RETENTION_DAYS). Receipted ones are already gone.
 *
 * Hardened in review round 2, chunk 4. This is a RECURSIVE DELETE running inside the operator's
 * home directory, and it used to treat every entry it found as one of ours: it followed
 * symlinks through statSync, never checked the name or the type, and would happily remove an
 * unrelated old file or directory that someone had put there. A dangling symlink threw and
 * aborted the sweep partway. Every entry must now prove it is ours — a well-formed capture id,
 * a real directory reached without following a link, and the marker this tool writes — and
 * anything that fails is REPORTED AND LEFT ALONE, never deleted and never fatal.
 *
 * A future mtime is treated as unusable rather than as infinitely young: a clock skew that
 * makes a capture look like it is from next year would otherwise pin it forever.
 */
export function sweepAbandoned(now = Date.now()) {
  const { swept, skipped } = sweepAbandonedIn(RETAINED_DIR, now);
  // Silence here would read as "the directory was clean". Anything left behind is named.
  for (const note of skipped) process.stderr.write(`  sweep left ${note}\n`);
  return swept;
}

/**
 * The sweep itself, against a named root. Taking the root as a parameter is what makes the
 * refusals above testable at all: every one of them is about what this function will and will
 * not delete, and none could be exercised while the directory was a module-level constant
 * pointing into the operator's real home.
 */
export function sweepAbandonedIn(retainedDir, now = Date.now()) {
  if (!existsSync(retainedDir)) return { swept: [], skipped: [] };
  const swept = [];
  const skipped = [];
  for (const entry of readdirSync(retainedDir)) {
    const dir = join(retainedDir, entry);
    if (!CAPTURE_ID.test(entry)) {
      skipped.push(`${entry}: not a capture id`);
      continue;
    }
    let info;
    try {
      info = lstatSync(dir); // lstat, not stat: a symlink is never followed and never removed
    } catch {
      skipped.push(`${entry}: unreadable`);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      skipped.push(`${entry}: not a directory`);
      continue;
    }
    if (!existsSync(join(dir, OWNER_MARKER))) {
      skipped.push(`${entry}: no ownership marker`);
      continue;
    }
    const age = now - info.mtimeMs;
    if (age < 0) {
      skipped.push(`${entry}: mtime is in the future`);
      continue;
    }
    if (age > RETENTION_DAYS * 24 * 3600 * 1000) {
      rmSync(dir, { recursive: true, force: true });
      swept.push(entry);
    }
  }
  // The refusals are RETURNED rather than only printed, so a test can assert that a particular
  // entry was left alone for a particular reason. A sweep whose skip list nobody can read is a
  // sweep whose refusals nobody can test.
  return { swept, skipped };
}

/**
 * The cells this command knows how to run, and the only values --cell may name.
 * Validating BEFORE anything spawns is the whole point: an unrecognised client used to reach
 * the codex branch, spend real quota, and then be rejected by the sanitizer afterwards.
 */
export const ALL_CELLS = ["claude-code:v1", "claude-code:v2", "codex:v1", "codex:v2"];

/**
 * Parse --cell selections. Both `--cell=x:y` and `--cell x:y` are accepted, because the usage
 * line at the top of this file documents the space-separated form and the parser only ever
 * understood the attached one — so `--cell claude-code:v1` silently selected NOTHING, fell
 * through to "no selection means all of them", and spent four cells' quota instead of one.
 */
export function parseCells(argv) {
  const requested = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--cell=")) requested.push(arg.slice("--cell=".length));
    else if (arg === "--cell") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("--cell needs a <client>:<candidate> value");
      requested.push(value);
      i += 1;
    }
  }
  const unknown = requested.filter((cell) => !ALL_CELLS.includes(cell));
  if (unknown.length) {
    throw new Error(`--cell: ${unknown.join(", ")} — expected one of ${ALL_CELLS.join(", ")}`);
  }
  const seen = new Set();
  const duplicates = requested.filter((cell) => (seen.has(cell) ? true : (seen.add(cell), false)));
  if (duplicates.length) throw new Error(`--cell: ${duplicates.join(", ")} requested more than once`);
  return requested.length ? requested : [...ALL_CELLS];
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
  // Proof of ownership on disk, written before anything else. The abandonment sweep will not
  // recursively delete a directory that does not carry it.
  writeFileSync(join(rawDir, OWNER_MARKER), `${captureId}\n`, { mode: 0o600 });

  const scratchCwd = mkdtempSync(join(tmpdir(), "t009-client-cwd-"));
  assertOutsideRepo(scratchCwd);
  const { root, treeSha256, cleanup } = assembleCandidateRoot(candidate);
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
    // The dependency bytes the server is about to execute, not the lockfile that describes
    // them. Taken by isolate.mjs from the tree it copied into the assembled root.
    candidateTreeSha256: treeSha256,
    spawn: { client: { ok: false }, server: { ok: false } },
    environmental: null,
    // The hostile-config canary, recorded as a fact independently of any environmental claim:
    // the classifier admits a fresh-state-isolation claim only against this witness.
    // `userConfigIsolated` is the honest counterpart — see buildClientInvocation.
    isolation: { hostileConfigExecuted: false, userConfigIsolated: client === "claude-code" },
    timedOut: false,
    // Whether the post-SIGKILL wait for the pipes to close ran out. A capture where this is
    // true was still being written by something when its bytes were read, so its digests are
    // not a promise about a settled state.
    drainTimedOut: false,
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
  // Every checkpoint of the manifest is atomic, so a process death cannot leave a truncated
  // one where a complete earlier one used to be.
  const manifestPath = join(rawDir, "raw-manifest.json");
  const checkpoint = () => writeFileAtomic(manifestPath, JSON.stringify(raw, null, 2));
  checkpoint();

  // The client's streams are opened BEFORE the spawn, so the first byte the client writes is
  // already landing somewhere that outlives this process.
  const outCollector = streamRecorder(join(rawDir, "client-stdout.raw"));
  const errCollector = streamRecorder(join(rawDir, "client-stderr.raw"));
  let clientOut;
  let clientErr;
  try {
    // `detached: true` puts the client in its own process group so the timeout path can kill
    // the GROUP. Killing only the client leaves the wrapper and the candidate server alive,
    // still writing into the very files this function is about to read and hash — digests that
    // would not bind the bytes that ended up on disk (review round 2, chunk 4).
    const child = spawn(binary, args, {
      cwd: scratchCwd,
      env: clientEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    raw.spawn.client.ok = true;
    child.stdout.on("data", (d) => outCollector.push(d));
    child.stderr.on("data", (d) => errCollector.push(d));
    let drainTimer = null;
    const exit = await new Promise((resolve) => {
      // `close`, not `exit`: `exit` fires while stdout/stderr may still be draining, so the
      // post-run derivation could read a capture that was still being written, and the
      // assembled candidate root could be deleted out from under a live process.
      const deadline = setTimeout(() => {
        raw.timedOut = true;
        // The whole GROUP, not just the client: the wrapper and the candidate server are its
        // descendants and they write the files this function is about to hash. `-pid` needs
        // the `detached: true` above to name a group; if the group is already gone, fall back
        // to the client alone rather than throwing out of a timer.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already reaped */
          }
        }
        // A grandchild holding the pipes open can delay `close` indefinitely. Waiting forever
        // is not an option and neither is pretending it closed, so the wait is bounded and the
        // outcome is recorded either way. This timer is NOT unref'd: it is the only thing that
        // can settle this promise once the child is gone, and an unref'd timer lets Node exit
        // first — abandoning a paid run mid-record (review round 2, chunk 4).
        raw.drainTimedOut = false;
        drainTimer = setTimeout(() => {
          raw.drainTimedOut = true;
          resolve({ code: null, signal: "SIGKILL" });
        }, DRAIN_DEADLINE_MS);
      }, RUN_DEADLINE_MS);
      child.on("close", (code, signal) => {
        clearTimeout(deadline);
        if (drainTimer) clearTimeout(drainTimer);
        resolve({ code, signal });
      });
      child.on("error", (error) => {
        clearTimeout(deadline);
        if (drainTimer) clearTimeout(drainTimer);
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
    // The exit state is on disk before anything downstream can throw. Everything after this
    // point is DERIVATION — reading, parsing, hashing — and all of it can fail on a run that
    // has already been paid for.
    checkpoint();
  }

  // Post-run derivation, from the retained bytes. Wrapped, because a throw in here used to
  // leave the manifest as its pre-spawn skeleton: the exit status, the streams' statistics and
  // every digest existed only in memory and went with the exception, the scratch directory
  // survived, and the whole batch aborted without recording that the cell had run at all
  // (review round 2, chunk 4). Now the failure is a RECORDED OUTCOME of a real attempt.
  try {
    deriveFromCapture();
  } catch (error) {
    raw.environmental = {
      condition: "capture-derivation-failed",
      detail: `derivation failed after the run: ${error?.constructor?.name ?? "Error"}`,
    };
  } finally {
    checkpoint();
    rmSync(scratchCwd, { recursive: true, force: true });
  }

  const expected = { promptSha256: PROMPT_TEMPLATE_SHA256, nonce, completionMarker: COMPLETION_MARKER };
  return { raw, rawDir, classified: classify(raw, expected) };

  function deriveFromCapture() {
  const readRaw = (name) => (existsSync(join(rawDir, name)) ? readFileSync(join(rawDir, name)) : Buffer.alloc(0));
  const c2s = readRaw("client-to-server.raw");
  const s2c = readRaw("server-stdout.raw");
  const serverErr = readRaw("server-stderr.raw");
  // The client streams are already on disk — written as they arrived, not now — so what gets
  // digested is everything the client emitted, including whatever exceeded the in-memory bound.
  const clientOutBytes = readRaw("client-stdout.raw");
  const clientErrBytes = readRaw("client-stderr.raw");
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
    hasReadyLine: errText.includes(READY_LINE),
    containsFrames: SERVER_FRAME_ON_STDERR.test(errText),
  };
  raw.clientStdout = {
    hasCompletionMarker: clientOut.text.includes(COMPLETION_MARKER),
    containsNonce: clientOut.text.includes(nonce),
    // Derived, not asserted. This was hardcoded `false`, which made the pass-oracle clause
    // that reads it incapable of ever failing — an environment disclosure would have been
    // recorded as clean.
    containsAllowlistedEnvValue: disclosesEnvValue(clientEnv, clientOut.text),
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
  //
  // Digested from the FILES, not from the in-memory copies. The in-memory copies are bounded,
  // so on a client that emitted more than the bound they are a prefix — digesting those would
  // have produced a digest that did not bind the bytes actually retained, and the receipt would
  // have failed to reproduce them (review round 2, chunk 4).
  raw.digests = {
    clientToServerSha256: sha256(c2s),
    serverStdoutSha256: sha256(s2c),
    serverStderrSha256: sha256(serverErr),
    clientStdoutSha256: sha256(clientOutBytes),
    clientStderrSha256: sha256(clientErrBytes),
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
  }
}

// ---------- main ----------------------------------------------------------------------------

/**
 * CI indicators. The header of this file has always said the command is NEVER CI-runnable, and
 * until review round 2 chunk 4 nothing enforced it — an accidental workflow step would have
 * spent four cells of real quota, on a runner whose HOME holds the credentials the allowlist
 * deliberately passes through. The claim is now a check, made BEFORE any spawn or any mutation.
 */
const CI_MARKERS = ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TF_BUILD"];

export function ciIndicator(env = process.env) {
  for (const name of CI_MARKERS) {
    const value = env[name];
    if (typeof value === "string" && value !== "" && value !== "0" && value.toLowerCase() !== "false") return name;
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const ci = ciIndicator();
  if (ci) {
    throw new Error(
      `real-client capture is forbidden in CI (${ci} is set): this command spends real quota and ` +
        `authenticates from the invoking account's HOME`,
    );
  }
  if (argv.includes("--purge")) {
    ensureRetainedDir();
    const swept = sweepAbandoned(Infinity);
    process.stderr.write(`purged ${swept.length} retained capture(s)\n`);
    return;
  }
  // Selections are validated before the sweep and before any spawn: an unrecognised cell must
  // not reach a paid client and be rejected only afterwards by the sanitizer.
  const cells = parseCells(argv);

  ensureRetainedDir();
  const swept = sweepAbandoned();
  if (swept.length) process.stderr.write(`startup sweep removed ${swept.length} abandoned capture(s)\n`);

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
      //
      // Each attempt is written into cells.json the moment it returns, BEFORE the retry is
      // started. "Both recorded" used to be true only if the second attempt also survived: a
      // retry that threw, or was interrupted, left the already-paid first attempt with a raw
      // directory and no committed entry, so nothing could ever associate a receipt with it
      // (review round 2, chunk 4).
      const attempts = [];
      const noteAttempts = () => {
        recorded[candidate] = recorded[candidate] ?? {};
        recorded[candidate][client] = {
          ...(recorded[candidate][client] ?? { status: "not-run", cause: "attempt in progress" }),
          clientVersion: pre.clientVersion,
          attempts: attempts.map((a) => ({ captureId: a.raw.captureId, outcome: a.classified.outcome })),
        };
        writeFileAtomic(cellsPath, JSON.stringify(recorded, null, 2) + "\n", 0o644);
      };

      attempts.push(await captureCell(client, candidate, pre.clientVersion, 0));
      noteAttempts();
      if (attempts[0].classified.outcome === "infrastructure-unavailable") {
        process.stderr.write(`  environmental (${attempts[0].classified.reasons.join("; ")}) — one retry\n`);
        attempts.push(await captureCell(client, candidate, pre.clientVersion, 1));
        noteAttempts();
      }
      const capture = attempts[attempts.length - 1];
      result = capture.classified;
      const status = toCellStatus(result.outcome);
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
      // Sanitized manifest -> committed evidence; preservation checked independently. A capture
      // whose derivation failed cannot produce one — it has no digests to commit — and that is
      // a recorded not-run for THIS cell, not a reason to abandon the cells already paid for.
      try {
        const sanitized = sanitize(capture.raw);
        const violations = checkPreservation(capture.raw, sanitized);
        if (violations.length) throw new Error(`sanitizer preservation violated: ${violations.join("; ")}`);
        writeFileAtomic(
          join(EVIDENCE_REAL, `${client}-${candidate}.manifest.json`),
          JSON.stringify(sanitized, null, 2) + "\n",
          0o644,
        );
      } catch (error) {
        recorded[candidate][client] = {
          ...recorded[candidate][client],
          status: "not-run",
          cause: `no committable manifest: ${error?.message ?? "unknown"}`,
        };
        process.stderr.write(`  manifest not committed — ${error?.message ?? "unknown"}\n`);
      }
      process.stderr.write(`  ${result.outcome}${result.reasons.length ? ` — ${result.reasons.join("; ")}` : ""}\n`);
      process.stderr.write(`  raw capture retained at ${capture.rawDir} until its receipt is written\n`);
    }
    writeFileAtomic(cellsPath, JSON.stringify(recorded, null, 2) + "\n", 0o644);
  }
  process.stderr.write(`\ncells recorded in ${cellsPath}\nNEXT: node spikes/mcp/real-client/receipt.mjs (receipt before any evidence commit)\n`);
}

if (isDirectEntry(import.meta.url)) {
  await main();
}
