// Tests for the real-client classifier and the manifest sanitizer (plan §9 / §6).
// Runs under `node --test` or directly; test:mcp-spike uses direct execution.
//
// The two classes that must never collapse into each other, each pinned by fixture:
// a post-spawn pre-handshake timeout is `conformance-fail`; a spawn failure is
// `infrastructure-unavailable`. Real-shaped leak fixtures are assembled at runtime from
// fragments so this file stays self-compliant under the T-024 scanner.

import test from "node:test";
import assert from "node:assert/strict";

import { classify, toCellStatus, ENVIRONMENTAL_CONDITIONS, OUTCOMES } from "./classify.mjs";
import { sanitize, checkPreservation, SanitizeError, FIELD_MAP } from "./sanitize.mjs";
import { scanText } from "../../../scripts/privacy-scan.mjs";

const cat = (...parts) => parts.join("");

const EXPECTED = { promptSha256: "a".repeat(64), nonce: "nonce-fixture-0001", completionMarker: "PROBE_DONE" };

/** A record that satisfies every clause — each test then breaks exactly one thing. */
function passingRecord() {
  return {
    client: "claude-code",
    candidate: "v2",
    promptSha256: EXPECTED.promptSha256,
    nonce: EXPECTED.nonce,
    spawn: { client: { ok: true }, server: { ok: true } },
    environmental: null,
    timedOut: false,
    lastPhase: "completed",
    clientExit: { code: 0, signal: null },
    serverTermination: { signal: null },
    frames: [
      { type: "response", method: "initialize", protocolVersion: "2025-06-18" },
      { type: "response", method: "tools/list", toolNames: ["spendbar_probe"] },
      {
        type: "response",
        method: "tools/call",
        structuredNonce: EXPECTED.nonce,
        text: `probe nonce=${EXPECTED.nonce} blocked=false`,
      },
    ],
    serverStdout: { bytes: 2048, remainder: 0, parseErrors: 0 },
    serverStderr: { hasReadyLine: true, containsFrames: false },
    clientStdout: { hasCompletionMarker: true, containsNonce: false, containsAllowlistedEnvValue: false },
  };
}

test("a record satisfying all seven clauses classifies as pass", () => {
  assert.deepEqual(classify(passingRecord(), EXPECTED), { outcome: "pass", reasons: [] });
});

test("a post-spawn pre-handshake timeout is conformance-fail, never environmental", () => {
  const r = passingRecord();
  r.timedOut = true;
  r.lastPhase = "spawned";
  r.frames = [];
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "conformance-fail");
  assert.ok(c.reasons.some((x) => x.includes("conformance-fail by default")), c.reasons.join("; "));
});

test("a spawn failure is infrastructure-unavailable", () => {
  const r = passingRecord();
  r.spawn.server = { ok: false, error: "ENOENT" };
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "infrastructure-unavailable");
});

test("every enumerated environmental condition claims infrastructure-unavailable", () => {
  for (const condition of ENVIRONMENTAL_CONDITIONS) {
    const r = passingRecord();
    r.environmental = { condition, detail: "observed by preflight" };
    assert.equal(classify(r, EXPECTED).outcome, "infrastructure-unavailable", condition);
  }
});

test("a NON-enumerated environmental claim does not stick — the default stands", () => {
  const r = passingRecord();
  r.environmental = { condition: "felt-slow" };
  assert.equal(classify(r, EXPECTED).outcome, "conformance-fail");
});

test("a missing tools/list under verified fresh state is conformance-fail", () => {
  const r = passingRecord();
  r.frames = r.frames.filter((f) => f.method !== "tools/list");
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "conformance-fail");
  assert.ok(c.reasons.some((x) => x.includes("tools/list")));
});

test("frame order is part of the claim: list before initialize fails", () => {
  const r = passingRecord();
  [r.frames[0], r.frames[1]] = [r.frames[1], r.frames[0]];
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "conformance-fail");
  assert.ok(c.reasons.some((x) => x.includes("order")));
});

test("an extra advertised tool, a wrong nonce, or a nonce-free text fallback each fail", () => {
  const extra = passingRecord();
  extra.frames[1].toolNames = ["spendbar_probe", "other_tool"];
  assert.equal(classify(extra, EXPECTED).outcome, "conformance-fail");

  const wrongNonce = passingRecord();
  wrongNonce.frames[2].structuredNonce = "some-other-nonce";
  assert.equal(classify(wrongNonce, EXPECTED).outcome, "conformance-fail");

  const emptyText = passingRecord();
  emptyText.frames[2].text = "";
  assert.equal(classify(emptyText, EXPECTED).outcome, "conformance-fail");
});

test("stream discipline: remainder bytes, frames on stderr, and a nonce on client stdout each fail", () => {
  const rem = passingRecord();
  rem.serverStdout.remainder = 7;
  assert.equal(classify(rem, EXPECTED).outcome, "conformance-fail");

  const frames = passingRecord();
  frames.serverStderr.containsFrames = true;
  assert.equal(classify(frames, EXPECTED).outcome, "conformance-fail");

  const leak = passingRecord();
  leak.clientStdout.containsNonce = true;
  const c = classify(leak, EXPECTED);
  assert.equal(c.outcome, "conformance-fail");
  assert.ok(c.reasons.some((x) => x.includes("nonce-secret")));
});

test("nonzero client exit and signal-terminated server each fail", () => {
  const exit = passingRecord();
  exit.clientExit = { code: 1, signal: null };
  assert.equal(classify(exit, EXPECTED).outcome, "conformance-fail");

  const sig = passingRecord();
  sig.serverTermination = { signal: "SIGKILL" };
  assert.equal(classify(sig, EXPECTED).outcome, "conformance-fail");
});

test("every reason is reported, not just the first", () => {
  const r = passingRecord();
  r.clientExit.code = 1;
  r.serverStdout.remainder = 3;
  r.frames = [];
  const c = classify(r, EXPECTED);
  assert.ok(c.reasons.length >= 4, `expected several reasons, got: ${c.reasons.join("; ")}`);
});

test("the outcome-to-cell mapping is §1's, exactly", () => {
  assert.deepEqual(OUTCOMES.map(toCellStatus), ["pass", "fail", "not-run"]);
});

// ---------- sanitizer ----------------------------------------------------------------------

function rawManifest() {
  return {
    captureId: "cap-0001",
    client: "claude-code",
    candidate: "v2",
    clientVersion: "2.1.220",
    promptSha256: EXPECTED.promptSha256,
    nonce: EXPECTED.nonce,
    executablePath: cat("/Users", "/jdoe/.local/bin/claude"),
    executableIdentity: "sha256:" + "b".repeat(64),
    commandLine: ["-p", "fixed prompt", "--strict-mcp-config", "--mcp-config", cat("/Users", "/jdoe/tmp/mcp.json")],
    env: { PATH: cat("/Users", "/jdoe/bin:/usr/bin"), SPENDBAR_RESOLVE_LOG: "/tmp/r.ndjson" },
    cwd: cat("/Users", "/jdoe/scratch"),
    spawn: { client: { ok: true }, server: { ok: true } },
    environmental: null,
    timedOut: false,
    lastPhase: "completed",
    clientExit: { code: 0, signal: null },
    serverTermination: { signal: null },
    frames: [{ type: "response", method: "initialize", protocolVersion: "2025-06-18" }],
    serverStdout: { bytes: 2048, remainder: 0, parseErrors: 0 },
    serverStderr: { hasReadyLine: true, containsFrames: false },
    clientStdout: { hasCompletionMarker: true, containsNonce: false, containsAllowlistedEnvValue: false },
    digests: { serverStdoutSha256: "c".repeat(64), serverStderrSha256: "d".repeat(64) },
    retries: [],
  };
}

test("sanitize: paths become typed placeholders, env values vanish, evidence survives byte-identical", () => {
  const raw = rawManifest();
  const s = sanitize(raw);
  assert.equal(s.executablePath, "<path:executablePath>");
  assert.equal(s.cwd, "<path:cwd>");
  assert.deepEqual(s.env, ["PATH", "SPENDBAR_RESOLVE_LOG"]);
  assert.deepEqual(s.commandLine, ["-p", "fixed prompt", "--strict-mcp-config", "--mcp-config", "<arg4:path>"]);
  assert.deepEqual(s.digests, raw.digests);
  assert.deepEqual(s.serverStdout, raw.serverStdout);
  assert.deepEqual(checkPreservation(raw, s), []);
});

test("a raw field with no declared transformation is a hard error, not a pass-through", () => {
  const raw = rawManifest();
  raw.surpriseField = "captured later by someone helpful";
  assert.throws(() => sanitize(raw), SanitizeError);
});

test("every declared transformation is from the allowlist", () => {
  for (const t of Object.values(FIELD_MAP)) {
    assert.ok(["copy", "placeholder-path", "argv-map", "env-names-only"].includes(t), t);
  }
});

test("mutation: dropping an argument is rejected by the independent preservation check", () => {
  const raw = rawManifest();
  const s = sanitize(raw);
  s.commandLine = s.commandLine.slice(0, -1);
  assert.ok(checkPreservation(raw, s).some((v) => v.includes("changed length")));
});

test("mutation: reordering two arguments is rejected", () => {
  const raw = rawManifest();
  const s = sanitize(raw);
  [s.commandLine[0], s.commandLine[2]] = [s.commandLine[2], s.commandLine[0]];
  assert.ok(checkPreservation(raw, s).length > 0);
});

test("mutation: merging two arguments into one is rejected", () => {
  const raw = rawManifest();
  const s = sanitize(raw);
  s.commandLine = [`${s.commandLine[0]} ${s.commandLine[1]}`, ...s.commandLine.slice(2)];
  assert.ok(checkPreservation(raw, s).some((v) => v.includes("changed length")));
});

test("mutation: altering a flag name or an adverse process fact is rejected", () => {
  const raw = rawManifest();
  const s1 = sanitize(raw);
  s1.commandLine[2] = "--lenient-mcp-config";
  assert.ok(checkPreservation(raw, s1).some((v) => v.includes("flag")));

  const s2 = sanitize(raw);
  s2.clientExit = { code: 0, signal: null };
  raw.clientExit = { code: 1, signal: null }; // the raw run actually failed
  assert.ok(checkPreservation(raw, s2).some((v) => v.includes("clientExit")));
});

test("two materially different commands never normalize to the same representation", () => {
  const a = rawManifest();
  const b = rawManifest();
  b.commandLine = [...b.commandLine, "--dangerously-skip-permissions"];
  assert.notEqual(JSON.stringify(sanitize(a).commandLine), JSON.stringify(sanitize(b).commandLine));
});

test("an environment VALUE surviving anywhere in the sanitized manifest is a violation", () => {
  const raw = rawManifest();
  const s = sanitize(raw);
  s.frames = [...s.frames, { type: "note", text: raw.env.PATH }];
  assert.ok(checkPreservation(raw, s).some((v) => v.includes("environment VALUE")));
});

test("the T-024 scanner catches a real-shaped path planted in a committed-manifest fixture", () => {
  // The §8 leak direction: if a buggy sanitizer ever let a real home path through to the
  // committed manifest, the scanner that gates every commit must reject it.
  const planted = JSON.stringify({ ...sanitize(rawManifest()), oops: cat("/Users", "/jdoe/Developer/x") });
  const findings = scanText(planted, "fixture-manifest.json");
  assert.ok(findings.length > 0, "scanner missed a real-shaped path in the manifest fixture");
  assert.ok(findings.every((f) => !JSON.stringify(f).includes("jdoe")), "a finding carried the value");
});
