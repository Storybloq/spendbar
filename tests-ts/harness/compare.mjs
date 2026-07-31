/**
 * Byte-level comparison of two runs, plus a report a human can act on.
 *
 * Comparison is on Buffers, never on decoded strings. Two different byte sequences can
 * decode to the same JS string (any invalid UTF-8 becomes U+FFFD), so a string comparison
 * would report parity for output that is not, in fact, identical. That is the exact shape
 * of vacuous verification this harness exists to avoid, so the self-test in parity.mjs
 * pins it with a pair of distinct invalid-UTF-8 sequences.
 */
import { describeTermination } from "./run.mjs";

/**
 * @returns {Array<{stream: string, detail: string}>} empty when the two runs are identical
 */
export function compareRuns(expected, actual) {
  const diffs = [];
  for (const stream of ["stdout", "stderr"]) {
    const d = compareBytes(expected[stream], actual[stream]);
    if (d) diffs.push({ stream, detail: d });
  }
  const t = compareTermination(expected.termination, actual.termination);
  if (t) diffs.push({ stream: "termination", detail: t });
  return diffs;
}

export function compareBytes(a, b) {
  if (a.equals(b)) return null;
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  const lines = [`${a.length}B expected vs ${b.length}B actual; first difference at byte ${i}`];
  if (i < limit) {
    lines.push(`  expected 0x${hex(a[i])} ${charOf(a[i])}   actual 0x${hex(b[i])} ${charOf(b[i])}`);
  } else {
    lines.push(`  common prefix of ${i}B; the ${a.length > b.length ? "expected" : "actual"} side continues`);
  }
  lines.push(`  expected | ${window(a, i)}`);
  lines.push(`  actual   | ${window(b, i)}`);
  return lines.join("\n");
}

export function compareTermination(a, b) {
  if (a.kind !== b.kind) return `${describeTermination(a)} vs ${describeTermination(b)}`;
  if (a.kind === "exit" && a.status !== b.status) return `exit ${a.status} vs exit ${b.status}`;
  if (a.kind === "signal" && a.signal !== b.signal) return `killed by ${a.signal} vs ${b.signal}`;
  if (a.kind === "spawn-error" && a.code !== b.code) return `spawn failed ${a.code} vs ${b.code}`;
  return null;
}

const CONTEXT = 40;

/** A printable slice around `at`, with control bytes escaped so the report stays on one line. */
function window(buf, at) {
  const start = Math.max(0, at - CONTEXT);
  const slice = buf.subarray(start, Math.min(buf.length, at + CONTEXT));
  const text = [...slice.toString("utf8")]
    .map((c) => (c === "\n" ? "\\n" : c === "\t" ? "\\t" : c === "\r" ? "\\r" : c))
    .join("");
  return `${start > 0 ? "…" : ""}${text}${at + CONTEXT < buf.length ? "…" : ""}`;
}

const hex = (byte) => byte.toString(16).padStart(2, "0");
const charOf = (byte) =>
  byte >= 0x20 && byte < 0x7f ? `'${String.fromCharCode(byte)}'` : byte === 0x0a ? "'\\n'" : "";
