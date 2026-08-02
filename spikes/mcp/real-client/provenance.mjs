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
 * The repository bytes a real-client capture's meaning depends on: what the probe server was
 * (probe-def, both servers, both workspace manifests, both lockfiles), how the root it ran from
 * was assembled and what environment it ran under (isolate), and how the run was conducted and
 * recorded (capture, capture-wrapper, sanitize, normalize, and the privacy rules the sanitizer
 * enforces over its own output).
 *
 * isolate.mjs was missing until review round 1, chunk 13 — an omission that mattered: it
 * decides which files are copied into the assembled root, asserts the root is outside the
 * repository, and CONSTRUCTS the candidate server's environment. Editing any of that changes
 * what a capture observed while leaving its provenance pin valid. The candidate `package.json`
 * files were missing for the same reason: they are copied into the root and their `dependencies`
 * and module type are what the server's bare imports resolve against.
 *
 * Four files are deliberately ABSENT, each for a stated and falsifiable reason:
 *   * classify.mjs — the verifier re-runs the classifier live over the recorded manifest, so a
 *     change there re-derives rather than invalidates.
 *   * receipt.mjs — covered by RECEIPT_SCHEMA_VERSION below, which refuses old receipts by
 *     version instead of forcing a paid recapture for every edit to the verifier.
 *   * instrument.mjs / instrument-hooks.mjs — isolate copies them into every assembled root,
 *     but this path never loads them: capture-wrapper.mjs spawns `node server.mjs` with no
 *     loader flag and no SPENDBAR_RESOLVE_LOG, so they are inert bytes on disk here. They are
 *     capture inputs of the SCRIPTED matrix, which is why BOUND_INPUTS carries them; wiring a
 *     loader into the wrapper would move them onto this list too.
 *
 * The installed dependency bytes are NOT a repository file and are not pinned here — they are
 * pinned per capture as `candidateTreeSha256`, the digest isolate.mjs takes of the exact
 * node_modules tree it copied into the root. A lockfile is a claim about what should be
 * installed; that digest is what was.
 */
export const CAPTURE_INPUTS = [
  "spikes/mcp/probe-def.mjs",
  "spikes/mcp/isolate.mjs",
  "spikes/mcp/candidates/v1/server.mjs",
  "spikes/mcp/candidates/v2/server.mjs",
  "spikes/mcp/candidates/v1/package.json",
  "spikes/mcp/candidates/v2/package.json",
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
 *   receipt/3 — the installed dependency tree the server actually ran from is checked too
 */
export const RECEIPT_SCHEMA_VERSION = "receipt/3";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Digest every capture input from a working tree, as a {path: sha256} record.
 *
 * This one THROWS on an unreadable input, and should: it runs at capture time, before anything
 * is spawned, and a capture whose provenance cannot be established must not start.
 */
export function captureInputDigests(repoRoot = REPO_ROOT) {
  const files = {};
  for (const rel of CAPTURE_INPUTS) files[rel] = sha256(readFileSync(join(repoRoot, rel)));
  return files;
}

/**
 * Compare a recorded digest set against a working tree. Returns the relative paths that differ
 * or are missing — NEVER the digests themselves, which are not the interesting part and whose
 * inclusion in a message would only make it harder to read.
 *
 * Unlike captureInputDigests this NEVER throws for an input it cannot read (review round 1,
 * chunk 13). It runs inside the receipt, where the whole batch is being judged and every
 * refusal must arrive as one of the reported problems: a deleted or unreadable capture input
 * is a stale pin — the recorded digest cannot be shown to still describe this tree — not an
 * exception thrown past the verifier's own error reporting.
 */
export function staleCaptureInputs(recorded, repoRoot = REPO_ROOT) {
  const stale = [];
  for (const rel of CAPTURE_INPUTS) {
    let current;
    try {
      current = sha256(readFileSync(join(repoRoot, rel)));
    } catch {
      stale.push(rel);
      continue;
    }
    if (recorded?.[rel] !== current) stale.push(rel);
  }
  const extra = Object.keys(recorded ?? {}).filter((rel) => !CAPTURE_INPUTS.includes(rel));
  return { stale, extra };
}
