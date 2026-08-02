// Tests for the real-client classifier and the manifest sanitizer (plan §9 / §6).
// Runs under `node --test` or directly; test:mcp-spike uses direct execution.
//
// The two classes that must never collapse into each other, each pinned by fixture:
// a post-spawn pre-handshake timeout is `conformance-fail`; a spawn failure is
// `infrastructure-unavailable`. Review round 1 added the third thing that must not collapse:
// a MISSING structural field is invalid evidence, not an observation — because reading absent
// spawn data as "spawn was observed to fail" turned a deletion into a not-run.
//
// Real-shaped leak fixtures are assembled at runtime from fragments so this file stays
// self-compliant under the T-024 scanner.

import test from "node:test";
import assert from "node:assert/strict";

import { classify, toCellStatus, ENVIRONMENTAL_CONDITIONS, OUTCOMES, InvalidRecordError } from "./classify.mjs";
import {
  sanitize,
  checkPreservation,
  SanitizeError,
  FIELD_MAP,
  TRANSFORM_NAMES,
  SCHEMA,
  PLACEHOLDER,
  STREAM_STAT_KEYS,
} from "./sanitize.mjs";
import { CAPTURE_INPUTS } from "./provenance.mjs";
import { buildClientEnv, CLIENT_ENV_ALLOWLIST } from "./capture.mjs";
import { scanText } from "../../../scripts/privacy-scan.mjs";

const cat = (...parts) => parts.join("");

const EXPECTED = {
  promptSha256: "a".repeat(64),
  promptInstanceSha256: "1".repeat(64),
  nonce: "nonce-fixture-0001",
  completionMarker: "PROBE_DONE",
};

/** A full capture-input pin, built from the declared list so the fixture cannot drift from it. */
const capturePins = () => Object.fromEntries(CAPTURE_INPUTS.map((rel, i) => [rel, String(i % 10).repeat(64)]));

/** A clean stream-statistics block; `over` breaks exactly one counter. */
const stats = (over = {}) => ({
  bytes: 2048,
  lines: 3,
  messages: 3,
  remainder: 0,
  encodingErrors: 0,
  parseErrors: 0,
  protocolErrors: 0,
  ...over,
});

/** A record that satisfies every clause — each test then breaks exactly one thing. */
function passingRecord() {
  return {
    client: "claude-code",
    candidate: "v2",
    promptSha256: EXPECTED.promptSha256,
    promptInstanceSha256: EXPECTED.promptInstanceSha256,
    nonce: EXPECTED.nonce,
    spawn: { client: { ok: true }, server: { ok: true } },
    environmental: null,
    isolation: { hostileConfigExecuted: false, userConfigIsolated: true },
    timedOut: false,
    lastPhase: "called",
    clientExit: { code: 0, signal: null },
    serverTermination: { signal: null },
    wrapper: { spawned: true, closed: true, forwardErrors: 0 },
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
    clientToServer: stats({ bytes: 512 }),
    serverStdout: stats(),
    serverStderr: { hasReadyLine: true, containsFrames: false },
    clientStdout: {
      hasCompletionMarker: true,
      containsNonce: false,
      containsAllowlistedEnvValue: false,
      truncated: false,
    },
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
  r.frames = []; // nothing spawned, so nothing was exchanged
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "infrastructure-unavailable");
});

test("a recorded spawn failure that the trace contradicts is a failure, not a not-run", () => {
  // Frames cannot exist without the processes that exchanged them. Taking the spawn booleans
  // at face value here would let one edited field turn a failing run into "never ran".
  const r = passingRecord();
  r.spawn.server = { ok: false };
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "conformance-fail");
  assert.ok(c.reasons.some((x) => x.includes("contradicts itself")), c.reasons.join("; "));
});

// ---------- environmental claims need witnesses -----------------------------------------------

/** The same claim, with the condition-specific observation that entitles it. */
function witnessedRecord(condition) {
  const r = passingRecord();
  r.environmental = { condition, detail: "observed by preflight" };
  if (condition === "fresh-state-isolation-failure") {
    r.isolation.hostileConfigExecuted = true;
    return r; // the one condition whose meaning survives a run that otherwise went fine
  }
  // Every other condition means the run did not happen: no protocol progress, no completion.
  r.frames = [];
  r.clientExit = { code: 1, signal: null };
  r.clientStdout.hasCompletionMarker = false;
  if (condition === "binary-missing" || condition === "spawn-failure") r.spawn.client = { ok: false };
  return r;
}

test("every enumerated environmental condition claims infrastructure-unavailable — WITH its witness", () => {
  for (const condition of ENVIRONMENTAL_CONDITIONS) {
    assert.equal(classify(witnessedRecord(condition), EXPECTED).outcome, "infrastructure-unavailable", condition);
  }
});

test("an environmental claim with no witness in the record does not stick", () => {
  // The laundering route this closes: a capture that FAILED conformance appends an
  // `environmental` block, and the cell silently becomes not-run instead of fail.
  for (const condition of ENVIRONMENTAL_CONDITIONS) {
    const r = passingRecord();
    r.clientExit = { code: 1, signal: null }; // a real conformance failure
    r.environmental = { condition, detail: "claimed, not observed" };
    const c = classify(r, EXPECTED);
    assert.equal(c.outcome, "conformance-fail", condition);
    assert.ok(
      c.reasons.some((x) => x.includes("no witness") || x.includes("contradicts the trace")),
      `${condition}: ${c.reasons.join("; ")}`,
    );
  }
});

test("an environmental claim contradicted by protocol progress is rejected", () => {
  const r = passingRecord();
  r.spawn.client = { ok: false }; // would witness binary-missing on its own...
  r.environmental = { condition: "binary-missing", detail: "claimed" };
  // ...but the frames say initialize/tools-list/tools-call all came back, so the run ran.
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "conformance-fail");
  assert.ok(c.reasons.some((x) => x.includes("contradicts the trace")), c.reasons.join("; "));
});

test("an observed hostile-config canary is infrastructure-unavailable even with no claim made", () => {
  const r = passingRecord();
  r.isolation.hostileConfigExecuted = true;
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "infrastructure-unavailable");
  assert.ok(c.reasons[0].includes("fresh-state-isolation-failure"));
});

test("a NON-enumerated environmental claim does not stick — the default stands", () => {
  const r = passingRecord();
  r.environmental = { condition: "felt-slow" };
  assert.equal(classify(r, EXPECTED).outcome, "conformance-fail");
});

// ---------- missing structure is invalid evidence, not an outcome -----------------------------

test("missing or malformed structural data throws InvalidRecordError instead of classifying", () => {
  // Every one of these previously read as an observation. `spawn` was the dangerous one:
  // deleting it produced infrastructure-unavailable, i.e. a fail downgraded to a not-run.
  const mutations = [
    ["spawn deleted", (r) => delete r.spawn],
    ["spawn.server deleted", (r) => delete r.spawn.server],
    ["spawn.client.ok is a string", (r) => (r.spawn.client.ok = "false")],
    ["isolation deleted", (r) => delete r.isolation],
    ["isolation.hostileConfigExecuted missing", (r) => (r.isolation = {})],
    ["serverStdout deleted", (r) => delete r.serverStdout],
    ["clientToServer deleted", (r) => delete r.clientToServer],
    ["a counter is missing", (r) => delete r.serverStdout.protocolErrors],
    ["a counter is negative", (r) => (r.serverStdout.parseErrors = -1)],
    ["frames is not an array", (r) => (r.frames = {})],
    ["environmental is a string", (r) => (r.environmental = "auth-failure")],
  ];
  for (const [label, mutate] of mutations) {
    const r = passingRecord();
    mutate(r);
    assert.throws(() => classify(r, EXPECTED), InvalidRecordError, label);
  }
});

// ---------- conformance clauses ---------------------------------------------------------------

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

test("an unattributable response — a reused request id — is conformance-fail", () => {
  const r = passingRecord();
  r.frames.push({ type: "response", method: "ambiguous" });
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "conformance-fail");
  assert.ok(c.reasons.some((x) => x.includes("reused a request id")), c.reasons.join("; "));
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

test("every unaccounted-for byte counter fails, on BOTH directions", () => {
  // The client->server stream was judged by nothing at all before review round 1: junk there
  // was silently skipped, so a trace could look clean while half the requests never parsed.
  for (const counter of ["encodingErrors", "parseErrors", "protocolErrors"]) {
    for (const direction of ["serverStdout", "clientToServer"]) {
      const r = passingRecord();
      r[direction][counter] = 2;
      const c = classify(r, EXPECTED);
      assert.equal(c.outcome, "conformance-fail", `${direction}.${counter}`);
      assert.ok(c.reasons.some((x) => x.includes("2")), `${direction}.${counter}: ${c.reasons.join("; ")}`);
    }
  }
});

test("the tee wrapper's own witnesses are pass clauses, not decoration", () => {
  // A tee that recorded bytes it could not deliver is not a record of an exchange, and streams
  // that never closed mean the capture may be missing its tail.
  const undelivered = passingRecord();
  undelivered.wrapper.forwardErrors = 2;
  assert.equal(classify(undelivered, EXPECTED).outcome, "conformance-fail");

  // But NOT `closed`: a real client tears the session down by killing the server process,
  // which is the wrapper, so it never survives to see its child's streams close. Requiring it
  // failed all four honest captures — a clause that is unsatisfiable in production is as bad
  // as one that is unfailable.
  const neverClosed = passingRecord();
  neverClosed.wrapper.closed = false;
  assert.equal(classify(neverClosed, EXPECTED).outcome, "pass");

  const truncated = passingRecord();
  truncated.clientStdout.truncated = true;
  assert.equal(classify(truncated, EXPECTED).outcome, "conformance-fail");
});

test("a missing wrapper witness is invalid evidence, not a silently unjudged channel", () => {
  for (const mutate of [(r) => delete r.wrapper, (r) => delete r.wrapper.spawned, (r) => (r.wrapper.forwardErrors = "0")]) {
    const r = passingRecord();
    mutate(r);
    assert.throws(() => classify(r, EXPECTED), InvalidRecordError);
  }
});

test("the prompt actually passed is checked, not only the template it came from", () => {
  // Hashing the uninstantiated template left prompt construction free to mutate — a changed
  // argv still matched the recorded hash and still classified as a pass.
  const r = passingRecord();
  r.promptInstanceSha256 = "9".repeat(64);
  const c = classify(r, EXPECTED);
  assert.equal(c.outcome, "conformance-fail");
  assert.ok(c.reasons.some((x) => x.includes("actually passed to the client")), c.reasons.join("; "));

  // A verifier that does not supply the instantiated hash does not silently fail every record.
  const { promptInstanceSha256, ...withoutIt } = EXPECTED;
  assert.equal(classify(passingRecord(), withoutIt).outcome, "pass");
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
    clientVersion: "2.1.220 (Claude Code)",
    promptSha256: EXPECTED.promptSha256,
    promptInstanceSha256: EXPECTED.promptInstanceSha256,
    nonce: EXPECTED.nonce,
    executablePath: cat("/Users", "/jdoe/.local/bin/claude"),
    executableIdentity: "sha256:" + "b".repeat(64),
    commandLine: ["-p", "fixed prompt", "--strict-mcp-config", "--mcp-config", cat("/Users", "/jdoe/tmp/mcp.json")],
    env: { PATH: cat("/Users", "/jdoe/bin:/usr/bin"), SPENDBAR_RESOLVE_LOG: "/tmp/r.ndjson" },
    cwd: cat("/Users", "/jdoe/scratch"),
    captureInputs: capturePins(),
    spawn: { client: { ok: true }, server: { ok: true } },
    environmental: null,
    isolation: { hostileConfigExecuted: false, userConfigIsolated: true },
    timedOut: false,
    lastPhase: "called",
    clientExit: { code: 0, signal: null },
    serverTermination: { signal: null },
    wrapper: { spawned: true, closed: true, forwardErrors: 0 },
    frames: [{ type: "response", method: "initialize", protocolVersion: "2025-06-18" }],
    clientToServer: stats({ bytes: 512 }),
    serverStdout: stats(),
    serverStderr: { hasReadyLine: true, containsFrames: false },
    clientStdout: {
      hasCompletionMarker: true,
      containsNonce: false,
      containsAllowlistedEnvValue: false,
      truncated: false,
    },
    digests: {
      clientToServerSha256: "c".repeat(64),
      serverStdoutSha256: "d".repeat(64),
      serverStderrSha256: "e".repeat(64),
      clientStdoutSha256: "0".repeat(64),
      clientStderrSha256: "1".repeat(64),
      derivationDigest: "f".repeat(64),
    },
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
  assert.deepEqual(s.clientToServer, raw.clientToServer);
  assert.deepEqual(checkPreservation(raw, s), []);
});

test("a raw field with no declared transformation is a hard error, not a pass-through", () => {
  const raw = rawManifest();
  raw.surpriseField = "captured later by someone helpful";
  assert.throws(() => sanitize(raw), SanitizeError);
});

test("a DECLARED field that is absent is equally a hard error", () => {
  // The other half of the same hole: iterating only the fields that happened to be present
  // meant a manifest missing `isolation` sanitized cleanly and simply carried no witness.
  for (const field of Object.keys(SCHEMA)) {
    const raw = rawManifest();
    delete raw[field];
    assert.throws(() => sanitize(raw), SanitizeError, `absent '${field}' was accepted`);
  }
});

test("every declared transformation is from the allowlist", () => {
  for (const t of Object.values(FIELD_MAP)) assert.ok(TRANSFORM_NAMES.includes(t), t);
  assert.ok(!TRANSFORM_NAMES.includes("copy"), "an unrestricted pass-through transformation exists again");
});

test("an attached flag value that is a path is placeholdered, and the flag NAME survives", () => {
  // `--name=<path>` used to short-circuit on `startsWith("-")` and ship the path verbatim.
  const raw = rawManifest();
  raw.commandLine = ["--settings=" + cat("/Users", "/jdoe/settings.json"), "--verbose=true"];
  const s = sanitize(raw);
  assert.equal(s.commandLine[0], "--settings=<arg0:path>");
  assert.equal(s.commandLine[1], "--verbose=true", "a path-free attached value is evidence and must survive");
  assert.deepEqual(checkPreservation(raw, s), []);
  assert.ok(!JSON.stringify(s).includes("jdoe"));
});

test("a spawn failure message is reduced to its errno — the path inside it never ships", () => {
  const raw = rawManifest();
  raw.spawn.client = { ok: false, error: cat("Error: spawn /Users", "/jdoe/.local/bin/claude ENOENT") };
  const s = sanitize(raw);
  assert.deepEqual(s.spawn.client, { ok: false, errorCode: "ENOENT" });
  assert.ok(!JSON.stringify(s).includes("jdoe"));
});

test("personal data nested inside a schema-allowed field is refused by the privacy backstop", () => {
  // The schemas are an allowlist of SHAPES. This is the allowlist of MEANINGS: a home path
  // that arrives inside a field whose shape is perfectly legal still cannot be committed.
  const raw = rawManifest();
  raw.frames = [
    { type: "response", method: "tools/call", structuredNonce: EXPECTED.nonce, text: cat("/Users", "/jdoe/x"), isError: false },
  ];
  assert.throws(
    () => sanitize(raw),
    (e) => {
      assert.ok(e instanceof SanitizeError);
      assert.match(e.message, /macos-home/);
      assert.ok(!e.message.includes("jdoe"), "the refusal quoted the value it was refusing");
      return true;
    },
  );
});

test("the sanitized manifest shares no structure with the raw one", () => {
  const raw = rawManifest();
  const s = sanitize(raw);
  raw.frames[0].protocolVersion = "mutated-after-the-fact";
  raw.serverStdout.bytes = 999_999;
  raw.spawn.client.ok = false;
  assert.equal(s.frames[0].protocolVersion, "2025-06-18");
  assert.equal(s.serverStdout.bytes, 2048);
  assert.equal(s.spawn.client.ok, true);
});

test("the stream-statistics key set is shared with the classifier's required counters", () => {
  for (const key of ["bytes", "remainder", "encodingErrors", "parseErrors", "protocolErrors"]) {
    assert.ok(STREAM_STAT_KEYS.includes(key), `${key} must be recorded for the classifier to judge it`);
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

test("mutation: a rewritten stream counter or spawn outcome is rejected", () => {
  const raw = rawManifest();
  const s = sanitize(raw);
  s.clientToServer = stats({ bytes: 512, protocolErrors: 0, parseErrors: 0 });
  raw.clientToServer.protocolErrors = 4; // the raw run carried unaccounted-for messages
  const v = checkPreservation(raw, s);
  assert.ok(v.some((x) => x.includes("clientToServer")), v.join("; "));
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

test("a bare binary name in a path field is not mistaken for a leak of itself", () => {
  // Real captures record `executablePath: "claude"` — resolved through PATH, not a path. A
  // plain substring test flagged that as leaked because "claude" occurs inside "claude-code",
  // failing every honest capture. Only path-shaped raw values are searched for.
  const raw = rawManifest();
  raw.executablePath = "claude";
  const s = sanitize(raw);
  assert.equal(s.executablePath, "<path:executablePath>");
  assert.deepEqual(checkPreservation(raw, s), []);

  // The protection it exists for is intact: a real path that survived is still a violation.
  const leaked = sanitize(rawManifest());
  leaked.frames = [{ type: "response", method: "unknown", note: rawManifest().cwd }];
  assert.ok(checkPreservation(rawManifest(), leaked).some((v) => v.includes("survived")));
});

test("the declared placeholders are the ONLY substitutions the checker will accept", () => {
  const raw = rawManifest();
  const s = sanitize(raw);
  s.cwd = "<path:somewhere-else>";
  assert.ok(checkPreservation(raw, s).some((v) => v.includes("cwd")));
  assert.equal(PLACEHOLDER.path("cwd"), "<path:cwd>");
});

test("the client environment is an allowlist, and the manifest records what was passed", () => {
  // The critical chunk-10 finding: the client was spawned with no `env` option at all, so it
  // inherited every credential in the shell while the manifest recorded `{ PATH }`.
  const hostile = {
    PATH: "/usr/bin",
    HOME: cat("/Users", "/jdoe"),
    AWS_SECRET_ACCESS_KEY: "should-never-be-passed",
    NPM_TOKEN: "should-never-be-passed",
    GITHUB_TOKEN: "should-never-be-passed",
  };
  const env = buildClientEnv(hostile);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
  for (const name of Object.keys(env)) assert.ok(CLIENT_ENV_ALLOWLIST.includes(name), name);

  // HOME is on the list deliberately — it is the credential channel both clients authenticate
  // through — so the allowlist must not be mistaken for "no credentials reach the client".
  assert.ok(CLIENT_ENV_ALLOWLIST.includes("HOME"));

  // And what the manifest records is that same object, names only.
  const raw = { ...rawManifest(), env };
  assert.deepEqual(sanitize(raw).env, ["HOME", "PATH"]);
  assert.deepEqual(checkPreservation(raw, sanitize(raw)), []);
});

test("the capture-input pin is exactly the declared set — no additions, no omissions", () => {
  const short = rawManifest();
  delete short.captureInputs[CAPTURE_INPUTS[0]];
  assert.throws(() => sanitize(short), SanitizeError);

  const padded = rawManifest();
  padded.captureInputs["scripts/something-else.mjs"] = "a".repeat(64);
  assert.throws(() => sanitize(padded), SanitizeError);
});

test("the T-024 scanner catches a real-shaped path planted in a committed-manifest fixture", () => {
  // The §8 leak direction: if a buggy sanitizer ever let a real home path through to the
  // committed manifest, the scanner that gates every commit must reject it.
  const planted = JSON.stringify({ ...sanitize(rawManifest()), oops: cat("/Users", "/jdoe/Developer/x") });
  const findings = scanText(planted, "fixture-manifest.json");
  assert.ok(findings.length > 0, "scanner missed a real-shaped path in the manifest fixture");
  assert.ok(findings.every((f) => !JSON.stringify(f).includes("jdoe")), "a finding carried the value");
});
