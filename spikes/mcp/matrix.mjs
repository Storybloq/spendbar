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
// Run integrity (review round 1, extended in round 2 chunk 13):
//   * bound-input digests are captured BEFORE any stage and re-checked before publishing —
//     results produced from old bytes are never bound to new bytes;
//   * an attempt marker (matrix-attempt.json) exists from first stage to successful publish;
//     the verifier refuses evidence while it is present, so a crashed or failed run can
//     never leave an older generation silently consumable;
//   * publication is staged: every file is written aside, READ BACK and re-parsed, and only
//     then renamed into place. This line used to claim "only after the whole generation
//     validated" while no validation existed between the writes and the renames;
//   * a stage's result must be ACCEPTABLE, not merely thrown-free. `inspectClosure` and
//     `scanInstalledTree` report violations by returning them, so a closure carrying a
//     `postinstall` hook was recorded `ok` and every later stage ran — installing it, then
//     EXECUTING it in the conformance cases — with the violations reaching the exit code
//     afterwards. A stage that refuses blocks everything declaring it as a prerequisite.
//
// Exit codes: 0 all stages ran and every case passed; 1 all stages ran, something failed
// (still fully recorded — a candidate whose cases fail is the evidence this spike exists to
// produce, so it publishes); 2 a stage could not run or was refused — typed causes in the
// marker, nothing published.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Harness, initialize, runCandidate } from "./conformance.mjs";
import { inspectClosure, scanInstalledTree } from "./supply-chain.mjs";
import { measureToolDefinition, sortDeep } from "./token-cost.mjs";
import { SCRIPTED_CASES } from "./decide.mjs";
import { BOUND_INPUTS, EVIDENCE_DIR } from "./verify-evidence.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { isDirectEntry } from "../../scripts/direct-entry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const MARKER = join(EVIDENCE_DIR, "matrix-attempt.json");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const nowIso = () => new Date().toISOString();

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

/**
 * Read one `npm audit --json` result. Exported because the interesting cases are its FAILURES,
 * and a stage body that cannot be called cannot be tested.
 *
 * `ran: true` now means an audit result was observed, not merely that something parsed. npm
 * prints a well-formed JSON *error envelope* — `{"error":{"code":"ENOLOCK",...}}` — and exits
 * 0 when it refuses to audit; the previous version parsed that, found no `metadata`, defaulted
 * to `{}` and recorded `ran: true, advisoriesTotal: 0`, printing "audit ran (0 advisories)"
 * for a command that audited nothing (reproduced in review round 2, chunk 13). The exit status
 * cannot be the test either: npm exits NONZERO precisely when the audit succeeded and found
 * vulnerabilities. So the test is the shape of the result itself.
 */
export function readAuditResult({ stdout, stderr, error, status }) {
  const fail = (cause) => ({ ran: false, cause: String(cause).slice(0, 300) });
  if (error) return fail(`npm audit could not run: ${error.message}`);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail(stderr || `npm audit produced no parseable output (exit ${status})`);
  }
  if (parsed?.error) {
    return fail(`npm audit refused: ${parsed.error.code ?? "unknown"} ${parsed.error.summary ?? ""}`.trim());
  }
  const meta = parsed?.metadata?.vulnerabilities;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || Object.keys(meta).length === 0) {
    return fail(`npm audit output carried no metadata.vulnerabilities (exit ${status})`);
  }
  const counts = Object.values(meta);
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) {
    return fail("npm audit reported a non-count in metadata.vulnerabilities");
  }
  return { ran: true, vulnerabilities: meta, advisoriesTotal: counts.reduce((a, b) => a + b, 0) };
}

/** npm audit per workspace — recorded as evidence, never gating (§2). */
function recordAudit(candidate) {
  // The registry audit endpoint being unreachable is a recorded fact, not a crash — audit is
  // advisory evidence, and pretending it ran would be worse than saying it did not.
  return readAuditResult(
    spawnSync("npm", ["audit", "--json"], {
      cwd: join(HERE, "candidates", candidate),
      encoding: "utf8",
      timeout: 120_000,
    }),
  );
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

/**
 * Run every stage for every candidate with NO short-circuiting (§1): a stage that throws
 * becomes a typed failure record and the walk continues — to this candidate's later stages
 * and to the other candidate. A stage may declare `needs`, an earlier stage whose success it
 * requires; when that prerequisite did not succeed, the dependent stage is recorded as
 * not-run WITH ITS CAUSE rather than skipped silently.
 *
 * Exported and stage-injectable so the contract is directly testable: a test injects an early
 * failure and asserts every later stage and the other candidate still produced typed results
 * (review round 1 — the previous assertion only inspected an all-green record, which a
 * short-circuiting orchestrator would produce identically).
 */
export async function runStages(candidates, stages) {
  const results = {};
  for (const candidate of candidates) {
    results[candidate] = {};
    for (const stage of stages) {
      if (stage.needs && results[candidate][stage.needs]?.status !== "ok") {
        results[candidate][stage.name] = {
          status: "not-run",
          cause: `not run: prerequisite stage '${stage.needs}' did not succeed`,
        };
        continue;
      }
      let value;
      try {
        value = await stage.run(candidate, results[candidate]);
      } catch (error) {
        results[candidate][stage.name] = { status: "failed", cause: String(error?.message ?? error) };
        continue;
      }
      // "It did not throw" is not "it produced a result". A stage returning undefined used to
      // be recorded `ok`; main() then found nothing to publish for it, found no stage failure
      // either, and could rename an evidence file containing `{}` into place and exit zero
      // (review round 2, chunk 13).
      if (value === undefined || value === null) {
        results[candidate][stage.name] = { status: "failed", cause: "stage returned no result" };
        continue;
      }
      // Succeeding is not the same as being ACCEPTABLE. The supply-chain inspector returns
      // violations rather than throwing, so a closure known to carry `postinstall` was status
      // `ok` — and `install`, `installed-rescan`, `conformance` and `token-measure` all ran
      // against it, the last two EXECUTING it, before anything looked at the violations. A
      // stage that refuses is not `ok`, so nothing that declared it as a prerequisite runs.
      const refusal = stage.validate ? stage.validate(value) : null;
      if (refusal) {
        results[candidate][stage.name] = { status: "refused", cause: refusal, value };
        continue;
      }
      results[candidate][stage.name] = { status: "ok", value };
    }
  }
  return results;
}

/** A violation list, rendered as the reason a stage refuses. */
const violationRefusal = (what, violations) =>
  violations.length === 0
    ? null
    : `${what}: ${violations.length} violation(s) — ${violations.map((v) => `${v.package}:${v.kind}`).join(", ")}`;

/**
 * SHAPE validation for the conformance result — deliberately not a pass/fail judgement.
 *
 * A candidate whose cases fail is the evidence this whole spike exists to produce, so failures
 * must publish (exit 1), not vanish into a refusal (exit 2). What must refuse is a record that
 * cannot be READ: `failed` is recomputed from the case statuses and the isolation verdict and
 * has to agree, because trusting the stored aggregate meant `undefined > 0` — false — read as
 * "nothing failed" the moment the shape changed (review round 2, chunk 13).
 */
export function validateConformance(value) {
  if (!value || typeof value.cases !== "object" || value.cases === null) return "conformance returned no case records";
  if (typeof value.isolation?.ok !== "boolean") return "conformance reported no isolation verdict";
  if (!Number.isSafeInteger(value.failed) || value.failed < 0) {
    return `conformance 'failed' is ${JSON.stringify(value.failed)}, not a count`;
  }
  const recomputed =
    Object.values(value.cases).filter((c) => c?.status === "fail").length + (value.isolation.ok ? 0 : 1);
  if (value.failed !== recomputed) {
    return `conformance reported failed=${value.failed} but its own records recompute to ${recomputed}`;
  }
  return null;
}

/**
 * Whether a candidate's conformance record counts as a failure for the exit code. Its own
 * function because it is a JUDGEMENT and judgements get tested: `conf.failed > 0` alone is
 * false for `undefined`, so a changed result shape printed "isolation BROKEN" to stderr and
 * exited zero. Isolation is a term here rather than something trusted to have been folded in
 * upstream (review round 2, chunk 13).
 */
export const candidateFailed = (conf) => conf.failed > 0 || conf.isolation?.ok !== true;

/** SHAPE validation for a token measurement: measurement only, so only readability is required. */
export function validateMeasurement(value) {
  if (typeof value?.proxyVersion !== "string" || value.proxyVersion === "") return "measurement names no proxy version";
  for (const field of ["canonicalBytes", "proxyTokens"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      return `measurement '${field}' is ${JSON.stringify(value[field])}, not a count`;
    }
  }
  return null;
}

/**
 * The stage list, in order. Every stage that consumes an installed tree declares that need,
 * and the two stages that decide whether unsafe code is allowed to RUN declare a `validate`:
 * a closure or an installed tree carrying a forbidden hook refuses, so `install`, the rescan,
 * the conformance cases and the token measurement never reach it.
 */
export function buildStages() {
  return [
    {
      name: "supply-chain",
      run: (c) => inspectClosure(join(HERE, "candidates", c, "package-lock.json")),
      validate: (v) => violationRefusal("locked closure", v.violations),
    },
    { name: "install", needs: "supply-chain", run: (c) => installCandidate(c) },
    {
      name: "installed-rescan",
      needs: "install",
      run: (c) => scanInstalledTree(join(HERE, "candidates", c)),
      validate: (v) => violationRefusal("installed tree", v.violations),
    },
    { name: "audit", run: (c) => recordAudit(c) }, // advisory: independent of the install chain
    { name: "conformance", needs: "installed-rescan", run: (c) => runCandidate(c), validate: validateConformance },
    { name: "token-measure", needs: "installed-rescan", run: (c) => measureListedTool(c), validate: validateMeasurement },
  ];
}

async function main() {
  preflightPrivacyAudit();
  process.stderr.write("preflight: privacy audit over HEAD is green\n");

  const digestsBefore = computeBoundDigests();
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const startedAt = nowIso();
  writeFileSync(MARKER, JSON.stringify({ status: "in-progress", startedAt }, null, 2) + "\n");

  const results = await runStages(["v1", "v2"], buildStages());

  const scripted = {};
  const supplyChain = {};
  const audit = {};
  const tokenCost = { proxyVersion: null };
  const stageFailures = [];
  let anyFailed = false;

  for (const candidate of ["v1", "v2"]) {
    for (const [name, r] of Object.entries(results[candidate])) {
      // A refused stage carries the record it was refused for; it goes into the marker so the
      // reason is legible without re-running anything.
      if (r.status !== "ok") stageFailures.push({ candidate, stage: name, cause: r.cause, value: r.value });
    }
    const value = (name) => (results[candidate][name]?.status === "ok" ? results[candidate][name].value : null);

    const inspected = value("supply-chain");
    const install = value("install");
    const rescan = value("installed-rescan");
    if (inspected) {
      process.stderr.write(
        `${candidate}: supply chain ${inspected.verified}/${inspected.packages} verified, ` +
          `${inspected.violations.length} violations\n`,
      );
    }
    if (rescan) {
      process.stderr.write(
        `${candidate}: installed rescan ${rescan.packagesScanned} packages, ${rescan.violations.length} violations\n`,
      );
    }
    if (inspected && install && rescan) {
      supplyChain[candidate] = { ...inspected, install, installedRescan: rescan };
      anyFailed ||= inspected.violations.length > 0 || rescan.violations.length > 0;
    }

    const auditRec = value("audit");
    if (auditRec) {
      audit[candidate] = auditRec;
      process.stderr.write(
        `${candidate}: audit ${auditRec.ran ? `ran (${auditRec.advisoriesTotal} advisories)` : "did not run — recorded"}\n`,
      );
    }

    const conf = value("conformance");
    if (conf) {
      scripted[candidate] = conf;
      anyFailed ||= candidateFailed(conf);
      process.stderr.write(
        `${candidate}: ${Object.values(conf.cases).filter((c) => c.status === "pass").length}/${SCRIPTED_CASES.length} scripted cases, ` +
          `isolation ${conf.isolation.ok ? "ok" : "BROKEN"}\n`,
      );
    }

    const measured = value("token-measure");
    if (measured) {
      // One proxy version for the whole record, so the two measurements have to have been made
      // the same way. Assigning it per candidate meant the last one silently relabelled the
      // first, and the comparison the decision draws from the two numbers is only meaningful
      // if they were counted by the same proxy.
      if (tokenCost.proxyVersion !== null && tokenCost.proxyVersion !== measured.proxyVersion) {
        stageFailures.push({
          candidate: "both",
          stage: "token-measure",
          cause: `proxy version disagreement: ${tokenCost.proxyVersion} vs ${measured.proxyVersion}`,
        });
      }
      tokenCost.proxyVersion = measured.proxyVersion;
      tokenCost[candidate] = {
        canonicalBytes: measured.canonicalBytes,
        proxyTokens: measured.proxyTokens,
        fields: measured.fields,
      };
      process.stderr.write(
        `${candidate}: tool definition ${measured.canonicalBytes}B / ${measured.proxyTokens} proxy tokens\n`,
      );
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
      JSON.stringify({ status: "failed", startedAt, failedAt: nowIso(), failures: stageFailures }, null, 2) + "\n",
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
  // Every candidate must be present in every per-candidate record. Nothing above can omit one
  // any more, but the generation is what downstream consumes, so it is checked here rather
  // than argued about here.
  for (const [name, record] of Object.entries({ scripted, "supply-chain": supplyChain, audit, tokenCost })) {
    for (const candidate of ["v1", "v2"]) {
      if (!record[candidate]) stageFailures.push({ candidate, stage: "publish", cause: `${name} has no record` });
    }
  }
  if (stageFailures.length > 0) {
    writeFileSync(
      MARKER,
      JSON.stringify({ status: "failed", startedAt, failedAt: nowIso(), failures: stageFailures }, null, 2) + "\n",
    );
    for (const f of stageFailures) process.stderr.write(`STAGE FAILED ${f.candidate}/${f.stage}: ${f.cause}\n`);
    process.exit(2);
  }

  publishGeneration(generation);
  rmSync(MARKER, { force: true });
  fsyncDir(EVIDENCE_DIR);

  process.stderr.write(`evidence written to ${EVIDENCE_DIR}\n`);
  process.exit(anyFailed ? 1 : 0);
}

/** fsync a directory, so a rename or an unlink in it is durable and not merely visible. */
function fsyncDir(dir) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write the whole generation aside, VALIDATE it, then rename it into place.
 *
 * The header promised this and the code did not do it: the previous version wrote five files
 * with `writeFileSync` and renamed them, with nothing in between. "Validated" now means each
 * staged file is read BACK off disk, strict-parsed, and required to equal what it was supposed
 * to contain — so a short write, an encoding fault or a value JSON.stringify quietly dropped
 * is caught while the destination is still untouched. The staged files are also fsynced before
 * the renames, and the directory afterwards, because a rename is a directory operation and
 * fsync on a file says nothing about it (the lesson receipt.mjs learned in chunk 8).
 *
 * What this does NOT give is a single commit point: five renames are five effects, so a crash
 * between them still leaves a mixed generation. The attempt marker covers it — the verifier
 * refuses while it is present, and it is removed only after the last rename — but that is a
 * refusal, not atomicity. Filed as ISS-053 rather than half-built here, since it is the same
 * transaction boundary as ISS-049 and ISS-052 and the three want doing together.
 */
export function publishGeneration(generation, { dir = EVIDENCE_DIR, tamper } = {}) {
  const staged = [];
  try {
    for (const [name, value] of Object.entries(generation)) {
      const text = JSON.stringify(sortDeep(value), null, 2) + "\n";
      const tmp = join(dir, `${name}.staging`);
      const fd = openSync(tmp, "w", 0o644);
      try {
        const buf = Buffer.from(text, "utf8");
        let written = 0;
        while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      staged.push({ name, tmp, text });
    }
    // Test-only, and the same injection idiom inspectClosure uses for its fetcher: it lets a
    // test damage a staged file between writing and validating, which is the one thing this
    // validation exists to catch and the one thing a test cannot otherwise arrange.
    if (tamper) tamper(staged);
    for (const { name, tmp, text } of staged) {
      const back = readFileSync(tmp, "utf8");
      if (back !== text) throw new Error(`${name}: staged file did not read back as written`);
      // Parsed with the same strict reader the verifier uses, so a document this pipeline
      // cannot re-read never becomes the published generation.
      const reparsed = JSON.stringify(parseStrictJson(back));
      if (reparsed !== JSON.stringify(JSON.parse(text))) throw new Error(`${name}: staged file does not re-parse`);
    }
  } catch (error) {
    // The destination is untouched at this point, so cleaning up the staging files leaves the
    // previous generation exactly as it was — a refused publication changes nothing.
    for (const { tmp } of staged) rmSync(tmp, { force: true });
    throw error;
  }
  for (const { name, tmp } of staged) renameSync(tmp, join(dir, name));
  fsyncDir(dir);
}

if (isDirectEntry(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`matrix could not run: ${error.message}\n`);
    process.exit(2);
  }
}
