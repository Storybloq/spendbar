/**
 * Raw-transcript scanning: the chunked reader and the error contract.
 *
 * The parity corpus in `tests/harness/fixtures.py` covers the aggregation end to end against
 * the oracle, but every line there is short and every file is readable. These are the cases
 * that only a hand-built tree can reach — and without them the incremental decoder in
 * `readLines` would be unfalsifiable: a whole-file read passes the corpus identically.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanTranscripts, readLines } from "../dist/transcripts.js";
import { createDeps, DEFAULT_CONFIG } from "../dist/context.js";

const DATE = "2026-01-01";
/** 17:15Z is 09:15 in America/Vancouver, the zone the whole suite pins. */
const TS = "2026-01-01T17:15:00.000Z";

function rec(extra = {}, tokens = 4) {
  return JSON.stringify({
    timestamp: TS,
    requestId: `r-${Math.abs(hash(JSON.stringify(extra) + tokens))}`,
    message: {
      model: "claude-fable-5",
      id: "m-1",
      usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ...extra,
    },
  });
}

/** Deterministic id so records stay distinct without Math.random (banned in this repo). */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Build a $HOME containing one transcript with the given raw text. */
function homeWith(text, name = "session.jsonl") {
  const home = mkdtempSync(join(tmpdir(), "tr-"));
  const dir = join(home, ".claude", "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return { home, file: join(dir, name) };
}

function scan(home) {
  const deps = createDeps({ CCUSAGE_CMD: "stub" }, home, () => ({ status: 0, stdout: "{}", stderr: "" }), {
    today: () => "20260715",
  });
  return scanTranscripts({ deps, config: DEFAULT_CONFIG }, DATE, DATE);
}

const tokensAt = (buckets, bucket = "09:00") => buckets.get(bucket)?.get("fable") ?? 0;

describe("readLines is incremental, not a whole-file slurp", () => {
  test("a line far larger than the 64KiB chunk is reassembled intact", () => {
    // 200KB of padding inside the JSON, so the record spans several reads.
    const fat = rec({ pad: "x".repeat(200_000) }, 7);
    const { home } = homeWith(fat + "\n");
    try {
      assert.equal(tokensAt(scan(home)), 7, "a record split across chunks was lost or corrupted");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a multi-byte character straddling the chunk boundary decodes intact", () => {
    // Asserted on readLines DIRECTLY, on the exact bytes. Going through scanTranscripts
    // cannot catch this: a corrupted character inside a JSON string still parses and still
    // sums to the same token count, so a per-chunk `toString("utf8")` mutant survived that
    // version of this test. The decoder is only falsifiable at the line level.
    const CHUNK = 1 << 16;
    for (const k of [CHUNK - 1, CHUNK - 2, CHUNK - 3, CHUNK, CHUNK + 1]) {
      const line = `${"A".repeat(k)}\u2192END`; // U+2192 is 3 bytes in UTF-8
      const { home, file } = homeWith(`${line}\n`);
      try {
        assert.deepEqual([...readLines(file)], [line], `boundary at k=${k}: line was corrupted`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test("a 4-byte astral character straddling the boundary survives too", () => {
    const CHUNK = 1 << 16;
    for (const k of [CHUNK - 1, CHUNK - 2, CHUNK - 3]) {
      const line = `${"A".repeat(k)}\u{1F600}END`;
      const { home, file } = homeWith(`${line}\n`);
      try {
        assert.deepEqual([...readLines(file)], [line], `astral boundary at k=${k} corrupted`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test("records spanning chunks still aggregate", () => {
    // Pad so that a 3-byte character lands across the 65536-byte read boundary. The record
    // must still parse; a non-incremental decoder yields U+FFFD and JSON.parse survives but
    // the padding — and with a lone surrogate, the parse itself — would differ.
    const CHUNK = 1 << 16;
    let recovered = 0;
    for (const offset of [-1, -2, 0, 1]) {
      const head = rec({ pad: "y".repeat(CHUNK + offset) }, 3);
      const text = `${head}\n${rec({ pad: "→→→→" }, 5)}\n`;
      const { home } = homeWith(text);
      try {
        const b = scan(home);
        assert.equal(tokensAt(b), 8, `offset ${offset}: expected both records (3+5)`);
        recovered++;
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
    assert.equal(recovered, 4);
  });

  test("a final line with no trailing newline is still a line", () => {
    const { home } = homeWith(rec({}, 9)); // no "\n"
    try {
      assert.equal(tokensAt(scan(home)), 9);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a trailing newline does not produce an extra empty line", () => {
    const { home } = homeWith(`${rec({}, 2)}\n\n\n`);
    try {
      assert.equal(tokensAt(scan(home)), 2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("error contract", () => {
  test("an unreadable transcript raises rather than reporting zero records", () => {
    // usage.py's tolerance is the bare `except` around json.loads, NOT around open(): an
    // unreadable file raises straight out of cmd_hourly. Silently treating it as empty
    // would print a plausible, wrong histogram (code review R1).
    const { home, file } = homeWith(`${rec({}, 5)}\n`);
    try {
      chmodSync(file, 0o000);
      // Running as root defeats the permission bit; skip rather than assert something false.
      let readable = true;
      try {
        scan(home);
      } catch {
        readable = false;
      }
      if (readable && process.getuid?.() === 0) return;
      assert.throws(() => scan(home), /EACCES|permission denied/i);
    } finally {
      try {
        chmodSync(file, 0o644);
      } catch {}
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a missing ~/.claude/projects tree is not an error", () => {
    // glob simply yields no matches, which is the empty-fixture path the goldens take.
    const home = mkdtempSync(join(tmpdir(), "tr-empty-"));
    try {
      assert.equal(scan(home).size, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
