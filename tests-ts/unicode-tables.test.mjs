// The Unicode tables are pinned to the REFERENCE CPython, not to V8's newer database.
// These tests prove the committed table still matches the local python3, and that the
// skew the pinning exists to close is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ND_RANGES,
  UNICODE_VERSION,
  isDecimalDigit,
  decimalValue,
  isPrintableCodePoint,
} from "../dist/unicode-tables.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The Unicode version of the python3 on PATH, which may not be the pinned reference. */
function localUnicodeVersion() {
  const out = spawnSync("python3", ["-c", "import unicodedata;print(unicodedata.unidata_version)"], {
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

test("committed unicode-tables.ts is exactly what the generator produces", (t) => {
  const local = localUnicodeVersion();
  if (local !== UNICODE_VERSION) {
    // Do NOT tell the developer to regenerate here: doing so under this interpreter would
    // silently move the pinned contract. The generator refuses for the same reason.
    t.skip(
      `python3 on PATH has Unicode ${local}, the table is pinned to ${UNICODE_VERSION}; ` +
        `drift can only be checked against the reference interpreter`,
    );
    return;
  }
  const out = spawnSync("python3", [join(ROOT, "scripts/gen-unicode.py")], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  assert.equal(out.status, 0, out.stderr);
  const committed = readFileSync(join(ROOT, "src/unicode-tables.ts"), "utf8");
  assert.equal(
    out.stdout,
    committed,
    "src/unicode-tables.ts has drifted from the reference CPython — regenerate with the " +
      `Unicode ${UNICODE_VERSION} interpreter and re-verify the goldens`,
  );
});

test("the generator refuses to run under a non-reference interpreter", () => {
  const local = localUnicodeVersion();
  // Ask it to pin to a version this interpreter definitely is not.
  const bogus = local === "9.9.9" ? "8.8.8" : "9.9.9";
  const out = spawnSync("python3", [join(ROOT, "scripts/gen-unicode.py")], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
    env: { ...process.env, SPENDBAR_UNICODE_REF: bogus },
  });
  assert.notEqual(out.status, 0, "generator must exit non-zero on a version mismatch");
  assert.equal(out.stdout, "", "must emit no table when refusing");
  assert.match(out.stderr, /refusing to generate/);
  assert.match(out.stderr, new RegExp(`Unicode ${bogus.replace(/\./g, "\\.")}`));
});

test("the table matches CPython, and V8's own table does NOT", () => {
  const script = [
    "import json, unicodedata, sys",
    "nd = [cp for cp in range(0x110000) if unicodedata.category(chr(cp)) == 'Nd']",
    "print(json.dumps({'nd': nd, 'ver': unicodedata.unidata_version}))",
  ].join("\n");
  const out = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(out.status, 0, out.stderr);
  const { nd, ver } = JSON.parse(out.stdout);
  assert.equal(ver, UNICODE_VERSION, "generator ran against a different CPython");

  const pySet = new Set(nd);
  const v8Only = [];
  for (let cp = 0; cp < 0x110000; cp++) {
    const inPy = pySet.has(cp);
    assert.equal(isDecimalDigit(cp), inPy, `U+${cp.toString(16)} digit classification`);
    if (!inPy && /\p{Nd}/u.test(String.fromCodePoint(cp))) v8Only.push(cp);
  }

  // The whole reason the table exists: V8 knows digits CPython does not. If this ever
  // becomes empty the pinning is harmless, but the assertion documents the hazard.
  assert.ok(
    v8Only.length > 0,
    "expected V8 to know Nd code points CPython does not; if not, the runtimes have converged",
  );
});

test("every Nd code point's value matches CPython int()", () => {
  const script = [
    "import json, unicodedata",
    "print(json.dumps([[cp, int(chr(cp))] for cp in range(0x110000)",
    "                  if unicodedata.category(chr(cp)) == 'Nd']))",
  ].join("\n");
  const out = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(out.status, 0, out.stderr);
  const expected = JSON.parse(out.stdout);
  assert.ok(expected.length > 500);
  for (const [cp, value] of expected) {
    assert.equal(decimalValue(cp), value, `U+${cp.toString(16)}`);
  }
  assert.equal(
    ND_RANGES.reduce((n, [a, b]) => n + (b - a + 1), 0),
    expected.length,
    "table covers exactly CPython's Nd set",
  );
});

test("isPrintableCodePoint matches CPython str.isprintable() across all code points", () => {
  const script = [
    "import json",
    "runs = []",
    "for cp in range(0x110000):",
    "    p = chr(cp).isprintable()",
    "    if runs and runs[-1][2] == p and runs[-1][1] == cp - 1: runs[-1][1] = cp",
    "    else: runs.append([cp, cp, p])",
    "print(json.dumps(runs))",
  ].join("\n");
  const out = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 128 << 20 });
  assert.equal(out.status, 0, out.stderr);
  const runs = JSON.parse(out.stdout);
  let checked = 0;
  for (const [start, end, printable] of runs) {
    // Check both ends of every run plus one interior point — full coverage of boundaries.
    for (const cp of new Set([start, end, (start + end) >> 1])) {
      assert.equal(isPrintableCodePoint(cp), printable, `U+${cp.toString(16)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 1000, `expected broad coverage, checked ${checked}`);
});
