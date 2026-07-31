#!/usr/bin/env node
// T-001 rounding spike: prove a JS formatter that reproduces Python's f"{x:,.2f}"
// byte-for-byte on the exact binary value of every finite double.
//
// Why not the obvious things (both empirically disproven during plan review):
//   - Intl.NumberFormat roundingMode:'halfEven' rounds the SHORTEST decimal repr
//     (2.675 -> "2.68"; Python: "2.67").
//   - toFixed rounds half-away on exactly-representable midpoints
//     (0.125 -> "0.13"; Python: "0.12").
//
// Approach: decode IEEE-754 bits -> |x| = M * 2^E with BigInt M. Cents = M*100*2^E
// computed exactly; at E<0 the remainder r vs half = 2^(k-1) decides round direction,
// with half-even only at true binary ties. No floating intermediate ever exists.
//
// Verification: differential vs python3 over (a) targeted boundary corpora
// (midpoint neighbors across magnitudes, exact eighth-ties, +-0, subnormals,
// huge values), (b) random fuzz (bit-random finite doubles + uniform + log-uniform).
// Values cross the process boundary as 16-hex-digit bit patterns — bit-exact.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- formatter
const buf = new ArrayBuffer(8);
const view = new DataView(buf);

function bitsOf(x) { view.setFloat64(0, x); return view.getBigUint64(0); }
function fromBits(b) { view.setBigUint64(0, b); return view.getFloat64(0); }

function group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

/** Python-parity f"{x:,.2f}" for any double. */
export function pyFixed2(x) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const bits = bitsOf(x);
  const neg = (bits >> 63n) & 1n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const mantBits = bits & 0xfffffffffffffn;
  let M, E; // |x| = M * 2^E exactly
  if (expBits === 0) { M = mantBits; E = -1074; }        // subnormal (and +-0)
  else { M = mantBits | 0x10000000000000n; E = expBits - 1075; }
  const N = M * 100n;
  let cents;
  if (E >= 0) {
    cents = N << BigInt(E);                               // exact integer cents
  } else {
    const k = BigInt(-E);
    const q = N >> k;
    const r = N - (q << k);
    const half = 1n << (k - 1n);
    if (r > half) cents = q + 1n;
    else if (r < half) cents = q;
    else cents = (q & 1n) === 0n ? q : q + 1n;            // true binary tie: half-even
  }
  const s = cents.toString().padStart(3, "0");
  return (neg ? "-" : "") + group(s.slice(0, -2)) + "." + s.slice(-2);
}

/** Python-parity f"{n:,}" for safe integers (usage.py fmt()). */
export function pyThousands(n) {
  const neg = n < 0 || Object.is(n, -0);
  const s = group(Math.abs(n).toString());
  return (neg ? "-" : "") + s;
}

// ---------------------------------------------------------------- corpora
const values = [];
function push(x) { if (typeof x === "number") values.push(x); }
function next(x, dir) { // nextafter via bit nudge (finite domain only)
  let b = bitsOf(x);
  if (x === 0) return dir > 0 ? fromBits(1n) : -fromBits(1n);
  const up = (x > 0) === (dir > 0);
  b = up ? b + 1n : b - 1n;
  const v = fromBits(b);
  return Number.isFinite(v) ? v : x;
}

// specials + every divergence value from the plan-review table
[0, -0, 1, -1, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308,
 2.675, 0.005, 0.015, 0.025, 12.345, 0.125, 0.625, -0.125, -2.675,
 83.995, 83.99499999999999, 7.377597, 38.464743, 38.15266,
 1e15, 1e15 + 0.005, 1e21, 1e300, 1e-10, -1e-10, 0.004999999999999999,
 999.995, 999999.995, 0.994999999999, 1234567.891].forEach(push);

// midpoint neighborhoods: d.cc5 decimal strings across magnitudes -> nearest double
// plus both bit-neighbors (just-below / just-above the decimal midpoint)
for (const ip of ["0", "1", "9", "12", "99", "123", "999", "45678", "999999", "123456789"]) {
  for (let cc = 0; cc < 100; cc += ip.length < 3 ? 1 : 7) {
    const v = parseFloat(`${ip}.${String(cc).padStart(2, "0")}5`);
    push(v); push(next(v, +1)); push(next(v, -1)); push(-v);
  }
}
// exact binary ties: odd multiples of 1/8 (the only class where x*100 is a half-integer)
for (let i = 0; i < 2000; i += 13) {
  for (const j of [1, 3, 5, 7]) { const v = i + j / 8; push(v); push(-v); }
}
// exact ties at scale (integer + odd eighth, large integers)
for (const base of [1e6, 1e9, 1e12]) for (const j of [1, 3, 5, 7]) push(base + j / 8);

// random fuzz
let seed = 0x5eedn;
function rnd64() { // xorshift64* — deterministic across runs
  seed ^= seed << 13n; seed &= 0xffffffffffffffffn;
  seed ^= seed >> 7n; seed ^= seed << 17n; seed &= 0xffffffffffffffffn;
  return seed;
}
const FUZZ = parseInt(process.env.FUZZ ?? "120000", 10);
let made = 0;
while (made < FUZZ * 0.3) {              // bit-random finite doubles
  const v = fromBits(rnd64());
  if (Number.isFinite(v)) { push(v); made++; }
}
for (; made < FUZZ * 0.7; made++) {       // uniform cost-like ranges
  const r = Number(rnd64() % 1000000000n) / 1e9;
  push(r * [1, 10, 100, 1000, 100000][made % 5]);
}
for (; made < FUZZ; made++) {             // log-uniform magnitudes
  const r = Number(rnd64() % 1000000000n) / 1e9;
  const e = Number(rnd64() % 25n) - 8;
  push(r * 10 ** e);
}

// ---------------------------------------------------------------- differential run
const dir = mkdtempSync(join(tmpdir(), "rounding-spike-"));
const bitsFile = join(dir, "bits.txt");
writeFileSync(bitsFile, values.map(v => bitsOf(v).toString(16).padStart(16, "0")).join("\n") + "\n");

const py = `
import struct, sys
out = []
with open(sys.argv[1]) as f:
    for line in f:
        v = struct.unpack(">d", bytes.fromhex(line.strip()))[0]
        out.append(f"{v:,.2f}")
sys.stdout.write("\\n".join(out))
`;
const pyRun = spawnSync("python3", ["-c", py, bitsFile], { encoding: "utf8", maxBuffer: 1 << 28 });
if (pyRun.status !== 0) { console.error("python failed:", pyRun.stderr); process.exit(2); }
const pyOut = pyRun.stdout.split("\n");

let fail = 0;
const samples = [];
for (let i = 0; i < values.length; i++) {
  const js = pyFixed2(values[i]);
  if (js !== pyOut[i]) {
    fail++;
    if (samples.length < 10) samples.push({ bits: bitsOf(values[i]).toString(16), v: values[i], py: pyOut[i], js });
  }
}

// integer grouping sanity (usage.py fmt())
const intChecks = [0, 1, 999, 1000, 123456789, 3360475898, -1234567];
const pyInt = spawnSync("python3", ["-c",
  `print("\\n".join(f"{n:,}" for n in [${intChecks.join(",")}]))`], { encoding: "utf8" });
const pyInts = pyInt.stdout.trim().split("\n");
let intFail = 0;
intChecks.forEach((n, i) => { if (pyThousands(n) !== pyInts[i]) intFail++; });

console.log(`corpus size:      ${values.length.toLocaleString("en-US")}`);
console.log(`float mismatches: ${fail}`);
console.log(`int   mismatches: ${intFail}`);
if (samples.length) console.log("sample failures:", JSON.stringify(samples, null, 2));
// sanity: prove the naive approaches DO diverge on this corpus (guards corpus quality)
let toFixedDiv = 0, intlDiv = 0;
const intl = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, roundingMode: "halfEven", useGrouping: true });
for (let i = 0; i < values.length; i++) {
  const v = values[i];
  if (!Number.isFinite(v)) continue;
  const tf = (v < 0 || Object.is(v, -0) ? "-" : "") + group(Math.abs(v).toFixed(2));
  if (tf !== pyOut[i]) toFixedDiv++;
  if (intl.format(v) !== pyOut[i]) intlDiv++;
}
console.log(`corpus catches toFixed divergences: ${toFixedDiv}`);
console.log(`corpus catches Intl divergences:    ${intlDiv}`);
process.exit(fail || intFail ? 1 : 0);