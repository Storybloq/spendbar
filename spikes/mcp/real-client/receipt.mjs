#!/usr/bin/env node
// The review receipt (plan §6b): a verifier INDEPENDENT of the capture command reproduces
// everything the capture derived, compares it against the committed evidence, and only then
// writes the receipt that gets committed ALONGSIDE that evidence. The capture command does not
// approve its own output; this does — and NO evidence commit is eligible until this exists.
//
// A receipt is a permission to DELETE the raw bytes. Review round 1, chunk 10 found that this
// permission was granted on far too little, and granted in the wrong order:
//
//   * IT DELETED FIRST. Each verified capture was removed inside the loop, before receipt.json
//     was written. A crash, a malformed later capture, a full disk — anything after the first
//     deletion destroyed the only raw evidence without producing its receipt. Verification now
//     completes for the whole batch, the records are written atomically and READ BACK, and only
//     the directories named in the durable receipt are deleted.
//   * IT CHECKED THREE DIGESTS. Everything else — the sanitized manifest, the cell status, the
//     client's own stdout, the prompt, the executable, the wrapper's witness — was taken from
//     the raw manifest on trust, which is to say from a file the capture wrote about itself.
//     A self-consistent crafted directory could earn a receipt. It now re-runs sanitization and
//     classification and requires exact agreement with what was committed.
//   * IT OVERWROTE PRIOR RECEIPTS. Each invocation wrote only the captures it happened to find,
//     so a per-cell run erased the receipts of cells whose raw bytes were already gone. Entries
//     are now merged by capture id, and a conflicting re-entry is a refusal.
//
// The raw streams are deleted the moment their receipt is durable: personal data is not held
// for a fixed period once it is finished with. The residual check afterwards is the sanitized
// manifest's statistics and digests — weaker on purpose, and recorded as such.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictJson } from "../strict-json.mjs";
import { classify, toCellStatus, InvalidRecordError } from "./classify.mjs";
import { normalize } from "./normalize.mjs";
import { CAPTURE_INPUTS, RECEIPT_SCHEMA_VERSION, staleCaptureInputs } from "./provenance.mjs";
import { sanitize, assertNoPersonalData } from "./sanitize.mjs";
import { RETAINED_DIR, PROMPT_TEMPLATE, PROMPT_TEMPLATE_SHA256, COMPLETION_MARKER } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_REAL = join(HERE, "..", "evidence", "real-clients");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Re-exported for the modules that used to import them from here. The definitions moved to
// provenance.mjs so capture.mjs can pin the inputs BEFORE it spawns anything.
export { CAPTURE_INPUTS, RECEIPT_SCHEMA_VERSION };

/** Exactly the files a complete retained capture holds. Anything else is a refusal. */
const REQUIRED_FILES = [
  "raw-manifest.json",
  "client-to-server.raw",
  "server-stdout.raw",
  "server-stderr.raw",
  "client-stdout.raw",
  "client-stderr.raw",
  "wrapper-status.json",
];
/** Written only when the server actually reached the point of exiting. */
const OPTIONAL_FILES = ["server-exit.json"];

/**
 * Open a retained capture directory defensively. Symlinks are refused rather than followed, the
 * file roster must be exact, and every resolved path must stay beneath the retained root —
 * otherwise a crafted entry can make the verifier read, and then commit, something else.
 */
export function openCapture(id, retainedDir = RETAINED_DIR) {
  const dir = join(retainedDir, id);
  const problems = [];
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return { problems: [`${id}: disappeared while being verified`] };
  if (!st.isDirectory()) return { problems: [`${id}: is not a directory`] };
  if (st.isSymbolicLink()) return { problems: [`${id}: is a symlink`] };
  if (st.uid !== process.getuid()) problems.push(`${id}: is not owned by the current user`);
  if ((st.mode & 0o777) !== 0o700) problems.push(`${id}: directory mode is not 0700`);
  if (resolve(dir) !== join(resolve(retainedDir), id)) problems.push(`${id}: resolves outside the retained root`);

  const present = readdirSync(dir).sort();
  const allowed = [...REQUIRED_FILES, ...OPTIONAL_FILES];
  const unexpected = present.filter((f) => !allowed.includes(f));
  const missing = REQUIRED_FILES.filter((f) => !present.includes(f));
  if (unexpected.length) problems.push(`${id}: unexpected file(s) [${unexpected.join(", ")}]`);
  if (missing.length) problems.push(`${id}: missing required file(s) [${missing.join(", ")}]`);

  const bytes = {};
  for (const name of present) {
    const fst = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (!fst || !fst.isFile()) {
      problems.push(`${id}: '${name}' is not a regular file`);
      continue;
    }
    if ((fst.mode & 0o777) !== 0o600) problems.push(`${id}: '${name}' mode is not 0600`);
    bytes[name] = readFileSync(join(dir, name));
  }
  return { dir, bytes, problems };
}

/** Everything a receipt attests, recomputed from the retained bytes. Returns the problems found. */
export function verifyCapture(id, bytes, evidenceDir) {
  const problems = [];
  const note = (why) => problems.push(why);

  let raw;
  try {
    // Strict parsing, because a duplicated key in a hand-edited manifest is exactly the shape
    // of attack this receipt exists to catch: one value for a reader, another for the machine.
    raw = parseStrictJson(bytes["raw-manifest.json"].toString("utf8"));
  } catch (error) {
    return [`${id}: raw manifest is not strictly-parseable JSON (${error.message})`];
  }
  if (raw?.captureId !== id) return [`${id}: raw manifest names a different capture`];

  // 1. Every retained stream matches the digest recorded for it.
  const digestOf = {
    clientToServerSha256: "client-to-server.raw",
    serverStdoutSha256: "server-stdout.raw",
    serverStderrSha256: "server-stderr.raw",
    clientStdoutSha256: "client-stdout.raw",
    clientStderrSha256: "client-stderr.raw",
  };
  for (const [key, file] of Object.entries(digestOf)) {
    if (raw.digests?.[key] !== sha256(bytes[file])) note(`${id}: ${file} does not match its recorded digest`);
  }

  // 2. The derivation, re-run over the retained bytes: frames, BOTH directions' statistics, and
  //    the digest over all of it. Copying the statistics across without comparing them let those
  //    load-bearing counters be edited while the trace still reproduced.
  const rederived = normalize(bytes["client-to-server.raw"], bytes["server-stdout.raw"]);
  if (rederived.derivationDigest !== raw.digests?.derivationDigest) {
    note(`${id}: re-running normalization over the retained streams does not reproduce the recorded trace`);
  }
  if (JSON.stringify(rederived.frames) !== JSON.stringify(raw.frames)) note(`${id}: reproduced frames differ`);
  for (const direction of ["clientToServer", "serverStdout"]) {
    if (JSON.stringify(rederived[direction]) !== JSON.stringify(raw[direction])) {
      note(`${id}: reproduced ${direction} statistics differ from the recorded ones`);
    }
  }

  // 3. The predicates over the client's own streams, recomputed from the bytes rather than read
  //    back from the record that asserted them.
  const clientText = bytes["client-stdout.raw"].toString("utf8");
  if (raw.clientStdout?.hasCompletionMarker !== clientText.includes(COMPLETION_MARKER)) {
    note(`${id}: the recorded completion-marker fact is not what the client's stdout shows`);
  }
  if (raw.clientStdout?.containsNonce !== clientText.includes(raw.nonce)) {
    note(`${id}: the recorded nonce-disclosure fact is not what the client's stdout shows`);
  }

  // 4. The prompt actually passed, reconstructed from the committed template and this run's
  //    nonce — not merely the template's own hash.
  const instantiated = PROMPT_TEMPLATE.replace("{{NONCE}}", raw.nonce ?? "");
  if (raw.promptSha256 !== PROMPT_TEMPLATE_SHA256) note(`${id}: prompt template hash is not the committed literal`);
  if (raw.promptInstanceSha256 !== sha256(Buffer.from(instantiated, "utf8"))) {
    note(`${id}: the recorded prompt bytes are not the committed template instantiated with this nonce`);
  }
  if (!raw.commandLine?.includes?.(instantiated)) {
    note(`${id}: the reconstructed prompt does not appear in the recorded command line`);
  }

  // 5. The wrapper's witness must agree with the spawn record it is the witness for.
  if (raw.spawn?.server?.ok !== (raw.wrapper?.spawned === true)) {
    note(`${id}: the recorded server-spawn outcome disagrees with the wrapper's witness`);
  }

  // 6. Provenance: the digests pinned before the run must still describe this working tree.
  const { stale, extra } = staleCaptureInputs(raw.captureInputs);
  if (stale.length) note(`${id}: capture input(s) changed since the run: ${stale.join(", ")}`);
  if (extra.length) note(`${id}: capture inputs record undeclared entries: ${extra.join(", ")}`);

  // 7. Re-sanitize and require the committed manifest to be exactly what this produces, and
  //    re-classify and require the committed cell to be exactly what that produces. These are
  //    the two claims the evidence actually rests on, and neither was checked at all.
  let sanitized;
  try {
    sanitized = sanitize(raw);
  } catch (error) {
    return [...problems, `${id}: the raw manifest does not sanitize (${error.message})`];
  }

  let outcome;
  try {
    outcome = classify(raw, {
      promptSha256: PROMPT_TEMPLATE_SHA256,
      promptInstanceSha256: sha256(Buffer.from(instantiated, "utf8")),
      nonce: raw.nonce,
      completionMarker: COMPLETION_MARKER,
    }).outcome;
  } catch (error) {
    if (!(error instanceof InvalidRecordError)) throw error;
    return [...problems, `${id}: the raw manifest is not usable evidence (${error.message})`];
  }
  const cellsPath = join(evidenceDir, "cells.json");
  const cells = existsSync(cellsPath) ? parseStrictJson(readFileSync(cellsPath, "utf8")) : {};
  const cell = cells?.[raw.candidate]?.[raw.client];
  const attempts = cell?.attempts ?? [];
  const recordedForThis = attempts.find((a) => a.captureId === id);
  if (!recordedForThis) {
    note(`${id}: the recorded cell does not list this capture as one of its attempts`);
  } else if (recordedForThis.outcome !== outcome) {
    note(`${id}: the cell records outcome '${recordedForThis.outcome}' but this capture re-derives '${outcome}'`);
  }

  // Only the FINAL attempt's manifest is committed — a superseded environmental attempt is
  // carried by its receipt alone. So the manifest comparison, and the cell-status comparison,
  // apply to that attempt and to no other.
  const isFinal = attempts.length > 0 && attempts[attempts.length - 1].captureId === id;
  if (isFinal) {
    if (cell.status !== toCellStatus(outcome)) {
      note(`${id}: the cell status '${cell.status}' is not what its final attempt re-derives`);
    }
    const manifestPath = join(evidenceDir, `${raw.client}-${raw.candidate}.manifest.json`);
    if (!existsSync(manifestPath)) {
      note(`${id}: no committed manifest for ${raw.client}/${raw.candidate}`);
    } else if (readFileSync(manifestPath, "utf8") !== JSON.stringify(sanitized, null, 2) + "\n") {
      note(`${id}: the committed manifest is not what sanitizing this capture produces`);
    }
  }

  return problems.length ? problems : { raw, sanitized, outcome };
}

/** Every capture id the recorded cells claim as an attempt, across both candidates. */
export function referencedCaptureIds(cells) {
  const ids = new Set();
  for (const perClient of Object.values(cells ?? {})) {
    for (const cell of Object.values(perClient ?? {})) {
      for (const attempt of cell?.attempts ?? []) ids.add(attempt.captureId);
    }
  }
  return ids;
}

/** Write a JSON file durably: temp file, fsync, rename, then read it back and compare. */
export function writeDurable(path, value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  const buf = Buffer.from(text, "utf8");
  const tmp = `${path}.writing`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (readFileSync(path, "utf8") !== text) throw new Error(`${path} did not read back as written`);
}

function main() {
  const evidenceDir = EVIDENCE_REAL;
  if (!existsSync(RETAINED_DIR)) {
    process.stderr.write("receipt: no retained captures exist — nothing to verify\n");
    process.exit(2);
  }
  const entries = readdirSync(RETAINED_DIR);
  if (entries.length === 0) {
    process.stderr.write("receipt: retained-capture directory is empty — nothing to verify\n");
    process.exit(2);
  }

  // ---- phase 1: verify EVERYTHING, delete nothing --------------------------------------------
  const verified = [];
  const failures = [];
  for (const id of entries.sort()) {
    const opened = openCapture(id);
    if (opened.problems.length) {
      // Fail closed. An entry that is not a complete, well-formed capture used to be skipped
      // silently, so a partial capture left the batch "successful" and unapproved.
      failures.push(...opened.problems);
      continue;
    }
    const result = verifyCapture(id, opened.bytes, evidenceDir);
    if (Array.isArray(result)) {
      failures.push(...result);
      continue; // raw is kept — failed verification is precisely when the bytes matter
    }
    verified.push({ id, dir: opened.dir, ...result });
  }

  if (failures.length) {
    process.stderr.write(`receipt: FAILED verification, nothing written and nothing deleted:\n`);
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    process.exit(1);
  }

  // ---- phase 2: merge with what is already receipted -----------------------------------------
  const receiptPath = join(evidenceDir, "receipt.json");
  const existing = existsSync(receiptPath) ? parseStrictJson(readFileSync(receiptPath, "utf8")) : [];
  if (!Array.isArray(existing)) {
    process.stderr.write("receipt: the existing receipt.json is not an array — refusing to replace it\n");
    process.exit(1);
  }
  // Merging preserves receipts from OTHER cells, which is the point — a per-cell capture run
  // must not erase the receipts of cells whose raw bytes are already gone. It must not preserve
  // receipts from a superseded GENERATION though: those name captures no cell refers to any
  // more, and keeping them makes receipt.json grow forever and describe two different runs at
  // once. So the surviving set is exactly what the current cells claim as attempts.
  const cellsPath = join(evidenceDir, "cells.json");
  const cells = existsSync(cellsPath) ? parseStrictJson(readFileSync(cellsPath, "utf8")) : {};
  const referenced = referencedCaptureIds(cells);
  const superseded = existing.filter((entry) => !referenced.has(entry.captureId));
  for (const entry of superseded) {
    process.stderr.write(`receipt: dropping ${entry.captureId} — no current cell claims it as an attempt\n`);
  }
  const byId = new Map(existing.filter((entry) => referenced.has(entry.captureId)).map((e) => [e.captureId, e]));

  for (const v of verified) {
    const entry = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      captureId: v.id,
      client: v.raw.client,
      candidate: v.raw.candidate,
      outcome: v.outcome,
      reproduced: { ...v.raw.digests },
      rawStatistics: { clientToServer: v.raw.clientToServer, serverStdout: v.raw.serverStdout },
      captureInputs: { ...v.raw.captureInputs },
      note: "raw capture deleted on receipt; residual check is these statistics and digests — weaker than the bytes, recorded as such",
    };
    const prior = byId.get(v.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) {
      process.stderr.write(`receipt: ${v.id} already has a DIFFERENT receipt — refusing to overwrite it\n`);
      process.exit(1);
    }
    byId.set(v.id, entry);
  }
  const merged = [...byId.values()].sort((a, b) => a.captureId.localeCompare(b.captureId));

  // The committed receipt is evidence like any other: it passes the same privacy gate.
  assertNoPersonalData(merged, "<receipt.json>");

  // One pin per evidence set: captures taken under different inputs cannot share a record that
  // claims to describe all of them.
  const pins = new Set(merged.map((entry) => JSON.stringify(entry.captureInputs)));
  if (pins.size !== 1) {
    process.stderr.write(
      `receipt: the ${merged.length} receipted captures were taken under ${pins.size} different capture-input sets — ` +
        "recapture the whole set rather than publishing a pin that describes only some of them\n",
    );
    process.exit(1);
  }

  // ---- phase 3: publish durably, THEN delete -------------------------------------------------
  writeDurable(receiptPath, merged);
  // The capture-time pin, taken from the manifests rather than recomputed now: recomputing it
  // here would bind whatever the working tree happens to hold to a run that predates it.
  writeDurable(join(evidenceDir, "capture-inputs.json"), { files: JSON.parse([...pins][0]) });

  const durable = new Set(parseStrictJson(readFileSync(receiptPath, "utf8")).map((e) => e.captureId));
  for (const v of verified) {
    if (!durable.has(v.id)) {
      process.stderr.write(`receipt: ${v.id} is missing from the receipt that was just written — keeping its raw capture\n`);
      continue;
    }
    rmSync(v.dir, { recursive: true, force: true });
    process.stderr.write(`receipt: ${v.id} verified and its raw capture deleted\n`);
  }
  process.stderr.write(`receipt: wrote ${receiptPath} (${merged.length} capture(s), schema ${RECEIPT_SCHEMA_VERSION})\n`);
  process.exit(0);
}

// Direct-entry guard: importing this module must not run the receipt tool (which sweeps
// retained captures and calls process.exit). Same defect class the mutant server carried.
if (import.meta.url === `file://${process.argv[1]}`) main();
