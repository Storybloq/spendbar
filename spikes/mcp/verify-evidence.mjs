#!/usr/bin/env node
// The independent evidence verifier (plan §6): derives every decision input from recorded
// evidence plus recomputed repository-side facts, and REFUSES rather than repairs.
//
// What it rejects, by design:
//   * a repository-side input whose digest no longer matches the recorded one — evidence
//     captured against different bytes proves nothing about these bytes (the one-byte probe
//     mutation test exists to prove this rejection fires);
//   * a duplicated key anywhere in an evidence file (JSON.parse keeps the last occurrence
//     silently; the strict parser refuses), and any unknown, missing, or wrongly-typed field
//     at ANY level — every record carries exactly its declared fields;
//   * a real-client cell whose recorded status disagrees with the status RE-DERIVED by
//     running the classifier over the sanitized manifest, or whose digests disagree with the
//     receipt — a hand-edited cells.json cannot flip a cell (review round 1);
//   * internal inconsistencies a tamper would introduce: a `failed` count that does not
//     equal the failing cases, a token count that does not follow from the recorded bytes
//     under the pinned proxy;
//   * isolation evidence that is broken or absent — scripted results from a root that
//     resolved outside itself are not evidence about the SDK;
//   * supply-chain evidence with violations — the no-hooks precondition of the whole gate.
//
// Absent REAL-CLIENT evidence is different: those cells become `not-run` with a recorded
// cause, because "never captured" must surface as `incomplete` at the decision layer, loudly —
// not as a verifier crash and not as a silent pass.
//
// Honest residual, recorded rather than hidden: scripted case STATUSES are recorded outcomes
// of the live matrix run, digest-bound to every producing input — the verifier checks their
// shape, sets, and internal consistency but cannot re-execute the live exchanges offline.
// Re-deriving them from persisted raw protocol transcripts is tracked as follow-up work.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCRIPTED_CASES,
  REAL_CLIENTS,
  MANDATORY_CELLS,
  STATUSES,
  decide,
  renderDecisionDoc,
  renderDecisionRecord,
  renderAttemptReport,
  serializeJsonArtifact,
} from "./decide.mjs";
import { parseStrictJson, JsonSyntaxError } from "./strict-json.mjs";
import { classify, toCellStatus, InvalidRecordError } from "./real-client/classify.mjs";
import { STREAM_STAT_KEYS, DIGEST_KEYS } from "./real-client/sanitize.mjs";
import { PROMPT_TEMPLATE, PROMPT_TEMPLATE_SHA256, COMPLETION_MARKER } from "./real-client/capture.mjs";
import { CAPTURE_INPUTS, RECEIPT_SCHEMA_VERSION } from "./real-client/provenance.mjs";
import { TOKEN_PROXY_VERSION } from "./token-cost.mjs";
import { isDirectEntry } from "../../scripts/direct-entry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_DIR = join(HERE, "evidence");

// The repository-side inputs the evidence is bound to: everything that PRODUCES evidence,
// not just what the scripted matrix executes — the supply-chain inspector and the whole
// real-client capture/normalize/classify/sanitize/receipt pipeline included (review round 1).
// Adding a file that shapes the evidence without listing it here is the drift this list
// exists to prevent.
export const BOUND_INPUTS = [
  "spikes/mcp/probe-def.mjs",
  "spikes/mcp/candidates/v1/server.mjs",
  "spikes/mcp/candidates/v2/server.mjs",
  "spikes/mcp/candidates/v1/package.json",
  "spikes/mcp/candidates/v2/package.json",
  "spikes/mcp/candidates/v1/package-lock.json",
  "spikes/mcp/candidates/v2/package-lock.json",
  "spikes/mcp/conformance.mjs",
  "spikes/mcp/isolate.mjs",
  "spikes/mcp/instrument.mjs",
  "spikes/mcp/instrument-hooks.mjs",
  "spikes/mcp/token-cost.mjs",
  "spikes/mcp/supply-chain.mjs",
  "spikes/mcp/matrix.mjs",
  "spikes/mcp/real-client/capture.mjs",
  "spikes/mcp/real-client/capture-wrapper.mjs",
  "spikes/mcp/real-client/classify.mjs",
  "spikes/mcp/real-client/normalize.mjs",
  "spikes/mcp/real-client/sanitize.mjs",
  "spikes/mcp/real-client/receipt.mjs",
  "spikes/mcp/real-client/provenance.mjs",
  // The sanitizer runs the privacy classifier over its own output and refuses on a match, so
  // these rules — and the synthetic-value declarations that decide what they let through —
  // shape every committed manifest.
  "scripts/direct-entry.mjs",
  "scripts/privacy-scan.mjs",
  "scripts/privacy-synthetic.json",
];

/**
 * Which real clients CAN take their user configuration out of a capture — a property of the
 * CLIENT, not something a capture manifest is trusted to report about itself.
 *
 * Claude Code accepts --strict-mcp-config plus --settings, so its user configuration is provably
 * out of the run. `codex exec -c` has no equivalent. A codex manifest claiming isolation is
 * claiming something the tool cannot do, and the effect of believing it was that the
 * `user-config-not-isolated` qualification silently disappeared — a conditional pass presented
 * as an unconditional one (review round 2, chunk 12).
 */
export const CAN_ISOLATE_USER_CONFIG = { "claude-code": true, codex: false };

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export class EvidenceError extends Error {}
const refuse = (msg) => {
  throw new EvidenceError(msg);
};

function readJson(path, what) {
  if (!existsSync(path)) refuse(`${what} is absent (${path})`);
  try {
    return parseStrictJson(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof JsonSyntaxError) refuse(`${what} is not strict JSON: ${error.message}`);
    refuse(`${what} is unreadable: ${error.message}`);
  }
}

/** Exact-shape check: a record carries exactly its declared fields, with the declared types.
 *  spec values: { type, optional?, nullable? } where type ∈ string|number|boolean|object|array. */
function checkShape(record, spec, what) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    refuse(`${what} is not an object`);
  }
  for (const key of Object.keys(record)) {
    // `key in spec` consults Object.prototype, so `constructor`, `toString`, `valueOf` and
    // `__proto__` all read as DECLARED fields — and `Object.entries(spec)` never iterates them,
    // so their values were not type-checked either. An evidence record could carry those names
    // through a primitive whose whole contract is an exact field set (round 2, chunk 12).
    if (!Object.prototype.hasOwnProperty.call(spec, key)) refuse(`${what} carries unknown field '${key}'`);
  }
  for (const [key, rule] of Object.entries(spec)) {
    const value = record[key];
    if (value === undefined) {
      if (!rule.optional) refuse(`${what} is missing required field '${key}'`);
      continue;
    }
    if (value === null) {
      if (!rule.nullable) refuse(`${what}.${key} is null`);
      continue;
    }
    // `count` is `number` plus the constraints a count actually has. `typeof x === "number"`
    // admits Infinity (strict JSON parses 1e999 to it), NaN, negatives and fractions — and
    // Math.ceil(Infinity/4) === Infinity, so even the token-cost arithmetic check passed on a
    // number that means nothing (round 2, chunk 12).
    if (rule.type === "count") {
      if (!Number.isSafeInteger(value) || value < 0) {
        refuse(`${what}.${key} is ${JSON.stringify(value)}, not a non-negative integer`);
      }
      continue;
    }
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== rule.type) refuse(`${what}.${key} has type ${actual}, expected ${rule.type}`);
  }
  return record;
}

function checkExactKeys(record, keys, what) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    refuse(`${what} is not an object`);
  }
  const have = Object.keys(record).sort();
  if (JSON.stringify(have) !== JSON.stringify([...keys].sort())) {
    refuse(`${what} has keys [${have.join(", ")}], expected exactly [${[...keys].sort().join(", ")}]`);
  }
  return record;
}

const CELL_SPEC = {
  status: { type: "string" },
  cause: { type: "string", optional: true },
  detail: { type: "string", optional: true },
  traceDigest: { type: "string", optional: true },
  clientVersion: { type: "string", optional: true },
  attempts: { type: "array", optional: true },
};

// The sanitized capture manifest, exactly as sanitize.mjs's FIELD_MAP emits it. The verifier
// re-derives the cell status from this record, so its shape is load-bearing.
const MANIFEST_SPEC = {
  captureId: { type: "string" },
  client: { type: "string" },
  candidate: { type: "string" },
  clientVersion: { type: "string" },
  promptSha256: { type: "string" },
  promptInstanceSha256: { type: "string" },
  nonce: { type: "string" },
  executablePath: { type: "string" },
  executableIdentity: { type: "string" },
  commandLine: { type: "array" },
  env: { type: "array" },
  cwd: { type: "string" },
  captureInputs: { type: "object" },
  candidateTreeSha256: { type: "string" },
  spawn: { type: "object" },
  wrapper: { type: "object" },
  environmental: { type: "object", nullable: true },
  isolation: { type: "object" },
  timedOut: { type: "boolean" },
  lastPhase: { type: "string" },
  clientExit: { type: "object", nullable: true },
  serverTermination: { type: "object", nullable: true },
  frames: { type: "array" },
  // Both directions' statistics are required: the classifier judges the client->server stream
  // too, and an absent block must be a refusal, never a silently unjudged channel.
  clientToServer: { type: "object" },
  serverStdout: { type: "object" },
  serverStderr: { type: "object" },
  clientStdout: { type: "object" },
  digests: { type: "object" },
  retries: { type: "array" },
};

const RECEIPT_SPEC = {
  schemaVersion: { type: "string" },
  captureId: { type: "string" },
  client: { type: "string" },
  candidate: { type: "string" },
  outcome: { type: "string" },
  reproduced: { type: "object" },
  rawStatistics: { type: "object" },
  captureInputs: { type: "object" },
  candidateTreeSha256: { type: "string" },
  // The digest of the sanitized manifest this capture produced. The stream digests beside it
  // describe bytes that were deleted; this describes the file that survives them.
  manifestSha256: { type: "string" },
  note: { type: "string", optional: true },
};

/** Both directions carry the same seven counters; the key set is the sanitizer's, not a copy. */
const STREAM_STATS_SPEC = Object.fromEntries(STREAM_STAT_KEYS.map((key) => [key, { type: "count" }]));

// Built from the sanitizer's key list rather than restated, so a stream that becomes
// digest-bound cannot be bound in one place and unchecked in the other.
const DIGEST_SET_SPEC = Object.fromEntries(DIGEST_KEYS.map((key) => [key, { type: "string" }]));

export function verifyEvidence({ evidenceDir = EVIDENCE_DIR, repoRoot = join(HERE, "..", "..") } = {}) {
  // 0. A present attempt marker means the last matrix run crashed or failed after this
  //    evidence was written — whatever is on disk is an OLDER generation and must not be
  //    consumed as current (review round 1).
  if (existsSync(join(evidenceDir, "matrix-attempt.json"))) {
    refuse("matrix-attempt.json is present — the last scripted-evidence run did not complete; regenerate before deciding");
  }
  const inputs = readJson(join(evidenceDir, "inputs.json"), "inputs.json");
  const scripted = readJson(join(evidenceDir, "scripted.json"), "scripted.json");
  const supplyChain = readJson(join(evidenceDir, "supply-chain.json"), "supply-chain.json");
  const tokenCost = readJson(join(evidenceDir, "token-cost.json"), "token-cost.json");
  const audit = readJson(join(evidenceDir, "audit.json"), "audit.json");

  // 1. Repository-side inputs, recomputed — never trusted from the record alone.
  checkShape(
    inputs,
    { files: { type: "object" }, caseList: { type: "array" }, notes: { type: "array", optional: true } },
    "inputs.json",
  );
  const boundRecorded = inputs.files;
  const recordedPaths = Object.keys(boundRecorded).sort();
  if (JSON.stringify(recordedPaths) !== JSON.stringify([...BOUND_INPUTS].sort())) {
    refuse(
      `inputs.json binds [${recordedPaths.join(", ")}] but the verifier expects exactly [${[...BOUND_INPUTS].sort().join(", ")}]`,
    );
  }
  for (const rel of BOUND_INPUTS) {
    if (typeof boundRecorded[rel] !== "string" || !HEX64.test(boundRecorded[rel])) {
      refuse(`inputs.json digest for ${rel} is not a sha256 hex string`);
    }
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) refuse(`bound input ${rel} is missing from the repository`);
    const actual = sha256(readFileSync(abs));
    if (actual !== boundRecorded[rel]) {
      refuse(`bound input ${rel} changed since capture (digest mismatch) — evidence is stale`);
    }
  }
  if (JSON.stringify(inputs.caseList) !== JSON.stringify(SCRIPTED_CASES)) {
    refuse(`inputs.json caseList does not match the verifier's literal case list`);
  }
  for (const note of inputs.notes ?? []) {
    if (typeof note !== "string") refuse("inputs.json notes must be strings");
  }

  // 2. Scripted evidence: exactly the literal case set per candidate, exact record shapes,
  //    valid statuses, unbroken isolation, and internal consistency of the failure count.
  checkExactKeys(scripted, ["v1", "v2"], "scripted.json");
  checkExactKeys(supplyChain, ["v1", "v2"], "supply-chain.json");
  const cells = { v1: {}, v2: {} };
  for (const candidate of ["v1", "v2"]) {
    const rec = checkShape(
      scripted[candidate],
      {
        candidate: { type: "string" },
        sdk: { type: "string" },
        sdkVersion: { type: "string" },
        cases: { type: "object" },
        failed: { type: "count" },
        isolation: { type: "object" },
      },
      `scripted.json ${candidate}`,
    );
    if (rec.candidate !== candidate) {
      refuse(`scripted.json ${candidate} record names candidate '${rec.candidate}'`);
    }
    checkExactKeys(rec.cases, SCRIPTED_CASES, `scripted.json ${candidate}.cases`);
    for (const name of SCRIPTED_CASES) {
      const cell = checkShape(
        rec.cases[name],
        { status: { type: "string" }, detail: { type: "string", optional: true } },
        `${candidate}/${name}`,
      );
      if (!STATUSES.includes(cell.status)) refuse(`${candidate}/${name} has invalid status '${cell.status}'`);
      cells[candidate][`scripted:${name}`] = cell;
    }
    const iso = checkShape(
      rec.isolation,
      {
        resolutionsTotal: { type: "count" },
        builtins: { type: "count" },
        insidePrefix: { type: "count" },
        violations: { type: "array" },
        // Child processes and Workers the candidate created. Their resolutions happened where
        // the instrument was never loaded, so a non-empty list means the enumeration is
        // incomplete — unknown, not clean (review round 1, chunk 16).
        descendants: { type: "array" },
        perCase: { type: "object" },
        everyCaseInstrumented: { type: "boolean" },
        oppositeSdkProbe: { type: "string" },
        ok: { type: "boolean" },
      },
      `scripted.json ${candidate}.isolation`,
    );
    if (
      !iso.ok ||
      iso.violations.length > 0 ||
      iso.descendants.length > 0 ||
      iso.oppositeSdkProbe !== "not-found" ||
      !iso.everyCaseInstrumented
    ) {
      refuse(`${candidate} isolation is broken — its scripted results prove nothing about the SDK`);
    }
    if (!(iso.resolutionsTotal > 0)) refuse(`${candidate} isolation enumerated zero resolutions`);
    // The PER-CASE records, checked rather than counted. Until review round 2, chunk 12 only
    // their key NAMES were compared against the case list, so every entry could report an error
    // or zero observations while the aggregate booleans beside them said all eight cases were
    // instrumented — and the passing scripted cells stayed adoption-eligible on that. The
    // aggregate is recomputed from the records now; a stored boolean is not evidence of itself.
    checkExactKeys(iso.perCase, SCRIPTED_CASES, `scripted.json ${candidate}.isolation.perCase`);
    let recomputedTotal = 0;
    for (const name of SCRIPTED_CASES) {
      // Two shapes, and which one a record has IS the fact being read. conformance.mjs writes
      // an error-only record when a case's audit could not be performed at all, so that record
      // is checked against its own shape and then refused — rather than being refused for
      // "missing required field 'total'", which would report a broken observation as a
      // malformed one and send a reader looking in the wrong place.
      const raw = iso.perCase[name];
      const label = `scripted.json ${candidate}.isolation.perCase.${name}`;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && raw.error !== undefined) {
        checkShape(raw, { error: { type: "string" } }, label);
        refuse(`${candidate}/${name} isolation was not observed: ${raw.error}`);
      }
      const pc = checkShape(
        raw,
        {
          total: { type: "count" },
          violations: { type: "count" },
          descendants: { type: "count" },
          sdkResolutions: { type: "count" },
        },
        label,
      );
      if (pc.total === 0) refuse(`${candidate}/${name} enumerated zero resolutions — its closure was never observed`);
      if (pc.violations !== 0) refuse(`${candidate}/${name} resolved ${pc.violations} module(s) outside its root`);
      if (pc.descendants !== 0) refuse(`${candidate}/${name} created ${pc.descendants} uninstrumented descendant(s)`);
      // The witness that this case exercised the CANDIDATE SDK rather than merely something
      // inside the assembled root (round 2, chunk 9 added it; this is what makes it load-bearing
      // to a reader who only ever sees the committed evidence).
      if (pc.sdkResolutions === 0) refuse(`${candidate}/${name} resolved nothing from the candidate SDK — it did not exercise it`);
      recomputedTotal += pc.total;
    }
    if (recomputedTotal !== iso.resolutionsTotal) {
      refuse(`${candidate} isolation reports ${iso.resolutionsTotal} resolutions but its per-case records sum to ${recomputedTotal}`);
    }
    const failingCases = SCRIPTED_CASES.filter((name) => rec.cases[name].status === "fail").length;
    if (rec.failed !== failingCases) {
      refuse(`${candidate} records failed=${rec.failed} but ${failingCases} cases fail — inconsistent`);
    }

    const sc = checkShape(
      supplyChain[candidate],
      {
        packages: { type: "count" },
        verified: { type: "count" },
        // The MEASURED expanded size of the whole closure. Recorded from round 2 chunk 13,
        // when the bound stopped being gzip's forgeable ISIZE trailer and became a count taken
        // by decompressing through a counter — a bound that is measured is worth publishing.
        expandedBytes: { type: "count" },
        violations: { type: "array" },
        install: { type: "object" },
        installedRescan: { type: "object" },
      },
      `supply-chain.json ${candidate}`,
    );
    if (sc.violations.length > 0) {
      refuse(`${candidate} supply chain has violations — the no-hooks precondition fails`);
    }
    if (!(sc.packages > 0) || sc.verified !== sc.packages) {
      refuse(`${candidate} supply chain did not verify its whole closure (${sc.verified}/${sc.packages})`);
    }
    // The tree the cases ran against: freshly installed with scripts off, then rescanned by
    // path — a candidate whose installed tree was never verified proves nothing (review
    // round 1).
    const install = checkShape(
      sc.install,
      { args: { type: "array" }, ok: { type: "boolean" } },
      `supply-chain.json ${candidate}.install`,
    );
    if (install.ok !== true || !install.args.includes("--ignore-scripts") || !install.args.includes("ci")) {
      refuse(`${candidate} was not installed with npm ci --ignore-scripts`);
    }
    const rescan = checkShape(
      sc.installedRescan,
      { packagesScanned: { type: "count" }, violations: { type: "array" } },
      `supply-chain.json ${candidate}.installedRescan`,
    );
    // The rescan must cover the WHOLE declared closure. `> 0` let a record claim 100 verified
    // packages while the installed-tree rescan — the check that the bytes actually on disk carry
    // no install hooks — looked at one of them (round 2, chunk 12).
    if (rescan.packagesScanned !== sc.packages) {
      refuse(`${candidate} installed-tree rescan covered ${rescan.packagesScanned} of ${sc.packages} packages`);
    }
    if (rescan.violations.length > 0) {
      refuse(`${candidate} installed tree has violations — the no-hooks precondition fails`);
    }
  }

  // 3. Token-cost record: pinned proxy, and the counts must FOLLOW from the recorded bytes —
  //    a tampered count that no longer matches the pinned proxy's arithmetic is refused.
  checkShape(
    tokenCost,
    { proxyVersion: { type: "string" }, v1: { type: "object" }, v2: { type: "object" } },
    "token-cost.json",
  );
  if (tokenCost.proxyVersion !== TOKEN_PROXY_VERSION) {
    refuse(`token-cost.json proxy '${tokenCost.proxyVersion}' is not the pinned '${TOKEN_PROXY_VERSION}'`);
  }
  for (const candidate of ["v1", "v2"]) {
    const tc = checkShape(
      tokenCost[candidate],
      { canonicalBytes: { type: "count" }, proxyTokens: { type: "count" }, fields: { type: "array" } },
      `token-cost.json ${candidate}`,
    );
    if (tc.proxyTokens !== Math.ceil(tc.canonicalBytes / 4)) {
      refuse(`token-cost.json ${candidate} proxyTokens does not follow from canonicalBytes under ${TOKEN_PROXY_VERSION}`);
    }
  }

  // 4. Audit record: advisory evidence, never gating (§2) — but its SHAPE is still exact.
  //    A ran audit carries its numbers; one that could not run carries its cause; anything
  //    else is refused. Refusing ran=false outright would silently make audit gating.
  checkExactKeys(audit, ["v1", "v2"], "audit.json");
  for (const candidate of ["v1", "v2"]) {
    const a = audit[candidate];
    if (a?.ran === true) {
      checkShape(
        a,
        { advisoriesTotal: { type: "count" }, ran: { type: "boolean" }, vulnerabilities: { type: "object" } },
        `audit.json ${candidate}`,
      );
      checkShape(
        a.vulnerabilities,
        {
          critical: { type: "count" },
          high: { type: "count" },
          info: { type: "count" },
          low: { type: "count" },
          moderate: { type: "count" },
          total: { type: "count" },
        },
        `audit.json ${candidate}.vulnerabilities`,
      );
    } else {
      checkShape(a, { ran: { type: "boolean" }, cause: { type: "string" } }, `audit.json ${candidate}`);
      if (a.ran !== false) refuse(`audit.json ${candidate} has invalid ran value`);
    }
  }

  // 5. Real-client cells. A recorded cell is NEVER taken at its word: its status is
  //    re-derived by running the classifier over the sanitized manifest, its digest is
  //    cross-checked against the receipt, and identity fields must agree everywhere.
  //    (The raw traces are deleted by privacy design once receipted; the manifest + receipt
  //    pair is the durable evidence this recomputation stands on.)
  const realPath = join(evidenceDir, "real-clients", "cells.json");
  const real = existsSync(realPath) ? readJson(realPath, "real-clients/cells.json") : null;
  let receipts = null;
  // Capture-time input binding: the scripted matrix recomputes inputs.json on every run, so
  // without a SEPARATE record pinned when the captures were taken, a re-run would re-bind
  // today's bytes to yesterday's paid captures. A mismatch does not refuse outright — it
  // makes the real cells not-run with a cause, which routes the decision to `incomplete` and
  // forces a recapture, exactly as a missing capture would.
  // EVERY changed capture input, not the first one found. Naming one file told a reader to
  // recapture and left them to discover the rest a run at a time; it also made the test for
  // this behaviour depend on which file happened to sort first (review round 2, chunk 4).
  let captureInputsStale = null;
  // Hoisted: the receipt and manifest provenance checks below compare against these pins.
  let ci = null;
  if (real !== null) {
    const ciPath = join(evidenceDir, "real-clients", "capture-inputs.json");
    ci = checkShape(readJson(ciPath, "real-clients/capture-inputs.json"), { files: { type: "object" } },
      "real-clients/capture-inputs.json");
    const recorded = Object.keys(ci.files).sort();
    if (JSON.stringify(recorded) !== JSON.stringify([...CAPTURE_INPUTS].sort())) {
      refuse(`real-clients/capture-inputs.json pins [${recorded.join(", ")}], expected exactly the capture-input set`);
    }
    const changed = [];
    for (const rel of CAPTURE_INPUTS) {
      const abs = join(repoRoot, rel);
      if (!existsSync(abs)) refuse(`capture input ${rel} is missing from the repository`);
      if (sha256(readFileSync(abs)) !== ci.files[rel]) changed.push(rel); // the FILE, never the digest
    }
    if (changed.length) captureInputsStale = changed.join(", ");
  }
  if (real !== null && captureInputsStale === null) {
    checkExactKeys(real, ["v1", "v2"], "real-clients/cells.json");
    const receiptRaw = readJson(join(evidenceDir, "real-clients", "receipt.json"), "real-clients/receipt.json");
    if (!Array.isArray(receiptRaw)) refuse("real-clients/receipt.json is not an array");
    const seenIds = new Set();
    receipts = receiptRaw.map((entry, index) => {
      const r = checkShape(entry, RECEIPT_SPEC, `receipt.json[${index}]`);
      // Identity, from the known sets. A receipt naming a client or candidate that is not in
      // the matrix belongs to no cell, so nothing would ever compare it — it could carry any
      // outcome at all and sit in a "verified" evidence set unexamined (round 2, chunk 12).
      if (!REAL_CLIENTS.includes(r.client)) refuse(`receipt.json[${index}] names unknown client '${r.client}'`);
      if (!["v1", "v2"].includes(r.candidate)) refuse(`receipt.json[${index}] names unknown candidate '${r.candidate}'`);
      if (seenIds.has(r.captureId)) {
        refuse(`receipt.json lists capture ${r.captureId} more than once — refusing to guess which is real`);
      }
      seenIds.add(r.captureId);
      if (!HEX64.test(r.manifestSha256)) refuse(`receipt.json[${index}].manifestSha256 is not a sha256 hex string`);
      // The provenance a receipt claims must be the provenance the evidence set claims. Neither
      // the receipt's nor the manifest's captureInputs were ever compared against
      // capture-inputs.json, so replacing that one file with today's digests made stale captures
      // read as current — the staleness check above was checking a file against itself.
      checkExactKeys(r.captureInputs, CAPTURE_INPUTS, `receipt.json[${index}].captureInputs`);
      for (const rel of CAPTURE_INPUTS) {
        if (r.captureInputs[rel] !== ci.files[rel]) {
          refuse(`receipt.json[${index}] was taken under a different ${rel} than capture-inputs.json pins`);
        }
      }
      // A receipt is a permission to have deleted the raw bytes, so one written by an older,
      // weaker verifier must not keep validating after the verifier is strengthened — the
      // evidence that would settle it is gone.
      if (r.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
        refuse(
          `receipt.json[${index}] was written under receipt schema '${r.schemaVersion}', ` +
            `not the current '${RECEIPT_SCHEMA_VERSION}' — recapture rather than trust it`,
        );
      }
      checkShape(r.reproduced, DIGEST_SET_SPEC, `receipt.json[${index}].reproduced`);
      for (const [k, v] of Object.entries(r.reproduced)) {
        if (!HEX64.test(v)) refuse(`receipt.json[${index}].reproduced.${k} is not a sha256 hex string`);
      }
      checkShape(
        r.rawStatistics,
        { clientToServer: { type: "object" }, serverStdout: { type: "object" } },
        `receipt.json[${index}].rawStatistics`,
      );
      for (const direction of ["clientToServer", "serverStdout"]) {
        checkShape(r.rawStatistics[direction], STREAM_STATS_SPEC, `receipt.json[${index}].rawStatistics.${direction}`);
      }
      return r;
    });
  }
  // Conditions under which a cell RAN and PASSED but proves less than an unqualified pass
  // claims. These are not cell statuses — a qualification cannot turn a pass into a fail, and
  // inventing a status for it would let this verifier overrule the classifier. What it can do
  // is refuse to let the qualification be dropped on the way to the decision document, which
  // is where an unconditional-looking "pass" was actually doing harm (review round 1, chunk 17).
  const qualifications = [];
  const consumedReceipts = new Set();
  for (const candidate of ["v1", "v2"]) {
    for (const client of REAL_CLIENTS) {
      if (captureInputsStale !== null) {
        cells[candidate][`real:${client}`] = {
          status: "not-run",
          cause: `capture input(s) ${captureInputsStale} changed since these captures were taken — recapture required`,
        };
        continue;
      }
      const rec = real?.[candidate]?.[client];
      if (rec === undefined) {
        cells[candidate][`real:${client}`] = { status: "not-run", cause: "no real-client capture recorded" };
        continue;
      }
      const what = `${candidate}/real:${client}`;
      checkShape(rec, CELL_SPEC, what);
      if (!STATUSES.includes(rec.status)) refuse(`${what} has invalid status '${rec.status}'`);

      // A cell with no attempts is a PREFLIGHT absence: the client binary was missing or did
      // not advertise the flags isolation needs, so nothing ran and there is nothing to
      // sanitize or receipt. It is accepted without a manifest, and the reason it is safe to
      // accept is an asymmetry worth stating: a not-run can only ever produce `incomplete`
      // (§1), so an editable not-run costs a recapture and can never buy an adoption. A pass
      // or a fail still needs its manifest, its receipt, and re-derivation from both.
      if (rec.attempts === undefined) {
        if (rec.status !== "not-run") refuse(`${what} records status '${rec.status}' with no capture attempts`);
        if (rec.cause === undefined) refuse(`${what} is a not-run with neither attempts nor a cause`);
        if (rec.traceDigest !== undefined) refuse(`${what} has no attempts but records a trace digest`);
        cells[candidate][`real:${client}`] = rec;
        continue;
      }
      if (!Array.isArray(rec.attempts) || rec.attempts.length === 0) {
        refuse(`${what} records an empty or malformed attempts list`);
      }
      if (rec.attempts.length > 2) refuse(`${what} records ${rec.attempts.length} attempts; the policy allows at most 2`);

      const manifestPath = join(evidenceDir, "real-clients", `${client}-${candidate}.manifest.json`);
      const manifest = checkShape(
        readJson(manifestPath, `${what} manifest`),
        MANIFEST_SPEC,
        `${what} manifest`,
      );
      if (manifest.client !== client || manifest.candidate !== candidate) {
        refuse(`${what} manifest names ${manifest.client}/${manifest.candidate}`);
      }
      checkShape(manifest.digests, DIGEST_SET_SPEC, `${what} manifest.digests`);
      for (const direction of ["clientToServer", "serverStdout"]) {
        checkShape(manifest[direction], STREAM_STATS_SPEC, `${what} manifest.${direction}`);
      }

      // The capture's own isolation facts, checked rather than carried as an opaque object.
      const iso = checkShape(
        manifest.isolation,
        { hostileConfigExecuted: { type: "boolean" }, userConfigIsolated: { type: "boolean" } },
        `${what} manifest.isolation`,
      );
      // A hostile config that actually executed is not a qualification, it is a broken capture:
      // whatever the client did afterwards was under someone else's instructions.
      if (iso.hostileConfigExecuted) {
        refuse(`${what} ran a hostile configuration — the capture is not evidence about the SDK`);
      }
      // The Codex asymmetry: Claude Code accepts --strict-mcp-config plus --settings, so its
      // user configuration is provably out of the run; `codex exec -c` has no equivalent, so
      // those cells ran with the operator's own configuration reachable.
      //
      // Until review round 12 this was a QUALIFICATION and the cell stayed a mandatory pass.
      // That made §9's isolation requirement unenforceable, and measurably so: qualifications
      // reach DECISION.md prose (decide.mjs renderDecisionDoc) and never enter decide()'s
      // aggregate, so two cells that did not meet the isolation the plan requires still counted
      // as mandatory passes and could certify adopt-v2, with the shortfall demoted to a
      // paragraph a reader has to notice. Prose is not a gate; a qualification a reader must
      // act on is an unenforced invariant with better manners (ISS-047, plan §14.2).
      //
      // So a capture that did not isolate is `not-run` with an infrastructure cause, which
      // dominates to `incomplete` (§1) and can never buy an adoption. The downgrade is applied
      // to the PUBLISHED cell at the end of this block rather than here, deliberately: every
      // check below — receipt matching, manifest binding, re-derivation — still has to run and
      // still has to agree with the recorded status, or a non-isolated capture would become a
      // way to skip validation rather than a way to fail it.
      //
      // Fail-closed is the deliberate direction: it is the only one that cannot silently
      // certify something untrue. Whether the TICKET should accept qualified non-isolated Codex
      // evidence is an owner decision, not a review call — Codex offers no mechanism the
      // harness can use, so refusing it means this gate reaches no verdict on Codex at all, and
      // that is a contract change (plan §14.2).
      const notIsolated = !iso.userConfigIsolated;

      // Every attempt is receipted, including a superseded environmental one — the retry used
      // to discard its predecessor, leaving a receipt with nowhere to belong and an attempt
      // that committed evidence never mentioned.
      const matching = receipts.filter((r) => r.client === client && r.candidate === candidate);
      for (const r of matching) consumedReceipts.add(r.captureId);
      const attemptIds = rec.attempts.map((a) => a.captureId);
      if (JSON.stringify([...matching.map((r) => r.captureId)].sort()) !== JSON.stringify([...attemptIds].sort())) {
        refuse(`${what} receipts [${matching.map((r) => r.captureId).join(", ")}] do not match its attempts [${attemptIds.join(", ")}]`);
      }
      for (const attempt of rec.attempts) {
        const entry = matching.find((r) => r.captureId === attempt.captureId);
        if (entry.outcome !== attempt.outcome) {
          refuse(`${what} attempt ${attempt.captureId} records outcome '${attempt.outcome}' but its receipt says '${entry.outcome}'`);
        }
      }
      const finalId = attemptIds[attemptIds.length - 1];
      if (finalId !== manifest.captureId) {
        refuse(`${what} committed manifest is ${manifest.captureId}, which is not the final attempt ${finalId}`);
      }
      const receipt = matching.find((r) => r.captureId === finalId);
      if (JSON.stringify(receipt.reproduced) !== JSON.stringify(manifest.digests)) {
        refuse(`${what} receipt digests disagree with the manifest — the derivation was not reproduced`);
      }
      // THE MANIFEST ITSELF, bound to the receipt. Everything above compares two editable
      // records to each other, and the digests they agree on describe raw streams that were
      // deleted — so an editor who changed the manifest's frames, its stdout predicates, its
      // isolation flags and the matching cell status left every one of those comparisons
      // satisfied, and `classify()` then re-derived a status from the edited assertions. The
      // receipt records the digest of the manifest it sanitized, taken while the bytes still
      // existed, and the committed file has to be that file (round 2, chunk 12).
      if (sha256(manifestBytes) !== receipt.manifestSha256) {
        refuse(`${what} committed manifest is not the file its receipt was written for — it has been edited since`);
      }
      // An independent cross-check of the same counters from the other record.
      for (const direction of ["clientToServer", "serverStdout"]) {
        if (JSON.stringify(receipt.rawStatistics[direction]) !== JSON.stringify(manifest[direction])) {
          refuse(`${what} receipt ${direction} statistics disagree with the manifest`);
        }
      }
      // The manifest's own provenance pins, against the evidence set's.
      checkExactKeys(manifest.captureInputs, CAPTURE_INPUTS, `${what} manifest.captureInputs`);
      for (const rel of CAPTURE_INPUTS) {
        if (manifest.captureInputs[rel] !== ci.files[rel]) {
          refuse(`${what} manifest was captured under a different ${rel} than capture-inputs.json pins`);
        }
      }
      // The dependency tree the server ran from. Checking it against the installed tree needs a
      // working tree and belongs to the receipt; what is checkable offline is that every record
      // of this candidate names the SAME tree, so a set assembled from two different installs
      // cannot be published as one comparison.
      for (const entry of matching) {
        if (entry.candidateTreeSha256 !== receipt.candidateTreeSha256) {
          refuse(`${what} attempts were taken against different ${candidate} dependency trees`);
        }
      }
      if (manifest.candidateTreeSha256 !== receipt.candidateTreeSha256) {
        refuse(`${what} manifest names a different ${candidate} dependency tree than its receipt`);
      }

      // The recomputation: classifier over the sanitized record, against the committed
      // template hash and the manifest's own recorded nonce (whose binding to the prompt is
      // separately checked by the classifier's frame clauses).
      // A record the classifier cannot judge is a refusal, not an outcome: InvalidRecordError
      // must never escape as an unhandled crash, and must never be read as "not-run".
      let derived;
      try {
        derived = toCellStatus(
          classify(manifest, {
            promptSha256: PROMPT_TEMPLATE_SHA256,
            // Recomputed here from the committed template and the manifest's own nonce, so the
            // prompt the client actually received is checked and not merely the template it
            // was supposed to come from.
            promptInstanceSha256: sha256(Buffer.from(PROMPT_TEMPLATE.replace("{{NONCE}}", manifest.nonce), "utf8")),
            nonce: manifest.nonce,
            completionMarker: COMPLETION_MARKER,
          }).outcome,
        );
      } catch (error) {
        if (!(error instanceof InvalidRecordError)) throw error;
        refuse(`${what} manifest is not usable evidence: ${error.message}`);
      }
      if (derived !== rec.status) {
        refuse(`${what} records status '${rec.status}' but the manifest re-derives '${derived}'`);
      }
      if (rec.status !== "not-run") {
        if (rec.traceDigest === undefined || rec.clientVersion === undefined) {
          refuse(`${what} ran but records no traceDigest/clientVersion`);
        }
      }
      if (rec.traceDigest !== undefined && rec.traceDigest !== manifest.digests.derivationDigest) {
        refuse(`${what} traceDigest does not equal the manifest's derivationDigest`);
      }
      if (rec.clientVersion !== undefined && rec.clientVersion !== manifest.clientVersion) {
        refuse(`${what} clientVersion disagrees with the manifest`);
      }
      // Every real-client cell that RAN carries this, and it is not a defect in the cell — it
      // is the shape of the evidence. The candidate server in a real-client capture is spawned
      // by the tee wrapper without a resolution log, so nothing enumerates where its module
      // closure actually resolved from; that guarantee comes from the scripted cells, which run
      // the same server bytes from the same assembled root with the instrument loaded. Saying
      // so on every real pass is the difference between a reader knowing which cells prove
      // isolation and a reader assuming all of them do (review round 2, chunk 5).
      //
      // The published cell, which is where the isolation downgrade lands (see above). Every
      // check between there and here has already run against the RECORDED status, so this
      // changes what the evidence is allowed to certify, not what it was allowed to skip.
      const published = notIsolated
        ? {
            status: "not-run",
            cause:
              `${client} ran without a supported user-configuration isolation mechanism, so this ` +
              `capture observed the operator's own configuration rather than a fresh state — it is ` +
              `not evidence about the SDK and cannot count toward an adoption (ISS-047)`,
          }
        : rec;
      // Keyed off the PUBLISHED status, not the recorded one: a cell downgraded to not-run did
      // not contribute a pass, so annotating it as a qualified pass would describe a cell the
      // decision never used.
      if (published.status !== "not-run") {
        qualifications.push({
          candidate,
          cell: `real:${client}`,
          kind: "resolutions-not-audited",
          detail:
            "the candidate server ran here without resolution instrumentation; module-closure " +
            "isolation for these bytes is established by the scripted cells, not by this one",
        });
      }
      cells[candidate][`real:${client}`] = published;
    }
  }

  // Every receipt has to belong to a cell that was verified. A receipt nothing consumed is a
  // permission to have deleted raw bytes that no cell accounts for — either a superseded
  // generation left behind, or an entry added by hand (round 2, chunk 12).
  if (receipts !== null) {
    const orphans = receipts.map((r) => r.captureId).filter((id) => !consumedReceipts.has(id));
    if (orphans.length) {
      refuse(`real-clients/receipt.json holds receipt(s) no cell claims: ${orphans.sort().join(", ")}`);
    }
  }

  // 6. The mandatory set itself, asserted against the literal.
  for (const candidate of ["v1", "v2"]) {
    const have = Object.keys(cells[candidate]).sort();
    if (JSON.stringify(have) !== JSON.stringify([...MANDATORY_CELLS].sort())) {
      refuse(`${candidate} cell set [${have.join(", ")}] does not equal the mandatory set`);
    }
  }

  return {
    cells,
    sdk: { v1: scripted.v1.sdk, v2: scripted.v2.sdk },
    versions: { v1: scripted.v1.sdkVersion, v2: scripted.v2.sdkVersion },
    report: {
      closureSize: { v1: supplyChain.v1.packages, v2: supplyChain.v2.packages },
      tokenCost: {
        proxyVersion: tokenCost.proxyVersion,
        v1: tokenCost.v1,
        v2: tokenCost.v2,
      },
      audit,
      notes: inputs.notes ?? [],
      qualifications,
    },
  };
}

/** The three outcome artifacts Act 1 writes, by filename inside the evidence directory. */
export const OUTCOME_ARTIFACTS = {
  decisionDoc: "DECISION.md",
  decisionRecord: "decision.json",
  attemptReport: "attempt-report.json",
};

/**
 * Does the repository's RECORDED outcome still describe its evidence?
 *
 * This is a second, separate question from the one `verifyEvidence()` answers, and review round
 * 11 was right that they cannot be the same function. `verifyEvidence()` validates INPUTS and is
 * what the gate consumes BEFORE Act 1 writes, replaces or removes these artifacts; folding the
 * artifact check into it would refuse a first run (nothing written yet), a run whose verdict
 * legitimately changed, and an `incomplete` run still carrying the previous run's files — a
 * producer gated on its own output. So: `verifyEvidence()` knows nothing about these three
 * files, and this function, which never writes, is what `verify:real-client-evidence` and
 * therefore `test:all` run.
 *
 * Why it exists at all: the repository reached the state §1 declares impossible, and nothing
 * noticed. decide(verifyEvidence()) derived `incomplete` (four stale captures, every mandatory
 * real-client cell degraded to not-run) while the committed decision.json and DECISION.md both
 * declared `adopt-v2`, and `verify:real-client-evidence` exited 0 over it — a guard reporting
 * success while having observed nothing, at the top of the gate, in the check whose whole job
 * was to catch exactly this. §10's packaging smoke test reads that same stale decision.json to
 * decide whether to skip.
 *
 * The comparison is REGENERATION, not outcome-equality. "The document names the same outcome
 * the evidence implies" is far too weak: an adopt-v2 document survives changed cells, changed
 * candidate versions, changed qualifications and a changed body so long as the newly derived
 * outcome is also adopt-v2 — which is to say the stale artifact this exists to catch would
 * pass. Every artifact is regenerated from the CURRENT verified result, through the same
 * generators Act 1 writes with, and compared byte for byte.
 */
export function verifyRecordedOutcome({ evidenceDir = EVIDENCE_DIR, repoRoot = join(HERE, "..", "..") } = {}) {
  const verified = verifyEvidence({ evidenceDir, repoRoot });
  const decision = decide(verified);
  checkOutcomeArtifacts(verified, decision, (name) => {
    const path = join(evidenceDir, name);
    return existsSync(path) ? readFileSync(path) : null;
  });
  return { verified, decision };
}

/**
 * The comparison itself, as a pure function over an injected reader — `read(name)` returns the
 * artifact's bytes as a Buffer, or null when it is absent.
 *
 * Injected rather than reading the filesystem directly for a reason that is about coverage, not
 * tidiness: the verdict branch is unreachable from any fixture built out of the committed
 * evidence, because that evidence derives `incomplete`. A comparison welded to the filesystem
 * could therefore only ever have half of itself tested, and the untested half is the one that
 * decides whether an adoption is honest.
 */
export function checkOutcomeArtifacts(verified, decision, read) {
  const requireAbsent = (name, why) => {
    if (read(name) !== null) refuse(`${name} is present, but ${why}`);
  };
  const requireIdentical = (name, expected) => {
    const actual = read(name);
    if (actual === null) refuse(`${name} is missing, but the derived outcome is '${decision.outcome}'`);
    const want = Buffer.from(expected, "utf8");
    if (!actual.equals(want)) {
      // The outcome is named on both sides deliberately: the common failure is a committed
      // artifact whose outcome still matches while its body no longer describes the evidence,
      // and a message that only said "does not match" would read as a formatting complaint.
      refuse(
        `${name} does not match the artifact regenerated from the current evidence ` +
          `(derived outcome '${decision.outcome}', committed ${actual.length} bytes, regenerated ${want.length}) — ` +
          `the recorded decision no longer describes the evidence it was generated from`,
      );
    }
  };

  if (decision.outcome === "incomplete") {
    // §1: a run that reached no verdict has no decision to record. Both must be absent, or an
    // older verdict stays visible to packaging.
    requireAbsent(OUTCOME_ARTIFACTS.decisionDoc, "the derived outcome is 'incomplete' — no verdict was reached");
    requireAbsent(OUTCOME_ARTIFACTS.decisionRecord, "the derived outcome is 'incomplete' — no verdict was reached");
    // Byte-identical, not merely present and naming a cause: "present with a cause" is satisfied
    // by a stale report from an earlier run and by a hand-written one.
    requireIdentical(OUTCOME_ARTIFACTS.attemptReport, serializeJsonArtifact(renderAttemptReport(verified)));
  } else {
    requireAbsent(
      OUTCOME_ARTIFACTS.attemptReport,
      `the derived outcome is '${decision.outcome}' — an attempt report belongs only to 'incomplete'`,
    );
    requireIdentical(OUTCOME_ARTIFACTS.decisionDoc, renderDecisionDoc(verified, decision));
    requireIdentical(
      OUTCOME_ARTIFACTS.decisionRecord,
      serializeJsonArtifact(renderDecisionRecord(verified, decision)),
    );
  }
}

async function main() {
  try {
    const { verified } = verifyRecordedOutcome();
    process.stdout.write(JSON.stringify(verified, null, 2) + "\n");
  } catch (error) {
    if (error instanceof EvidenceError) {
      process.stderr.write(`evidence INVALID: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}

if (isDirectEntry(import.meta.url)) {
  await main();
}
