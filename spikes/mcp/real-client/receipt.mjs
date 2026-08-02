#!/usr/bin/env node
// The review receipt (plan §6b): a verifier INDEPENDENT of the capture command reproduces
// the normalization from the retained raw streams, compares it against the recorded
// evidence, and writes the sanitized receipt that gets committed ALONGSIDE the evidence.
// The capture command does not approve its own output; this does — and NO evidence commit
// is eligible until this receipt exists.
//
// The moment a capture's receipt is written, its raw streams are DELETED: personal data is
// not held for a fixed period once it is finished with. The residual check afterwards is the
// sanitized manifest's raw statistics — weaker on purpose, and recorded as such.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { normalize } from "./normalize.mjs";
import { RETAINED_DIR } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_REAL = join(HERE, "..", "evidence", "real-clients");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function main() {
  if (!existsSync(RETAINED_DIR)) {
    process.stderr.write("receipt: no retained captures exist — nothing to verify\n");
    process.exit(2);
  }
  const captures = readdirSync(RETAINED_DIR);
  if (captures.length === 0) {
    process.stderr.write("receipt: retained-capture directory is empty — nothing to verify\n");
    process.exit(2);
  }

  const receipts = [];
  let failed = false;
  for (const id of captures) {
    const dir = join(RETAINED_DIR, id);
    const manifestPath = join(dir, "raw-manifest.json");
    if (!existsSync(manifestPath)) {
      process.stderr.write(`receipt: ${id} has no raw manifest — leaving for the abandoned sweep\n`);
      continue;
    }
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    const c2s = readFileSync(join(dir, "client-to-server.raw"));
    const s2c = readFileSync(join(dir, "server-stdout.raw"));
    const serverErr = readFileSync(join(dir, "server-stderr.raw"));

    // Reproduce the derivation from the retained bytes and require it to match what the
    // capture recorded — byte digests first, then the derivation digest.
    const problems = [];
    if (sha256(c2s) !== raw.digests.clientToServerSha256) problems.push("client->server bytes do not match their digest");
    if (sha256(s2c) !== raw.digests.serverStdoutSha256) problems.push("server stdout bytes do not match their digest");
    if (sha256(serverErr) !== raw.digests.serverStderrSha256) problems.push("server stderr bytes do not match their digest");
    const rederived = normalize(c2s, s2c);
    if (rederived.derivationDigest !== raw.digests.derivationDigest) {
      problems.push("re-running normalization over the retained raw streams does not reproduce the recorded trace");
    }
    if (JSON.stringify(rederived.frames) !== JSON.stringify(raw.frames)) {
      problems.push("reproduced frames differ from the recorded frames");
    }

    if (problems.length) {
      failed = true;
      process.stderr.write(`receipt: ${id} FAILED verification:\n  ${problems.join("\n  ")}\n`);
      continue; // raw is kept — failed verification is precisely when the bytes matter
    }

    receipts.push({
      captureId: id,
      client: raw.client,
      candidate: raw.candidate,
      reproduced: {
        clientToServerSha256: raw.digests.clientToServerSha256,
        serverStdoutSha256: raw.digests.serverStdoutSha256,
        serverStderrSha256: raw.digests.serverStderrSha256,
        derivationDigest: raw.digests.derivationDigest,
      },
      rawStatistics: raw.serverStdout,
      note: "raw capture deleted on receipt; residual check is these statistics and digests — weaker than the bytes, recorded as such",
    });
    rmSync(dir, { recursive: true, force: true });
    process.stderr.write(`receipt: ${id} verified and its raw capture deleted\n`);
  }

  if (receipts.length > 0) {
    writeFileSync(join(EVIDENCE_REAL, "receipt.json"), JSON.stringify(receipts, null, 2) + "\n");
    process.stderr.write(`receipt: wrote ${join(EVIDENCE_REAL, "receipt.json")} (${receipts.length} capture(s))\n`);
  }
  process.exit(failed ? 1 : receipts.length > 0 ? 0 : 2);
}

main();
