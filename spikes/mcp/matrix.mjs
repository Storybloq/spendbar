#!/usr/bin/env node
// The scripted-evidence orchestrator (plan §5/§6/§8): runs every stage for BOTH candidates
// with no short-circuiting — a failure is recorded as evidence and ends nothing except its own
// cell — and writes the committed evidence files the verifier consumes.
//
// Stage order per candidate: supply-chain fetch+verify (§3), npm audit (recorded, not
// gating), the eight scripted conformance cases with isolation enumeration (§5/§2), token
// measurement (§7 — measurement only, no oracle). Before any of it: the T-024 privacy scan in
// audit mode over HEAD (§8 — T-009's first preflight), because evidence generated in a
// repository that fails its own personal-data audit has no business being committed.
//
// Exit codes: 0 all stages ran and every case passed; 1 all stages ran, something failed
// (still fully recorded); 2 a stage could not run — no silent skips.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runCandidate } from "./conformance.mjs";
import { inspectClosure } from "./supply-chain.mjs";
import { assembleCandidateRoot, buildServerEnv } from "./isolate.mjs";
import { measureToolDefinition, sortDeep } from "./token-cost.mjs";
import { SCRIPTED_CASES } from "./decide.mjs";
import { BOUND_INPUTS, EVIDENCE_DIR } from "./verify-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const writeEvidence = (name, value) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, name), JSON.stringify(sortDeep(value), null, 2) + "\n");
};

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

/** Measure the probe tool definition as each SDK actually lists it (§7). */
async function measureListedTool(candidate) {
  const { root, resolveLog, cleanup } = assembleCandidateRoot(candidate);
  try {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: root,
      env: buildServerEnv({ resolveLog }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "matrix", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${candidate}: tools/list for token measurement timed out`));
      }, 15_000);
      child.stdout.on("data", () => {
        for (const line of out.split("\n").filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            if (msg.id === 2 && msg.result) {
              clearTimeout(deadline);
              resolve(msg.result);
              return;
            }
          } catch {
            /* partial line; keep accumulating */
          }
        }
      });
      child.on("error", reject);
    });
    child.kill("SIGKILL");
    const tool = (listed.tools ?? []).find((t) => t.name === "spendbar_probe");
    if (!tool) throw new Error(`${candidate}: probe tool absent from tools/list during measurement`);
    return measureToolDefinition(tool);
  } finally {
    cleanup();
  }
}

async function main() {
  preflightPrivacyAudit();
  process.stderr.write("preflight: privacy audit over HEAD is green\n");

  const scripted = {};
  const supplyChain = {};
  const audit = {};
  const tokenCost = { proxyVersion: null };
  let anyFailed = false;

  for (const candidate of ["v1", "v2"]) {
    const lockfile = join(HERE, "candidates", candidate, "package-lock.json");
    supplyChain[candidate] = await inspectClosure(lockfile);
    process.stderr.write(
      `${candidate}: supply chain ${supplyChain[candidate].verified}/${supplyChain[candidate].packages} verified, ` +
        `${supplyChain[candidate].violations.length} violations\n`,
    );

    audit[candidate] = recordAudit(candidate);
    process.stderr.write(
      `${candidate}: audit ${audit[candidate].ran ? `ran (${audit[candidate].advisoriesTotal} advisories)` : `did not run — recorded`}\n`,
    );

    const conf = await runCandidate(candidate);
    scripted[candidate] = conf;
    anyFailed ||= conf.failed > 0 || supplyChain[candidate].violations.length > 0;
    process.stderr.write(
      `${candidate}: ${Object.values(conf.cases).filter((c) => c.status === "pass").length}/${SCRIPTED_CASES.length} scripted cases, ` +
        `isolation ${conf.isolation.ok ? "ok" : "BROKEN"}\n`,
    );

    const measured = await measureListedTool(candidate);
    tokenCost.proxyVersion = measured.proxyVersion;
    tokenCost[candidate] = {
      canonicalBytes: measured.canonicalBytes,
      proxyTokens: measured.proxyTokens,
      fields: measured.fields,
    };
    process.stderr.write(`${candidate}: tool definition ${measured.canonicalBytes}B / ${measured.proxyTokens} proxy tokens\n`);
  }

  const files = {};
  for (const rel of BOUND_INPUTS) files[rel] = sha256(readFileSync(join(REPO, rel)));

  writeEvidence("inputs.json", {
    caseList: SCRIPTED_CASES,
    files,
    notes: [
      "v1 (@modelcontextprotocol/sdk 1.30.0) ships no dist/{esm,cjs}/index.js: the package's root '.' export maps to absent files, so only subpath imports work (pinned by isolate.test.mjs).",
      "Neither SDK answers a malformed stdio line with -32700; both drop it and keep serving (the broken-framing oracle accepts -32700 or silence).",
      "v1 exposes the request abort signal at extra.signal; v2 at ctx.mcpReq.signal (probe-def.mjs checks both).",
    ],
  });
  writeEvidence("scripted.json", scripted);
  writeEvidence("supply-chain.json", supplyChain);
  writeEvidence("audit.json", audit);
  writeEvidence("token-cost.json", tokenCost);

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
