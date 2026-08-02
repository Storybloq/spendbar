// Tests for the review receipt (plan §6b), added in review round 1 chunk 10.
//
// The receipt is a permission to DELETE the only raw evidence a paid capture will ever
// produce, and it was the least-tested thing in the pipeline. The three properties these
// tests exist to hold down:
//
//   * it re-derives rather than trusts — a self-consistent crafted capture directory must not
//     earn a receipt just because the three digests it asserts about itself agree;
//   * it fails CLOSED — an incomplete, mistyped, symlinked or extra-file entry is a refusal
//     for the whole batch, never a skip that leaves the rest looking successful;
//   * it publishes BEFORE it deletes, and what it publishes it reads back.
//
// Runs under `node --test` or directly (`node spikes/mcp/real-client/receipt.test.mjs`).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCapture, verifyCapture, writeDurable, referencedCaptureIds, RECEIPT_SCHEMA_VERSION } from "./receipt.mjs";
import { normalize } from "./normalize.mjs";
import { sanitize } from "./sanitize.mjs";
import { captureInputDigests } from "./provenance.mjs";
import { PROMPT_TEMPLATE, PROMPT_TEMPLATE_SHA256, COMPLETION_MARKER } from "./capture.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const NONCE = "t009-0011223344556677";
const CAPTURE_ID = "claude-code-v2-deadbeef";

const req = (id, method) => JSON.stringify({ jsonrpc: "2.0", id, method });
const res = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });

/** The four streams of a healthy run, as the wrapper would have teed them. */
function streams() {
  return {
    "client-to-server.raw": Buffer.from([req(1, "initialize"), req(2, "tools/list"), req(3, "tools/call")].join("\n") + "\n"),
    "server-stdout.raw": Buffer.from(
      [
        res(1, { protocolVersion: "2025-06-18" }),
        res(2, { tools: [{ name: "spendbar_probe" }] }),
        res(3, { structuredContent: { nonce: NONCE }, content: [{ type: "text", text: `probe ${NONCE}` }], isError: false }),
      ].join("\n") + "\n",
    ),
    "server-stderr.raw": Buffer.from("spendbar-probe-server ready\n"),
    "client-stdout.raw": Buffer.from(`${COMPLETION_MARKER}\n`),
    "client-stderr.raw": Buffer.from(""),
  };
}

/** A raw manifest that genuinely describes those streams. */
function rawFor(streamBytes) {
  const derived = normalize(streamBytes["client-to-server.raw"], streamBytes["server-stdout.raw"]);
  const prompt = PROMPT_TEMPLATE.replace("{{NONCE}}", NONCE);
  return {
    captureId: CAPTURE_ID,
    client: "claude-code",
    candidate: "v2",
    clientVersion: "2.1.220 (Claude Code)",
    promptSha256: PROMPT_TEMPLATE_SHA256,
    promptInstanceSha256: sha256(Buffer.from(prompt, "utf8")),
    nonce: NONCE,
    executablePath: "claude",
    executableIdentity: `sha256:${"b".repeat(64)}`,
    commandLine: ["-p", prompt, "--strict-mcp-config"],
    env: { PATH: "/usr/bin", HOME: "/tmp/home-fixture" },
    cwd: "/tmp/scratch-fixture",
    captureInputs: captureInputDigests(),
    spawn: { client: { ok: true }, server: { ok: true } },
    environmental: null,
    isolation: { hostileConfigExecuted: false, userConfigIsolated: true },
    timedOut: false,
    lastPhase: "called",
    clientExit: { code: 0, signal: null },
    serverTermination: { signal: null },
    wrapper: { spawned: true, closed: false, forwardErrors: 0 },
    frames: derived.frames,
    clientToServer: derived.clientToServer,
    serverStdout: derived.serverStdout,
    serverStderr: { hasReadyLine: true, containsFrames: false },
    clientStdout: { hasCompletionMarker: true, containsNonce: false, containsAllowlistedEnvValue: false, truncated: false },
    digests: {
      clientToServerSha256: sha256(streamBytes["client-to-server.raw"]),
      serverStdoutSha256: sha256(streamBytes["server-stdout.raw"]),
      serverStderrSha256: sha256(streamBytes["server-stderr.raw"]),
      clientStdoutSha256: sha256(streamBytes["client-stdout.raw"]),
      clientStderrSha256: sha256(streamBytes["client-stderr.raw"]),
      derivationDigest: derived.derivationDigest,
    },
    retries: [],
  };
}

/**
 * A complete fixture: a retained capture directory plus the evidence directory whose committed
 * manifest and cells record exactly that capture. `mutate` breaks one thing.
 */
function withFixture(fn, { mutateRaw = () => {}, mutateStreams = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "receipt-fixture-"));
  try {
    const retainedDir = join(root, "retained");
    const evidenceDir = join(root, "evidence");
    mkdirSync(retainedDir, { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });

    const streamBytes = streams();
    mutateStreams(streamBytes);
    const raw = rawFor(streamBytes);
    mutateRaw(raw);

    const dir = join(retainedDir, CAPTURE_ID);
    mkdirSync(dir);
    chmodSync(dir, 0o700);
    const write = (name, content) => {
      writeFileSync(join(dir, name), content);
      chmodSync(join(dir, name), 0o600);
    };
    for (const [name, bytes] of Object.entries(streamBytes)) write(name, bytes);
    write("raw-manifest.json", JSON.stringify(raw, null, 2));
    write("wrapper-status.json", JSON.stringify({ spawned: true, closed: false, forwardErrors: 0 }) + "\n");

    // The committed side: exactly what sanitizing and classifying this capture produces.
    writeFileSync(
      join(evidenceDir, "claude-code-v2.manifest.json"),
      JSON.stringify(sanitize(raw), null, 2) + "\n",
    );
    writeFileSync(
      join(evidenceDir, "cells.json"),
      JSON.stringify(
        { v2: { "claude-code": { status: "pass", attempts: [{ captureId: CAPTURE_ID, outcome: "pass" }] } } },
        null,
        2,
      ),
    );
    return fn({ root, retainedDir, evidenceDir, dir, raw });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const verify = ({ retainedDir, evidenceDir }) => {
  const opened = openCapture(CAPTURE_ID, retainedDir);
  if (opened.problems.length) return opened.problems;
  return verifyCapture(CAPTURE_ID, opened.bytes, evidenceDir);
};

// ---------- the positive control ---------------------------------------------------------------

test("a genuine capture whose committed evidence matches it verifies", () => {
  withFixture((ctx) => {
    const result = verify(ctx);
    assert.ok(!Array.isArray(result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, "pass");
  });
});

// ---------- re-derivation, not trust -----------------------------------------------------------

test("an edited stream statistic is caught even though the frames still reproduce", () => {
  // The exact gap: the receipt copied `clientToServer`/`serverStdout` across without comparing
  // them, so those counters could be edited while the frame digest stayed valid.
  withFixture(
    (ctx) => {
      const problems = verify(ctx);
      assert.ok(Array.isArray(problems));
      assert.ok(problems.some((p) => p.includes("statistics differ")), problems.join("; "));
    },
    { mutateRaw: (raw) => (raw.clientToServer.protocolErrors = 0 + 5) },
  );
});

test("a client-stdout predicate that the bytes do not support is caught", () => {
  withFixture(
    (ctx) => {
      const problems = verify(ctx);
      assert.ok(Array.isArray(problems));
      assert.ok(problems.some((p) => p.includes("completion-marker")), problems.join("; "));
    },
    { mutateStreams: (s) => (s["client-stdout.raw"] = Buffer.from("the model said something else\n")) },
  );
});

test("a prompt that is not the committed template instantiated with this nonce is caught", () => {
  withFixture(
    (ctx) => {
      const problems = verify(ctx);
      assert.ok(Array.isArray(problems));
      assert.ok(problems.some((p) => p.includes("prompt")), problems.join("; "));
    },
    { mutateRaw: (raw) => (raw.commandLine[1] = "just do whatever seems reasonable") },
  );
});

test("a manifest whose committed form differs from what sanitizing it produces is caught", () => {
  withFixture((ctx) => {
    const manifestPath = join(ctx.evidenceDir, "claude-code-v2.manifest.json");
    const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
    committed.lastPhase = "initialized"; // the committed record now claims less than the run did
    writeFileSync(manifestPath, JSON.stringify(committed, null, 2) + "\n");
    const problems = verify(ctx);
    assert.ok(Array.isArray(problems));
    assert.ok(problems.some((p) => p.includes("not what sanitizing this capture produces")), problems.join("; "));
  });
});

test("a cell status that the capture does not re-derive is caught", () => {
  withFixture((ctx) => {
    writeFileSync(
      join(ctx.evidenceDir, "cells.json"),
      JSON.stringify({ v2: { "claude-code": { status: "not-run", attempts: [{ captureId: CAPTURE_ID, outcome: "infrastructure-unavailable" }] } } }),
    );
    const problems = verify(ctx);
    assert.ok(Array.isArray(problems));
    assert.ok(problems.some((p) => p.includes("re-derives")), problems.join("; "));
  });
});

test("a capture no cell claims as an attempt cannot receive a receipt", () => {
  withFixture((ctx) => {
    writeFileSync(join(ctx.evidenceDir, "cells.json"), JSON.stringify({ v2: { "claude-code": { status: "pass", attempts: [] } } }));
    const problems = verify(ctx);
    assert.ok(Array.isArray(problems));
    assert.ok(problems.some((p) => p.includes("does not list this capture")), problems.join("; "));
  });
});

test("a duplicated key in the raw manifest is refused, not last-wins", () => {
  withFixture((ctx) => {
    const path = join(ctx.dir, "raw-manifest.json");
    const text = readFileSync(path, "utf8").replace('"lastPhase": "called"', '"lastPhase": "spawned",\n  "lastPhase": "called"');
    writeFileSync(path, text);
    const problems = verify(ctx);
    assert.ok(Array.isArray(problems));
    assert.ok(problems.some((p) => p.includes("strictly-parseable")), problems.join("; "));
  });
});

test("a capture-input changed since the run is caught before any approval", () => {
  withFixture(
    (ctx) => {
      const problems = verify(ctx);
      assert.ok(Array.isArray(problems));
      assert.ok(problems.some((p) => p.includes("changed since the run")), problems.join("; "));
    },
    { mutateRaw: (raw) => (raw.captureInputs["spikes/mcp/probe-def.mjs"] = "0".repeat(64)) },
  );
});

test("a wrapper witness that disagrees with the recorded spawn outcome is caught", () => {
  withFixture(
    (ctx) => {
      const problems = verify(ctx);
      assert.ok(Array.isArray(problems));
      assert.ok(problems.some((p) => p.includes("wrapper's witness")), problems.join("; "));
    },
    { mutateRaw: (raw) => (raw.wrapper.spawned = false) },
  );
});

// ---------- failing closed ---------------------------------------------------------------------

test("an incomplete capture directory is a refusal, never a skip", () => {
  withFixture((ctx) => {
    rmSync(join(ctx.dir, "client-stderr.raw"));
    const problems = openCapture(CAPTURE_ID, ctx.retainedDir).problems;
    assert.ok(problems.some((p) => p.includes("missing required file")), problems.join("; "));
  });
});

test("an unexpected extra file in a capture directory is a refusal", () => {
  withFixture((ctx) => {
    writeFileSync(join(ctx.dir, "notes.txt"), "hello");
    chmodSync(join(ctx.dir, "notes.txt"), 0o600);
    const problems = openCapture(CAPTURE_ID, ctx.retainedDir).problems;
    assert.ok(problems.some((p) => p.includes("unexpected file")), problems.join("; "));
  });
});

test("a symlinked stream is refused rather than followed", () => {
  withFixture((ctx) => {
    const target = join(ctx.root, "elsewhere.raw");
    writeFileSync(target, "bytes from somewhere else");
    rmSync(join(ctx.dir, "server-stdout.raw"));
    symlinkSync(target, join(ctx.dir, "server-stdout.raw"));
    const problems = openCapture(CAPTURE_ID, ctx.retainedDir).problems;
    assert.ok(problems.some((p) => p.includes("not a regular file")), problems.join("; "));
  });
});

test("a world-readable capture directory is refused", () => {
  withFixture((ctx) => {
    chmodSync(ctx.dir, 0o755);
    const problems = openCapture(CAPTURE_ID, ctx.retainedDir).problems;
    assert.ok(problems.some((p) => p.includes("mode is not 0700")), problems.join("; "));
  });
});

test("a raw manifest naming a different capture is refused", () => {
  withFixture(
    (ctx) => {
      const problems = verify(ctx);
      assert.ok(Array.isArray(problems));
      assert.ok(problems.some((p) => p.includes("names a different capture")), problems.join("; "));
    },
    { mutateRaw: (raw) => (raw.captureId = "codex-v1-00000000") },
  );
});

// ---------- publishing ---------------------------------------------------------------------------

test("a durable write is read back, and the temporary file does not survive", () => {
  const root = mkdtempSync(join(tmpdir(), "receipt-write-"));
  try {
    const path = join(root, "receipt.json");
    writeDurable(path, [{ captureId: "a", schemaVersion: RECEIPT_SCHEMA_VERSION }]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), [{ captureId: "a", schemaVersion: RECEIPT_SCHEMA_VERSION }]);
    assert.equal(readFileSync(path, "utf8").endsWith("\n"), true);
    assert.throws(() => readFileSync(`${path}.writing`, "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the merge scope is exactly what the current cells claim", () => {
  // Preserving other cells' receipts is the point; preserving a superseded GENERATION is not,
  // because those entries describe captures no cell refers to and would make the committed
  // receipt describe two different runs at once.
  const cells = {
    v1: { "claude-code": { attempts: [{ captureId: "a" }] }, codex: { attempts: [{ captureId: "b" }, { captureId: "c" }] } },
    v2: { "claude-code": { status: "not-run", cause: "binary-missing" } }, // preflight: no attempts
  };
  assert.deepEqual([...referencedCaptureIds(cells)].sort(), ["a", "b", "c"]);
  assert.deepEqual([...referencedCaptureIds({})], []);
  assert.deepEqual([...referencedCaptureIds(undefined)], []);
});
