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
// Two things review round 1 chunk 13 found missing, and what was done about them:
//
//   * EVERY mutation happened before the manifest was built, so the fixture always described
//     its own streams and the five raw-stream digest comparisons could have been deleted
//     without a test noticing. `mutateAfter` now corrupts the retained bytes AFTER the whole
//     fixture — manifest, committed manifest, cells — is finished, which is the only order in
//     which those comparisons are load-bearing.
//   * The transaction itself was untested: `writeDurable` was exercised alone, which says
//     nothing about whether deletion follows publication. `publishReceipts` is now called
//     directly, including with a publication that fails halfway.
//
// Runs under `node --test` or directly (`node spikes/mcp/real-client/receipt.test.mjs`).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openCapture,
  verifyCapture,
  publishReceipts,
  writeDurable,
  referencedCaptureIds,
  RECEIPT_SCHEMA_VERSION,
  RECEIPT_NOTE,
} from "./receipt.mjs";
import { candidateTreeDigest } from "../isolate.mjs";
import { normalize } from "./normalize.mjs";
import { sanitize } from "./sanitize.mjs";
import { captureInputDigests } from "./provenance.mjs";
import { PROMPT_TEMPLATE, PROMPT_TEMPLATE_SHA256, COMPLETION_MARKER, OWNER_MARKER } from "./capture.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const NONCE = "t009-0011223344556677";
const CAPTURE_ID = "claude-code-v2-deadbeef";
const OTHER_ID = "codex-v1-feedface";
const STREAM_FILES = [
  "client-to-server.raw",
  "server-stdout.raw",
  "server-stderr.raw",
  "client-stdout.raw",
  "client-stderr.raw",
];

// Digested once: the real installed trees, re-walked per test, would cost more than the tests.
const TREE = { v1: candidateTreeDigest("v1"), v2: candidateTreeDigest("v2") };

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
function rawFor(streamBytes, { id = CAPTURE_ID, client = "claude-code", candidate = "v2" } = {}) {
  const derived = normalize(streamBytes["client-to-server.raw"], streamBytes["server-stdout.raw"]);
  const prompt = PROMPT_TEMPLATE.replace("{{NONCE}}", NONCE);
  return {
    captureId: id,
    client,
    candidate,
    clientVersion: "2.1.220 (Claude Code)",
    promptSha256: PROMPT_TEMPLATE_SHA256,
    promptInstanceSha256: sha256(Buffer.from(prompt, "utf8")),
    nonce: NONCE,
    executablePath: client === "codex" ? "codex" : "claude",
    executableIdentity: `sha256:${"b".repeat(64)}`,
    commandLine: ["-p", prompt, "--strict-mcp-config"],
    env: { PATH: "/usr/bin", HOME: "/tmp/home-fixture" },
    cwd: "/tmp/scratch-fixture",
    captureInputs: captureInputDigests(),
    candidateTreeSha256: TREE[candidate],
    spawn: { client: { ok: true }, server: { ok: true } },
    environmental: null,
    isolation: { hostileConfigExecuted: false, userConfigIsolated: client === "claude-code" },
    timedOut: false,
    drainTimedOut: false,
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

/** Write one retained capture directory, exactly as the capture command leaves it. */
function writeCapture(retainedDir, raw, streamBytes) {
  const dir = join(retainedDir, raw.captureId);
  mkdirSync(dir);
  chmodSync(dir, 0o700);
  const write = (name, content) => {
    writeFileSync(join(dir, name), content);
    chmodSync(join(dir, name), 0o600);
  };
  for (const [name, bytes] of Object.entries(streamBytes)) write(name, bytes);
  // The ownership marker the capture command writes first, so the abandonment sweep can prove
  // a directory under the operator's home is one of ours before deleting it recursively.
  write(OWNER_MARKER, `${raw.captureId}\n`);
  write("raw-manifest.json", JSON.stringify(raw, null, 2));
  write("wrapper-status.json", JSON.stringify({ spawned: true, closed: false, forwardErrors: 0 }) + "\n");
  return dir;
}

/** The committed side: exactly what sanitizing and classifying these captures produces. */
function writeEvidence(evidenceDir, captures) {
  const cells = {};
  for (const raw of captures) {
    cells[raw.candidate] = cells[raw.candidate] ?? {};
    cells[raw.candidate][raw.client] = { status: "pass", attempts: [{ captureId: raw.captureId, outcome: "pass" }] };
    writeFileSync(
      join(evidenceDir, `${raw.client}-${raw.candidate}.manifest.json`),
      JSON.stringify(sanitize(raw), null, 2) + "\n",
    );
  }
  writeFileSync(join(evidenceDir, "cells.json"), JSON.stringify(cells, null, 2) + "\n");
  return cells;
}

/**
 * A complete fixture: a retained capture directory plus the evidence directory whose committed
 * manifest and cells record exactly that capture.
 *
 * `mutateRaw` and `mutateStreams` break something the manifest is then BUILT FROM — they model
 * a crafted capture, and everything downstream stays self-consistent with the change. Only
 * `mutateAfter` breaks the retained bytes once the whole record is written, which is what a
 * digest comparison is for and the only hook that can falsify one.
 */
function withFixture(fn, { mutateRaw = () => {}, mutateStreams = () => {}, mutateAfter = () => {} } = {}) {
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

    const dir = writeCapture(retainedDir, raw, streamBytes);
    writeEvidence(evidenceDir, [raw]);

    const ctx = { root, retainedDir, evidenceDir, dir, raw };
    mutateAfter(ctx);
    return fn(ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const verify = ({ retainedDir, evidenceDir }, id = CAPTURE_ID) => {
  const opened = openCapture(id, retainedDir);
  if (opened.problems.length) return opened.problems;
  return verifyCapture(id, opened.bytes, evidenceDir);
};

/** Assert a refusal mentioning `needle`, with the actual problems in the failure message. */
const refuses = (problems, needle) => {
  assert.ok(Array.isArray(problems), `expected a refusal, got success: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes(needle)), `no problem mentioned '${needle}': ${problems.join("; ")}`);
};

// ---------- the positive control ---------------------------------------------------------------

test("a genuine capture whose committed evidence matches it verifies", () => {
  withFixture((ctx) => {
    const result = verify(ctx);
    assert.ok(!Array.isArray(result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, "pass");
  });
});

// ---------- the retained bytes, altered after the record was written ----------------------------
//
// These make the five stream-digest comparisons falsifiable. Each alters one retained stream
// and nothing else: the raw manifest, the committed manifest and the cell all still describe
// the run as it happened, so re-digesting the bytes is the only thing that can catch it.

for (const file of STREAM_FILES) {
  test(`${file}, altered after the capture was recorded, fails its digest`, () => {
    withFixture((ctx) => refuses(verify(ctx), `${file} does not match its recorded digest`), {
      mutateAfter: (ctx) => appendFileSync(join(ctx.dir, file), "\n"),
    });
  });
}

test("altered protocol bytes also fail to reproduce the recorded derivation", () => {
  // Separate from the digest: someone who recomputed the stream digest would still have to
  // reproduce the trace, and this pins that the trace comes from the bytes on disk.
  withFixture(
    (ctx) => {
      const problems = verify(ctx);
      refuses(problems, "does not reproduce the recorded trace");
      refuses(problems, "reproduced frames differ");
    },
    {
      mutateAfter: (ctx) => {
        const path = join(ctx.dir, "server-stdout.raw");
        const bytes = Buffer.concat([readFileSync(path), Buffer.from(res(9, { tools: [] }) + "\n")]);
        writeFileSync(path, bytes);
        // Keep the recorded digest honest about the new bytes, so only the derivation objects.
        const manifestPath = join(ctx.dir, "raw-manifest.json");
        const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
        raw.digests.serverStdoutSha256 = sha256(bytes);
        writeFileSync(manifestPath, JSON.stringify(raw, null, 2));
      },
    },
  );
});

// ---------- re-derivation, not trust -----------------------------------------------------------

test("an edited stream statistic is caught even though the frames still reproduce", () => {
  // The exact gap: the receipt copied `clientToServer`/`serverStdout` across without comparing
  // them, so those counters could be edited while the frame digest stayed valid.
  withFixture((ctx) => refuses(verify(ctx), "statistics differ"), {
    mutateRaw: (raw) => (raw.clientToServer.protocolErrors = 5),
  });
});

test("an edited derivation digest is caught with the bytes and frames left alone", () => {
  withFixture((ctx) => refuses(verify(ctx), "does not reproduce the recorded trace"), {
    mutateRaw: (raw) => (raw.digests.derivationDigest = "0".repeat(64)),
  });
});

test("a frame the streams do not contain is caught", () => {
  withFixture((ctx) => refuses(verify(ctx), "reproduced frames differ"), {
    mutateRaw: (raw) =>
      raw.frames.push({ type: "response", method: "tools/call", structuredNonce: NONCE, text: "", isError: false }),
  });
});

test("a client-stdout predicate that the bytes do not support is caught", () => {
  withFixture((ctx) => refuses(verify(ctx), "completion-marker"), {
    mutateStreams: (s) => (s["client-stdout.raw"] = Buffer.from("the model said something else\n")),
  });
});

test("a prompt that is not the committed template instantiated with this nonce is caught", () => {
  withFixture((ctx) => refuses(verify(ctx), "prompt"), {
    mutateRaw: (raw) => (raw.commandLine[1] = "just do whatever seems reasonable"),
  });
});

test("a manifest whose committed form differs from what sanitizing it produces is caught", () => {
  withFixture((ctx) => {
    const manifestPath = join(ctx.evidenceDir, "claude-code-v2.manifest.json");
    const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
    committed.lastPhase = "initialized"; // the committed record now claims less than the run did
    writeFileSync(manifestPath, JSON.stringify(committed, null, 2) + "\n");
    refuses(verify(ctx), "not what sanitizing this capture produces");
  });
});

test("a cell status that the capture does not re-derive is caught", () => {
  withFixture((ctx) => {
    writeFileSync(
      join(ctx.evidenceDir, "cells.json"),
      JSON.stringify({
        v2: { "claude-code": { status: "not-run", attempts: [{ captureId: CAPTURE_ID, outcome: "infrastructure-unavailable" }] } },
      }),
    );
    refuses(verify(ctx), "re-derives");
  });
});

test("a capture no cell claims as an attempt cannot receive a receipt", () => {
  withFixture((ctx) => {
    writeFileSync(join(ctx.evidenceDir, "cells.json"), JSON.stringify({ v2: { "claude-code": { status: "pass", attempts: [] } } }));
    refuses(verify(ctx), "does not list this capture");
  });
});

test("a duplicated key in the raw manifest is refused, not last-wins", () => {
  withFixture((ctx) => {
    const path = join(ctx.dir, "raw-manifest.json");
    const text = readFileSync(path, "utf8").replace('"lastPhase": "called"', '"lastPhase": "spawned",\n  "lastPhase": "called"');
    writeFileSync(path, text);
    refuses(verify(ctx), "strictly-parseable");
  });
});

test("a capture-input changed since the run is caught before any approval", () => {
  withFixture((ctx) => refuses(verify(ctx), "changed since the run"), {
    mutateRaw: (raw) => (raw.captureInputs["spikes/mcp/probe-def.mjs"] = "0".repeat(64)),
  });
});

test("a dependency tree other than the installed one is caught", () => {
  // Every lockfile digest still agrees here; what differs is the bytes that actually ran.
  withFixture((ctx) => refuses(verify(ctx), "dependency tree changed since the run"), {
    mutateRaw: (raw) => (raw.candidateTreeSha256 = "0".repeat(64)),
  });
});

test("a wrapper witness that disagrees with the recorded spawn outcome is caught", () => {
  withFixture((ctx) => refuses(verify(ctx), "wrapper's witness"), {
    mutateRaw: (raw) => (raw.wrapper.spawned = false),
  });
});

// ---------- failing closed ---------------------------------------------------------------------

test("an incomplete capture directory is a refusal, never a skip", () => {
  withFixture((ctx) => {
    rmSync(join(ctx.dir, "client-stderr.raw"));
    refuses(openCapture(CAPTURE_ID, ctx.retainedDir).problems, "missing required file");
  });
});

test("an unexpected extra file in a capture directory is a refusal", () => {
  withFixture((ctx) => {
    writeFileSync(join(ctx.dir, "notes.txt"), "hello");
    chmodSync(join(ctx.dir, "notes.txt"), 0o600);
    refuses(openCapture(CAPTURE_ID, ctx.retainedDir).problems, "unexpected file");
  });
});

test("a symlinked stream is refused rather than followed", () => {
  withFixture((ctx) => {
    const target = join(ctx.root, "elsewhere.raw");
    writeFileSync(target, "bytes from somewhere else");
    rmSync(join(ctx.dir, "server-stdout.raw"));
    symlinkSync(target, join(ctx.dir, "server-stdout.raw"));
    refuses(openCapture(CAPTURE_ID, ctx.retainedDir).problems, "not a regular file");
  });
});

test("a symlinked capture DIRECTORY is refused as a symlink, not mislabelled", () => {
  withFixture((ctx) => {
    const elsewhere = join(ctx.root, "elsewhere");
    mkdirSync(elsewhere);
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, join(ctx.retainedDir, "claude-code-v2-00000000"));
    refuses(openCapture("claude-code-v2-00000000", ctx.retainedDir).problems, "is a symlink");
  });
});

test("a retained entry that is a plain file is refused", () => {
  withFixture((ctx) => {
    writeFileSync(join(ctx.retainedDir, "claude-code-v2-11111111"), "not a capture");
    refuses(openCapture("claude-code-v2-11111111", ctx.retainedDir).problems, "is not a directory");
  });
});

test("a world-readable capture directory is refused", () => {
  withFixture((ctx) => {
    chmodSync(ctx.dir, 0o755);
    refuses(openCapture(CAPTURE_ID, ctx.retainedDir).problems, "mode is not 0700");
  });
});

test("a group-readable stream file is refused", () => {
  withFixture((ctx) => {
    chmodSync(join(ctx.dir, "server-stdout.raw"), 0o644);
    refuses(openCapture(CAPTURE_ID, ctx.retainedDir).problems, "'server-stdout.raw' mode is not 0600");
  });
});

test("a capture owned by another user is refused", () => {
  // The expected uid is a parameter precisely so this is falsifiable without root: the directory
  // really is owned by this process, and a different expected owner really does refuse it.
  withFixture((ctx) => {
    refuses(openCapture(CAPTURE_ID, ctx.retainedDir, { uid: process.getuid() + 1 }).problems, "not owned by the current user");
    assert.equal(openCapture(CAPTURE_ID, ctx.retainedDir).problems.length, 0);
  });
});

test("a raw manifest naming a different capture is refused", () => {
  // Written after the directory exists, so the directory really is one capture and the manifest
  // inside it really claims to be another — the mismatch, not merely a renamed fixture.
  withFixture((ctx) => refuses(verify(ctx), "names a different capture"), {
    mutateAfter: (ctx) => {
      const path = join(ctx.dir, "raw-manifest.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.captureId = "codex-v1-00000000";
      writeFileSync(path, JSON.stringify(raw, null, 2));
    },
  });
});

// ---------- the transaction: verify all, publish, only then delete ------------------------------

/** Two complete captures in two different cells, plus the evidence that records both. */
function withBatch(fn, { mutateAfter = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "receipt-batch-"));
  try {
    const retainedDir = join(root, "retained");
    const evidenceDir = join(root, "evidence");
    mkdirSync(retainedDir, { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });

    const first = streams();
    const second = streams();
    const rawA = rawFor(first, { id: CAPTURE_ID, client: "claude-code", candidate: "v2" });
    const rawB = rawFor(second, { id: OTHER_ID, client: "codex", candidate: "v1" });
    const dirA = writeCapture(retainedDir, rawA, first);
    const dirB = writeCapture(retainedDir, rawB, second);
    writeEvidence(evidenceDir, [rawA, rawB]);

    const ctx = { root, retainedDir, evidenceDir, dirA, dirB, rawA, rawB };
    mutateAfter(ctx);
    return fn(ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a clean batch publishes both records and then deletes exactly the verified captures", () => {
  withBatch((ctx) => {
    const result = publishReceipts({ retainedDir: ctx.retainedDir, evidenceDir: ctx.evidenceDir });
    assert.equal(result.code, 0, result.messages.join("; "));
    assert.deepEqual([...result.deleted].sort(), [CAPTURE_ID, OTHER_ID].sort());
    assert.equal(existsSync(ctx.dirA), false);
    assert.equal(existsSync(ctx.dirB), false);

    const receipt = JSON.parse(readFileSync(join(ctx.evidenceDir, "receipt.json"), "utf8"));
    assert.deepEqual(receipt.map((e) => e.captureId).sort(), [CAPTURE_ID, OTHER_ID].sort());
    for (const entry of receipt) {
      assert.equal(entry.schemaVersion, RECEIPT_SCHEMA_VERSION);
      assert.equal(entry.candidateTreeSha256, TREE[entry.candidate]);
    }
    const pin = JSON.parse(readFileSync(join(ctx.evidenceDir, "capture-inputs.json"), "utf8"));
    assert.deepEqual(pin.files, captureInputDigests());
  });
});

test("one unverifiable capture keeps the WHOLE batch: nothing written, nothing deleted", () => {
  withBatch(
    (ctx) => {
      const result = publishReceipts({ retainedDir: ctx.retainedDir, evidenceDir: ctx.evidenceDir });
      assert.equal(result.code, 1);
      assert.deepEqual(result.deleted, []);
      // The good capture is kept too. A batch that deleted what it could would destroy the
      // bytes in exactly the situation where they are the only way to settle the question.
      assert.equal(existsSync(ctx.dirA), true);
      assert.equal(existsSync(ctx.dirB), true);
      assert.equal(existsSync(join(ctx.evidenceDir, "receipt.json")), false);
      assert.equal(existsSync(join(ctx.evidenceDir, "capture-inputs.json")), false);
      assert.ok(result.messages.some((m) => m.includes("nothing written and nothing deleted")), result.messages.join("; "));
    },
    { mutateAfter: (ctx) => appendFileSync(join(ctx.dirB, "server-stdout.raw"), "tampered\n") },
  );
});

test("a publication that fails on the second record deletes nothing", () => {
  withBatch((ctx) => {
    const attempted = [];
    const result = publishReceipts({
      retainedDir: ctx.retainedDir,
      evidenceDir: ctx.evidenceDir,
      write: (path, value) => {
        attempted.push(path);
        if (path.endsWith("capture-inputs.json")) throw new Error("disk full");
        writeDurable(path, value);
      },
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.deleted, []);
    assert.equal(attempted.length, 2, "the second record must have been attempted");
    // receipt.json exists — and that is exactly why deletion must not have happened: a
    // half-published pair is not a permission to destroy anything.
    assert.equal(existsSync(join(ctx.evidenceDir, "receipt.json")), true);
    assert.equal(existsSync(ctx.dirA), true);
    assert.equal(existsSync(ctx.dirB), true);
    assert.ok(result.messages.some((m) => m.includes("every raw capture is kept")), result.messages.join("; "));
  });
});

test("a publication whose receipt never reaches disk deletes nothing", () => {
  withBatch((ctx) => {
    const result = publishReceipts({
      retainedDir: ctx.retainedDir,
      evidenceDir: ctx.evidenceDir,
      write: () => {}, // returns as if it had succeeded, writes nothing
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.deleted, []);
    assert.equal(existsSync(ctx.dirA), true);
    assert.equal(existsSync(ctx.dirB), true);
  });
});

test("an existing receipt is merged when its capture is still claimed, and dropped when it is not", () => {
  withBatch((ctx) => {
    const carried = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      captureId: "claude-code-v1-01010101",
      client: "claude-code",
      candidate: "v1",
      outcome: "pass",
      reproduced: {},
      rawStatistics: {},
      captureInputs: captureInputDigests(),
      candidateTreeSha256: TREE.v1,
    };
    const superseded = { ...carried, captureId: "claude-code-v1-02020202" };
    writeDurable(join(ctx.evidenceDir, "receipt.json"), [carried, superseded]);

    // The carried entry's capture is claimed by a cell whose raw bytes are already gone; the
    // superseded one is claimed by nobody.
    const cells = JSON.parse(readFileSync(join(ctx.evidenceDir, "cells.json"), "utf8"));
    cells.v1["claude-code"] = { status: "pass", attempts: [{ captureId: carried.captureId, outcome: "pass" }] };
    writeFileSync(join(ctx.evidenceDir, "cells.json"), JSON.stringify(cells, null, 2) + "\n");

    const result = publishReceipts({ retainedDir: ctx.retainedDir, evidenceDir: ctx.evidenceDir });
    assert.equal(result.code, 0, result.messages.join("; "));
    const ids = JSON.parse(readFileSync(join(ctx.evidenceDir, "receipt.json"), "utf8")).map((e) => e.captureId);
    assert.ok(ids.includes(carried.captureId), "a receipt whose raw bytes are gone must survive");
    assert.ok(!ids.includes(superseded.captureId), "a receipt no cell claims must be dropped");
    assert.ok(result.messages.some((m) => m.includes(`dropping ${superseded.captureId}`)), result.messages.join("; "));
  });
});

test("an empty or absent retained directory is reported, not treated as a successful publication", () => {
  const root = mkdtempSync(join(tmpdir(), "receipt-empty-"));
  try {
    const retainedDir = join(root, "retained");
    mkdirSync(retainedDir);
    assert.equal(publishReceipts({ retainedDir, evidenceDir: root }).code, 2);
    assert.equal(publishReceipts({ retainedDir: join(root, "absent"), evidenceDir: root }).code, 2);
    assert.equal(existsSync(join(root, "receipt.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- publishing --------------------------------------------------------------------------

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

test("the committed receipt's note is the generator's, and says what survives deletion", () => {
  // The raw captures these receipts stand for are gone, so receipt.json can never be
  // regenerated without paying for four more client runs. That makes its prose the one part
  // of a generated artifact that can silently drift away from the generator — so pin it here:
  // whatever a future regeneration would stamp is what the committed file already says.
  const committed = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "evidence", "real-clients", "receipt.json"), "utf8"),
  );
  assert.ok(committed.length > 0, "the committed receipt is empty — nothing is being pinned");
  for (const record of committed) {
    assert.equal(record.note, RECEIPT_NOTE, `${record.captureId} carries a note the generator would not write`);
  }
  // And the note must not claim recomputability, which is the specific overstatement that
  // review round 1 caught: after deletion these digests are attestations, not checks.
  assert.match(RECEIPT_NOTE, /COMMITMENTS/);
  assert.doesNotMatch(RECEIPT_NOTE, /residual check/);
});
