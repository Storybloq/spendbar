// What a real-client capture's MEANING depends on, and when that is recorded.
//
// This lives in its own module because BOTH ends need it and neither may import the other:
// capture.mjs records the digest set BEFORE it spawns anything, and receipt.mjs compares that
// recorded set against the working tree before it approves anything.
//
// Review round 1, chunk 10: the digests used to be computed by receipt.mjs at RECEIPT time
// while the comment claimed capture time. Anything edited between the paid run and the receipt
// — a probe definition, a server, a lockfile, the sanitizer, the privacy rules — was then
// silently bound to a capture it had nothing to do with. The window is small and entirely
// avoidable, so it is now closed: the capture pins, the receipt only checks.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..");

/**
 * The repository bytes a real-client capture's meaning depends on: what the probe server did
 * (probe-def, both servers, both lockfiles) and how the run was conducted and recorded
 * (capture, capture-wrapper, sanitize, normalize, and the privacy rules the sanitizer enforces
 * over its own output).
 *
 * classify.mjs and receipt.mjs are deliberately ABSENT. The verifier re-runs the classifier
 * live over the recorded manifest, so a change there re-derives rather than invalidates; and
 * receipt.mjs is covered by RECEIPT_SCHEMA_VERSION below, which refuses old receipts by
 * version instead of forcing a paid recapture for every edit to the verifier.
 */
export const CAPTURE_INPUTS = [
  "spikes/mcp/probe-def.mjs",
  "spikes/mcp/candidates/v1/server.mjs",
  "spikes/mcp/candidates/v2/server.mjs",
  "spikes/mcp/candidates/v1/package-lock.json",
  "spikes/mcp/candidates/v2/package-lock.json",
  "spikes/mcp/real-client/capture.mjs",
  "spikes/mcp/real-client/capture-wrapper.mjs",
  "spikes/mcp/real-client/sanitize.mjs",
  "spikes/mcp/real-client/normalize.mjs",
  "scripts/privacy-scan.mjs",
  "scripts/privacy-synthetic.json",
];

/**
 * The receipt's own contract version. A receipt is a permission to DELETE the raw bytes, so a
 * receipt written by an older, weaker verifier must not keep validating after the verifier is
 * strengthened — the raw evidence that would settle it is gone by then. Bump this whenever
 * what receipt.mjs checks changes materially; the offline verifier refuses anything else.
 *
 *   receipt/1 — digests + frames only (review round 1 found this insufficient)
 *   receipt/2 — full re-derivation: re-sanitize, re-classify, all four streams, provenance
 */
export const RECEIPT_SCHEMA_VERSION = "receipt/2";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Digest every capture input from a working tree, as a {path: sha256} record. */
export function captureInputDigests(repoRoot = REPO_ROOT) {
  const files = {};
  for (const rel of CAPTURE_INPUTS) files[rel] = sha256(readFileSync(join(repoRoot, rel)));
  return files;
}

/**
 * Compare a recorded digest set against a working tree. Returns the relative paths that differ
 * or are missing — NEVER the digests themselves, which are not the interesting part and whose
 * inclusion in a message would only make it harder to read.
 */
export function staleCaptureInputs(recorded, repoRoot = REPO_ROOT) {
  const current = captureInputDigests(repoRoot);
  const stale = [];
  for (const rel of CAPTURE_INPUTS) {
    if (recorded?.[rel] !== current[rel]) stale.push(rel);
  }
  const extra = Object.keys(recorded ?? {}).filter((rel) => !CAPTURE_INPUTS.includes(rel));
  return { stale, extra };
}
