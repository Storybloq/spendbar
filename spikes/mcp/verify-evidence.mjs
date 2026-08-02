#!/usr/bin/env node
// The independent evidence verifier (plan §6): derives every decision input from recorded
// evidence plus recomputed repository-side facts, and REFUSES rather than repairs.
//
// What it rejects, by design:
//   * a repository-side input whose digest no longer matches the recorded one — evidence
//     captured against different bytes proves nothing about these bytes (the one-byte probe
//     mutation test exists to prove this rejection fires);
//   * missing, duplicate, unknown, or manually-supplied cells and fields — the mandatory set
//     is a literal, and a cell record carries exactly its declared fields;
//   * isolation evidence that is broken or absent — scripted results from a root that
//     resolved outside itself are not evidence about the SDK;
//   * supply-chain evidence with violations — the no-hooks precondition of the whole gate.
//
// Absent REAL-CLIENT evidence is different: those cells become `not-run` with a recorded
// cause, because "never captured" must surface as `incomplete` at the decision layer, loudly —
// not as a verifier crash and not as a silent pass.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SCRIPTED_CASES, REAL_CLIENTS, MANDATORY_CELLS, STATUSES } from "./decide.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_DIR = join(HERE, "evidence");

// The repository-side inputs the evidence is bound to. Adding a file that shapes the evidence
// without listing it here is the drift this list exists to prevent.
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
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export class EvidenceError extends Error {}
const refuse = (msg) => {
  throw new EvidenceError(msg);
};

function readJson(path, what) {
  if (!existsSync(path)) refuse(`${what} is absent (${path})`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    refuse(`${what} is unreadable: ${error.message}`);
  }
}

/** A record may carry exactly the declared fields — extras are manually-supplied by definition. */
function checkFields(record, allowed, what) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    refuse(`${what} is not an object`);
  }
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) refuse(`${what} carries unknown field '${key}'`);
  }
  if (!STATUSES.includes(record.status)) refuse(`${what} has invalid status '${record.status}'`);
}

export function verifyEvidence({ evidenceDir = EVIDENCE_DIR, repoRoot = join(HERE, "..", "..") } = {}) {
  const inputs = readJson(join(evidenceDir, "inputs.json"), "inputs.json");
  const scripted = readJson(join(evidenceDir, "scripted.json"), "scripted.json");
  const supplyChain = readJson(join(evidenceDir, "supply-chain.json"), "supply-chain.json");
  const tokenCost = readJson(join(evidenceDir, "token-cost.json"), "token-cost.json");
  const audit = readJson(join(evidenceDir, "audit.json"), "audit.json");

  // 1. Repository-side inputs, recomputed — never trusted from the record alone.
  const boundRecorded = inputs.files ?? {};
  const recordedPaths = Object.keys(boundRecorded).sort();
  if (JSON.stringify(recordedPaths) !== JSON.stringify([...BOUND_INPUTS].sort())) {
    refuse(
      `inputs.json binds [${recordedPaths.join(", ")}] but the verifier expects exactly [${[...BOUND_INPUTS].sort().join(", ")}]`,
    );
  }
  for (const rel of BOUND_INPUTS) {
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

  // 2. Scripted evidence: exactly the literal case set per candidate, valid statuses,
  //    unbroken isolation.
  const cells = { v1: {}, v2: {} };
  for (const candidate of ["v1", "v2"]) {
    const rec = scripted[candidate] ?? refuse(`scripted.json has no ${candidate} record`);
    const caseNames = Object.keys(rec.cases ?? {});
    for (const name of caseNames) {
      if (!SCRIPTED_CASES.includes(name)) refuse(`${candidate} records unknown case '${name}'`);
    }
    for (const name of SCRIPTED_CASES) {
      if (!caseNames.includes(name)) refuse(`${candidate} is missing case '${name}'`);
      checkFields(rec.cases[name], ["status", "detail"], `${candidate}/${name}`);
      cells[candidate][`scripted:${name}`] = rec.cases[name];
    }
    const iso = rec.isolation ?? refuse(`${candidate} has no isolation evidence`);
    if (!iso.ok || (iso.violations ?? []).length > 0 || iso.oppositeSdkProbe !== "not-found") {
      refuse(`${candidate} isolation is broken — its scripted results prove nothing about the SDK`);
    }
    if (!(iso.resolutionsTotal > 0)) refuse(`${candidate} isolation enumerated zero resolutions`);

    const sc = supplyChain[candidate] ?? refuse(`supply-chain.json has no ${candidate} record`);
    if ((sc.violations ?? []).length > 0) {
      refuse(`${candidate} supply chain has violations — the no-hooks precondition fails`);
    }
    if (!(sc.packages > 0) || sc.verified !== sc.packages) {
      refuse(`${candidate} supply chain did not verify its whole closure (${sc.verified}/${sc.packages})`);
    }
  }

  // 3. Real-client cells: recorded typed outcomes, or not-run with a cause when no capture
  //    exists. Absence is loud (it forces `incomplete`), never a crash and never a pass.
  const realPath = join(evidenceDir, "real-clients", "cells.json");
  const real = existsSync(realPath) ? readJson(realPath, "real-clients/cells.json") : null;
  for (const candidate of ["v1", "v2"]) {
    for (const client of REAL_CLIENTS) {
      const rec = real?.[candidate]?.[client];
      if (rec === undefined) {
        cells[candidate][`real:${client}`] = { status: "not-run", cause: "no real-client capture recorded" };
      } else {
        checkFields(rec, ["status", "cause", "detail", "traceDigest", "clientVersion"], `${candidate}/real:${client}`);
        cells[candidate][`real:${client}`] = rec;
      }
    }
  }

  // 4. The mandatory set itself, asserted against the literal.
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
