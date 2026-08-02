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

import { SCRIPTED_CASES, REAL_CLIENTS, MANDATORY_CELLS, STATUSES } from "./decide.mjs";
import { parseStrictJson, JsonSyntaxError } from "./strict-json.mjs";
import { classify, toCellStatus } from "./real-client/classify.mjs";
import { PROMPT_TEMPLATE_SHA256, COMPLETION_MARKER } from "./real-client/capture.mjs";
import { TOKEN_PROXY_VERSION } from "./token-cost.mjs";

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
  "spikes/mcp/candidates/v1/package-lock.json",
  "spikes/mcp/candidates/v2/package-lock.json",
  "spikes/mcp/conformance.mjs",
  "spikes/mcp/isolate.mjs",
  "spikes/mcp/instrument.mjs",
  "spikes/mcp/instrument-hooks.mjs",
  "spikes/mcp/token-cost.mjs",
  "spikes/mcp/supply-chain.mjs",
  "spikes/mcp/real-client/capture.mjs",
  "spikes/mcp/real-client/capture-wrapper.mjs",
  "spikes/mcp/real-client/classify.mjs",
  "spikes/mcp/real-client/normalize.mjs",
  "spikes/mcp/real-client/sanitize.mjs",
  "spikes/mcp/real-client/receipt.mjs",
];

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
    if (!(key in spec)) refuse(`${what} carries unknown field '${key}'`);
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
};

// The sanitized capture manifest, exactly as sanitize.mjs's FIELD_MAP emits it. The verifier
// re-derives the cell status from this record, so its shape is load-bearing.
const MANIFEST_SPEC = {
  captureId: { type: "string" },
  client: { type: "string" },
  candidate: { type: "string" },
  clientVersion: { type: "string" },
  promptSha256: { type: "string" },
  nonce: { type: "string" },
  executablePath: { type: "string" },
  executableIdentity: { type: "string" },
  commandLine: { type: "array" },
  env: { type: "array" },
  cwd: { type: "string" },
  spawn: { type: "object" },
  environmental: { type: "object", nullable: true },
  timedOut: { type: "boolean" },
  lastPhase: { type: "string" },
  clientExit: { type: "object", nullable: true },
  serverTermination: { type: "object", nullable: true },
  frames: { type: "array" },
  serverStdout: { type: "object", optional: true, nullable: true },
  serverStderr: { type: "object", optional: true, nullable: true },
  clientStdout: { type: "object", optional: true, nullable: true },
  digests: { type: "object" },
  retries: { type: "array" },
};

const RECEIPT_SPEC = {
  captureId: { type: "string" },
  client: { type: "string" },
  candidate: { type: "string" },
  reproduced: { type: "object" },
  rawStatistics: { type: "object" },
  note: { type: "string", optional: true },
};

const DIGEST_SET_SPEC = {
  clientToServerSha256: { type: "string" },
  serverStdoutSha256: { type: "string" },
  serverStderrSha256: { type: "string" },
  derivationDigest: { type: "string" },
};

export function verifyEvidence({ evidenceDir = EVIDENCE_DIR, repoRoot = join(HERE, "..", "..") } = {}) {
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
        failed: { type: "number" },
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
        resolutionsTotal: { type: "number" },
        builtins: { type: "number" },
        insidePrefix: { type: "number" },
        violations: { type: "array" },
        perCase: { type: "object" },
        everyCaseInstrumented: { type: "boolean" },
        oppositeSdkProbe: { type: "string" },
        ok: { type: "boolean" },
      },
      `scripted.json ${candidate}.isolation`,
    );
    if (!iso.ok || iso.violations.length > 0 || iso.oppositeSdkProbe !== "not-found" || !iso.everyCaseInstrumented) {
      refuse(`${candidate} isolation is broken — its scripted results prove nothing about the SDK`);
    }
    if (!(iso.resolutionsTotal > 0)) refuse(`${candidate} isolation enumerated zero resolutions`);
    checkExactKeys(iso.perCase, SCRIPTED_CASES, `scripted.json ${candidate}.isolation.perCase`);
    const failingCases = SCRIPTED_CASES.filter((name) => rec.cases[name].status === "fail").length;
    if (rec.failed !== failingCases) {
      refuse(`${candidate} records failed=${rec.failed} but ${failingCases} cases fail — inconsistent`);
    }

    const sc = checkShape(
      supplyChain[candidate],
      { packages: { type: "number" }, verified: { type: "number" }, violations: { type: "array" } },
      `supply-chain.json ${candidate}`,
    );
    if (sc.violations.length > 0) {
      refuse(`${candidate} supply chain has violations — the no-hooks precondition fails`);
    }
    if (!(sc.packages > 0) || sc.verified !== sc.packages) {
      refuse(`${candidate} supply chain did not verify its whole closure (${sc.verified}/${sc.packages})`);
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
      { canonicalBytes: { type: "number" }, proxyTokens: { type: "number" }, fields: { type: "array" } },
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
        { advisoriesTotal: { type: "number" }, ran: { type: "boolean" }, vulnerabilities: { type: "object" } },
        `audit.json ${candidate}`,
      );
      checkShape(
        a.vulnerabilities,
        {
          critical: { type: "number" },
          high: { type: "number" },
          info: { type: "number" },
          low: { type: "number" },
          moderate: { type: "number" },
          total: { type: "number" },
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
  if (real !== null) {
    checkExactKeys(real, ["v1", "v2"], "real-clients/cells.json");
    const receiptRaw = readJson(join(evidenceDir, "real-clients", "receipt.json"), "real-clients/receipt.json");
    if (!Array.isArray(receiptRaw)) refuse("real-clients/receipt.json is not an array");
    receipts = receiptRaw.map((entry, index) => {
      const r = checkShape(entry, RECEIPT_SPEC, `receipt.json[${index}]`);
      checkShape(r.reproduced, DIGEST_SET_SPEC, `receipt.json[${index}].reproduced`);
      for (const [k, v] of Object.entries(r.reproduced)) {
        if (!HEX64.test(v)) refuse(`receipt.json[${index}].reproduced.${k} is not a sha256 hex string`);
      }
      checkShape(
        r.rawStatistics,
        { bytes: { type: "number" }, remainder: { type: "number" }, parseErrors: { type: "number" } },
        `receipt.json[${index}].rawStatistics`,
      );
      return r;
    });
  }
  for (const candidate of ["v1", "v2"]) {
    for (const client of REAL_CLIENTS) {
      const rec = real?.[candidate]?.[client];
      if (rec === undefined) {
        cells[candidate][`real:${client}`] = { status: "not-run", cause: "no real-client capture recorded" };
        continue;
      }
      const what = `${candidate}/real:${client}`;
      checkShape(rec, CELL_SPEC, what);
      if (!STATUSES.includes(rec.status)) refuse(`${what} has invalid status '${rec.status}'`);

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

      const matching = receipts.filter((r) => r.client === client && r.candidate === candidate);
      if (matching.length !== 1) {
        refuse(`${what} has ${matching.length} receipt entries, expected exactly 1`);
      }
      const receipt = matching[0];
      if (receipt.captureId !== manifest.captureId) {
        refuse(`${what} receipt captureId ${receipt.captureId} != manifest ${manifest.captureId}`);
      }
      if (JSON.stringify(receipt.reproduced) !== JSON.stringify(manifest.digests)) {
        refuse(`${what} receipt digests disagree with the manifest — the derivation was not reproduced`);
      }

      // The recomputation: classifier over the sanitized record, against the committed
      // template hash and the manifest's own recorded nonce (whose binding to the prompt is
      // separately checked by the classifier's frame clauses).
      const derived = toCellStatus(
        classify(manifest, {
          promptSha256: PROMPT_TEMPLATE_SHA256,
          nonce: manifest.nonce,
          completionMarker: COMPLETION_MARKER,
        }).outcome,
      );
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
      cells[candidate][`real:${client}`] = rec;
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
    },
  };
}

async function main() {
  try {
    const verified = verifyEvidence();
    process.stdout.write(JSON.stringify(verified, null, 2) + "\n");
  } catch (error) {
    if (error instanceof EvidenceError) {
      process.stderr.write(`evidence INVALID: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
