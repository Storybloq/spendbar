#!/usr/bin/env node
// The scripted-evidence orchestrator (plan §5/§6/§8): runs every stage for BOTH candidates
// with no short-circuiting — a failure is recorded as evidence and ends nothing except its own
// stage — and publishes the committed evidence files the verifier consumes.
//
// Stage order per candidate: supply-chain fetch+verify (§3), a FRESH `npm ci
// --ignore-scripts` install of the verified lockfile, a by-path rescan of the installed tree
// (step 4 — the tree the cases actually execute against, not whatever node_modules happened
// to exist; review round 1), npm audit (recorded, not gating), the eight scripted conformance
// cases with isolation enumeration (§5/§2), token measurement (§7 — measurement only).
// Before any of it: the T-024 privacy scan in audit mode over HEAD (§8).
//
// Run integrity (review round 1):
//   * bound-input digests are captured BEFORE any stage and re-checked before publishing —
//     results produced from old bytes are never bound to new bytes;
//   * an attempt marker (matrix-attempt.json) exists from first stage to successful publish;
//     the verifier refuses evidence while it is present, so a crashed or failed run can
//     never leave an older generation silently consumable;
//   * publication is staged: every file is written aside and renamed into place only after
//     the whole generation validated.
//
// Exit codes: 0 all stages ran and every case passed; 1 all stages ran, something failed
// (still fully recorded); 2 a stage could not run — typed causes in the marker, nothing
// published.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Harness, initialize, runCandidate } from "./conformance.mjs";
import { inspectClosure, scanInstalledTree } from "./supply-chain.mjs";
import { measureToolDefinition, sortDeep } from "./token-cost.mjs";
import { SCRIPTED_CASES } from "./decide.mjs";
import { BOUND_INPUTS, EVIDENCE_DIR } from "./verify-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const MARKER = join(EVIDENCE_DIR, "matrix-attempt.json");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Argument-capture pattern (same as the packaging contract): the array is the single source
// of truth, asserted before use — a refactor dropping --ignore-scripts fails here, loudly.
const INSTALL_ARGS = ["ci", "--ignore-scripts"];

function computeBoundDigests() {
  const files = {};
  for (const rel of BOUND_INPUTS) files[rel] = sha256(readFileSync(join(REPO, rel)));
  return files;
}

/** §8: the privacy audit over HEAD is the first preflight, and it must actually run. */
function preflightPrivacyAudit() {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "privacy-scan.mjs"), "--mode=audit"], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    process.stderr.write(r.stderr + r.stdout);
    throw new Error(`privacy audit preflight ${r.status === 1 ? "found personal data at HEAD" : "could not run"}`);
  }
}

/** Fresh install of the verified lockfile — `npm ci` removes any existing node_modules, so
 *  the tree the cases run against corresponds to the tarballs §3 just verified. */
function installCandidate(candidate) {
  if (!INSTALL_ARGS.includes("--ignore-scripts")) {
    throw new Error("INSTALL_ARGS lost --ignore-scripts — refusing to install");
  }
  const r = spawnSync("npm", INSTALL_ARGS, {
    cwd: join(HERE, "candidates", candidate),
    encoding: "utf8",
    timeout: 300_000,
  });
  if (r.status !== 0) {
    throw new Error(`npm ${INSTALL_ARGS.join(" ")} failed for ${candidate}: ${(r.stderr || "").slice(0, 500)}`);
  }
  return { args: [...INSTALL_ARGS], ok: true };
}

/** npm audit per workspace — recorded as evidence, never gating (§2). */
function recordAudit(candidate) {
  const r = spawnSync("npm", ["audit", "--json"], {
    cwd: join(HERE, "candidates", candidate),
    encoding: "utf8",
    timeout: 120_000,
  });
  try {
    const parsed = JSON.parse(r.stdout);
    const meta = parsed.metadata?.vulnerabilities ?? {};
    return { ran: true, vulnerabilities: meta, advisoriesTotal: Object.values(meta).reduce((a, b) => a + b, 0) };
  } catch {
    // The registry audit endpoint being unreachable is a recorded fact, not a crash — audit
    // is advisory evidence, and pretending it ran would be worse than saying it did not.
    return { ran: false, cause: (r.stderr || "npm audit produced no parseable output").slice(0, 300) };
  }
}

/** Measure the probe tool definition as each SDK actually lists it (§7) — through the
 *  conformance Harness, so stream caps, error handling and awaited disposal come along
 *  instead of being re-implemented wrong (review round 1). */
async function measureListedTool(candidate) {
  const { assembleCandidateRoot, buildServerEnv } = await import("./isolate.mjs");
  const { root, resolveLog, cleanup } = assembleCandidateRoot(candidate);
  let h = null;
  try {
    h = new Harness(
      spawn(process.execPath, ["server.mjs"], {
        cwd: root,
        env: buildServerEnv({ resolveLog }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    await initialize(h);
    const listed = await h.request(2, "tools/list");
    const tool = (listed.result?.tools ?? []).find((t) => t.name === "spendbar_probe");
    if (!tool) throw new Error(`${candidate}: probe tool absent from tools/list during measurement`);
    return measureToolDefinition(tool);
  } finally {
    if (h) await h.dispose(); // fully closed BEFORE the root is removed
    cleanup();
  }
}

async function main() {
  preflightPrivacyAudit();
  process.stderr.write("preflight: privacy audit over HEAD is green\n");

  const digestsBefore = computeBoundDigests();
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(MARKER, JSON.stringify({ status: "in-progress", startedAt: new Date().toISOString() }, null, 2) + "\n");

  const scripted = {};
  const supplyChain = {};
  const audit = {};
  const tokenCost = { proxyVersion: null };
  const stageFailures = [];
  let anyFailed = false;

  // Every stage of every candidate runs; a throw becomes a typed failure record and the walk
  // continues — an independently runnable candidate must not lose its evidence to a
  // sibling's (or an earlier stage's) crash (review round 1).
  const stage = async (candidate, name, fn) => {
    try {
      return await fn();
    } catch (error) {
      stageFailures.push({ candidate, stage: name, cause: String(error?.message ?? error) });
      return null;
    }
  };

  for (const candidate of ["v1", "v2"]) {
    const lockfile = join(HERE, "candidates", candidate, "package-lock.json");
    const inspected = await stage(candidate, "supply-chain", () => inspectClosure(lockfile));
    if (inspected) {
      process.stderr.write(
        `${candidate}: supply chain ${inspected.verified}/${inspected.packages} verified, ` +
          `${inspected.violations.length} violations\n`,
      );
    }

    // Install + rescan only make sense over a clean inspection; their absence is a recorded
    // stage failure either way, never a silent skip.
    const install = inspected
      ? await stage(candidate, "install", () => installCandidate(candidate))
      : (stageFailures.push({ candidate, stage: "install", cause: "not run: supply-chain inspection failed" }), null);
    const rescan = install
      ? await stage(candidate, "installed-rescan", () => scanInstalledTree(join(HERE, "candidates", candidate)))
      : (stageFailures.push({ candidate, stage: "installed-rescan", cause: "not run: install failed" }), null);
    if (rescan) {
      process.stderr.write(`${candidate}: installed rescan ${rescan.packagesScanned} packages, ${rescan.violations.length} violations\n`);
    }
    if (inspected && install && rescan) {
      supplyChain[candidate] = { ...inspected, install, installedRescan: rescan };
      anyFailed ||= inspected.violations.length > 0 || rescan.violations.length > 0;
    }

    const auditRec = await stage(candidate, "audit", () => recordAudit(candidate));
    if (auditRec) {
      audit[candidate] = auditRec;
      process.stderr.write(
        `${candidate}: audit ${auditRec.ran ? `ran (${auditRec.advisoriesTotal} advisories)` : "did not run — recorded"}\n`,
      );
    }

    const conf = await stage(candidate, "conformance", () => runCandidate(candidate));
    if (conf) {
      scripted[candidate] = conf;
      anyFailed ||= conf.failed > 0;
      process.stderr.write(
        `${candidate}: ${Object.values(conf.cases).filter((c) => c.status === "pass").length}/${SCRIPTED_CASES.length} scripted cases, ` +
          `isolation ${conf.isolation.ok ? "ok" : "BROKEN"}\n`,
      );
    }

    const measured = await stage(candidate, "token-measure", () => measureListedTool(candidate));
    if (measured) {
      tokenCost.proxyVersion = measured.proxyVersion;
      tokenCost[candidate] = {
        canonicalBytes: measured.canonicalBytes,
        proxyTokens: measured.proxyTokens,
        fields: measured.fields,
      };
      process.stderr.write(`${candidate}: tool definition ${measured.canonicalBytes}B / ${measured.proxyTokens} proxy tokens\n`);
    }
  }

  // Bound inputs must not have changed while the stages ran.
  const digestsAfter = computeBoundDigests();
  if (JSON.stringify(digestsBefore) !== JSON.stringify(digestsAfter)) {
    stageFailures.push({ candidate: "both", stage: "digest-stability", cause: "bound inputs changed during the run" });
  }

  if (stageFailures.length > 0) {
    // Nothing publishes. The marker becomes the typed attempt record, and its presence keeps
    // the verifier from consuming whatever older generation is still on disk.
    writeFileSync(
      MARKER,
      JSON.stringify({ status: "failed", startedAt: new Date().toISOString(), failures: stageFailures }, null, 2) + "\n",
    );
    for (const f of stageFailures) process.stderr.write(`STAGE FAILED ${f.candidate}/${f.stage}: ${f.cause}\n`);
    process.stderr.write(`matrix: ${stageFailures.length} stage(s) could not run — nothing published\n`);
    process.exit(2);
  }

  // Staged publication: write the whole generation aside, then rename into place.
  const generation = {
    "inputs.json": {
      caseList: SCRIPTED_CASES,
      files: digestsBefore,
      notes: [
        "v1 (@modelcontextprotocol/sdk 1.30.0) ships no dist/{esm,cjs}/index.js: the package's root '.' export maps to absent files, so only subpath imports work (pinned by isolate.test.mjs).",
        "Neither SDK answers a malformed stdio line with -32700; both drop it and keep serving (the broken-framing oracle accepts -32700 or silence).",
        "v1 exposes the request abort signal at extra.signal; v2 at ctx.mcpReq.signal (probe-def.mjs checks both).",
      ],
    },
    "scripted.json": scripted,
    "supply-chain.json": supplyChain,
    "audit.json": audit,
    "token-cost.json": tokenCost,
  };
  for (const [name, value] of Object.entries(generation)) {
    writeFileSync(join(EVIDENCE_DIR, `${name}.staging`), JSON.stringify(sortDeep(value), null, 2) + "\n");
  }
  for (const name of Object.keys(generation)) {
    renameSync(join(EVIDENCE_DIR, `${name}.staging`), join(EVIDENCE_DIR, name));
  }
  rmSync(MARKER, { force: true });

  process.stderr.write(`evidence written to ${EVIDENCE_DIR}\n`);
  process.exit(anyFailed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`matrix could not run: ${error.message}\n`);
    process.exit(2);
  }
}
