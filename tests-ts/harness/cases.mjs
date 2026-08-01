/**
 * The case registry — a thin reader over `tests/golden/cases.json`, which is the ONE
 * definition of every parity case.
 *
 * Before T-005 the same matrix was described three times: `capture.py`'s `CASES` table,
 * this file's `EXTRA_CASES`, and this file's `GOLDEN_CAPABILITY` map. Three descriptions of
 * one thing is the drift shape this repo has already been bitten by — a case added to one of
 * them was invisible to the others, and no check could see the gap because each table was
 * internally consistent.
 *
 * `cases.json` is AUTHORED. Regenerating it from `capture.py` would defeat the point: a case
 * added there would silently propagate, leaving every set mutually equal and the coverage
 * check passing while nothing new was ever captured.
 *
 * What stays in code rather than in the JSON: the comparison policies (see policies.mjs),
 * because one of them owns a RegExp and JSON cannot hold a RegExp. The registry names a
 * policy; the policy owns its pattern and declares the allowlist ID it consumes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_CAPABILITIES } from "./capabilities.mjs";
import { PATHS } from "./env.mjs";
import { POLICIES, POLICY_CONSUMED_WAIVERS, SANCTIONED_STDOUT_REWRITE } from "./policies.mjs";

export { SANCTIONED_STDOUT_REWRITE };

const REGISTRY = JSON.parse(readFileSync(PATHS.casesJson, "utf8"));

/** Every case, stored and differential-only alike, in the order the registry declares. */
export function loadCases() {
  return REGISTRY.cases.map((c) => ({
    name: c.name,
    capability: c.capability,
    argv: c.argv,
    mode: c.mode,
    codexFixture: c.codexFixture,
    extraEnv: c.extraEnv ?? {},
    expectExit: c.expectExit,
    storedGolden: c.storedGolden,
    captureAnchor: c.captureAnchor,
    comparisonPolicy: c.comparisonPolicy,
    waiver: c.waiver,
    golden: c.storedGolden ? readGolden(c.name) : undefined,
  }));
}

function readGolden(name) {
  const g = JSON.parse(readFileSync(resolve(PATHS.goldens, `${name}.json`), "utf8"));
  return { stdout: g.stdout, stderr: g.stderr, record: g };
}

/** Golden files actually on disk, excluding the manifest. */
export function goldenFilesOnDisk() {
  return readdirSync(PATHS.goldens)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/**
 * The raw-shape pass of registry validation, split out so it can be run on synthetic records.
 *
 * `assertRegistry` reads the real registry and the real goldens directory, so a negative test
 * cannot reach it: feeding it one deliberately malformed case would also trip the capability
 * and orphan-golden checks, and the rule under test would be indistinguishable from the
 * collateral. That is how a validator ends up proven only by inputs it accepts — every rule
 * in here is a rule about REJECTING, and none of them was ever handed something to reject.
 *
 * Returns problems rather than throwing, so a caller can aggregate.
 */
export function rawCaseProblems(rawCases) {
  const problems = [];

  // Shape is checked against the RAW file, not against `cases`. `loadCases` writes every key
  // it knows about, so by the time a record reaches here an omitted field is indistinguishable
  // from one explicitly set to undefined — a presence check on the mapped object would be
  // vacuous. Absence has to be caught where absence still exists.
  //
  // `waiver` in particular must be written out even when it is null: otherwise "authorised by
  // nothing" and "needs no authorisation" are the same state on disk, and the agreement rule
  // below silently accepts a case that never declared anything.
  const REQUIRED = ["name", "capability", "argv", "mode", "extraEnv", "codexFixture",
                    "expectExit", "storedGolden", "comparisonPolicy", "waiver"];
  for (const raw of rawCases) {
    for (const key of REQUIRED) {
      if (!(key in raw)) problems.push(`case ${raw.name ?? "(unnamed)"} omits required field '${key}'`);
    }
    if ("waiver" in raw && raw.waiver !== null && typeof raw.waiver !== "string") {
      problems.push(`case ${raw.name}: waiver must be a string ID or null, got ${JSON.stringify(raw.waiver)}`);
    }

    // `expectExit` must be an INTEGER, not merely present. This is load-bearing well beyond
    // registry tidiness: `classify` gives every non-exit termination `status: null`, so
    // "the subject crashed" is caught by the status comparison alone precisely BECAUSE the
    // transcribed value is a number that null can never equal. Allow `expectExit: null` and
    // that stops being true — a signalled subject would compare null-to-null, pass, and the
    // policies would need a separate kind check to catch a crash. This check is what lets
    // those kind checks be removed rather than kept as branches no test could kill.
    if ("expectExit" in raw && !Number.isInteger(raw.expectExit)) {
      problems.push(`case ${raw.name}: expectExit must be an integer, got ${JSON.stringify(raw.expectExit)}`);
    }

    // "Present exactly when storedGolden" means PRESENT, not present-and-null. Testing for a
    // null value instead would let `captureAnchor: null` sit on a differential-only case:
    // legal by the letter of a value check, and a direct contradiction of the rule the field
    // exists to state. Presence is the property being asserted, so presence is what is read.
    const anchorDeclared = "captureAnchor" in raw;
    if (raw.storedGolden && !anchorDeclared) {
      problems.push(`stored case ${raw.name} omits captureAnchor`);
    }
    if (!raw.storedGolden && anchorDeclared) {
      problems.push(
        `differential-only case ${raw.name} declares captureAnchor ` +
          `(${JSON.stringify(raw.captureAnchor)}); it has no golden to anchor`,
      );
    }
    if (raw.storedGolden && anchorDeclared && typeof raw.captureAnchor !== "string") {
      problems.push(`case ${raw.name}: captureAnchor must be a string, got ${JSON.stringify(raw.captureAnchor)}`);
    }
  }

  return problems;
}

/**
 * Structural validation of the registry itself, before anything is executed.
 *
 * Everything here is a rule that would otherwise be enforced by nobody: the old tables were
 * each internally consistent, so their disagreements were invisible. These checks are what
 * make one file being wrong detectable rather than merely unlikely.
 */
export function assertRegistry(cases) {
  const problems = rawCaseProblems(REGISTRY.cases);
  const seen = new Set();

  for (const c of cases) {
    if (seen.has(c.name)) problems.push(`duplicate case name: ${c.name}`);
    seen.add(c.name);

    if (!c.capability) problems.push(`case ${c.name} has no capability tag`);
    else if (!ALL_CAPABILITIES.includes(c.capability)) {
      problems.push(`case ${c.name} has unknown capability ${c.capability}`);
    }

    const policy = POLICIES[c.comparisonPolicy];
    if (!policy) {
      problems.push(`case ${c.name} names unknown comparisonPolicy ${JSON.stringify(c.comparisonPolicy)}`);
    } else if ((c.waiver ?? null) !== policy.waiverId) {
      // The waiver must AUTHORIZE the policy, not merely sit beside it. Without this a
      // `help-config-path` case with `waiver: null` would perform the sanctioned rewrite
      // and pass — comparison behaviour granting itself a licence nothing authored.
      problems.push(
        `case ${c.name} has waiver ${JSON.stringify(c.waiver ?? null)} but its policy ` +
          `${c.comparisonPolicy} consumes ${JSON.stringify(policy.waiverId)}`,
      );
    }

    if (c.waiver !== null && c.waiver !== undefined && !POLICY_CONSUMED_WAIVERS.has(c.waiver)) {
      problems.push(`case ${c.name} names waiver ${c.waiver}, which no comparison policy consumes`);
    }

    // Presence of captureAnchor is checked above, against the raw record. What is left for
    // the mapped record is its FORM: a stored case must replay at a real date, and a wrong
    // shape here would surface as an unreproducible golden rather than as a bad registry.
    if (c.storedGolden && !/^\d{4}-\d{2}-\d{2}$/.test(c.captureAnchor ?? "")) {
      problems.push(`case ${c.name} has malformed captureAnchor ${JSON.stringify(c.captureAnchor)}`);
    }
  }

  // Every DECLARED capability must own at least one case. Without this the gate is vacuous
  // in the other direction (code review R1): retag every `hourly` case and both the registry
  // and `--final`'s "every capability is enabled" check still pass, while nothing exercises
  // the capability at all.
  const covered = new Set(cases.map((c) => c.capability));
  for (const cap of ALL_CAPABILITIES) {
    if (!covered.has(cap)) problems.push(`capability ${cap} is declared but no case exercises it`);
  }

  // Exact set equality between stored cases and golden files, in BOTH directions. Adding a
  // case without capturing is caught by the missing file; DELETING a case leaves an orphan
  // golden carrying stale contract data that nothing would ever open again, and no grep
  // finds that.
  const stored = new Set(cases.filter((c) => c.storedGolden).map((c) => c.name));
  const onDisk = new Set(goldenFilesOnDisk());
  for (const name of stored) {
    if (!onDisk.has(name)) problems.push(`stored case ${name} has no golden file`);
  }
  for (const name of onDisk) {
    if (!stored.has(name)) problems.push(`orphan golden ${name}.json: no case in cases.json claims it`);
  }

  if (problems.length) throw new Error(`case registry is inconsistent:\n  - ${problems.join("\n  - ")}`);
}

/**
 * Every waiver a comparison policy consumes must name a real, published allowlist entry.
 *
 * This is the enforceable half of the allowlist domain, and deliberately only that half.
 * `ALLOWLIST.md` is organised as prose scopes, and many entries govern unit tests, packaging
 * or platform gaps rather than any case — requiring bidirectional coverage over all of them
 * is unsatisfiable. What IS checkable is the direction that matters: a policy cannot waive a
 * byte comparison by citing an entry that does not exist.
 *
 * Note what this does NOT claim. It reads the document for an ID, which proves the entry was
 * written, not that any test asserts it. That weaker guarantee is stated rather than dressed
 * up, because "a name exists" was exactly the evidence `dual_run_only` offered.
 */
export function assertWaiversArePublished() {
  const doc = readFileSync(resolve(PATHS.goldens, "..", "ALLOWLIST.md"), "utf8");
  const published = new Set([...doc.matchAll(/\[(ALLOWLIST-[0-9]+[a-z]?)\]/g)].map((m) => m[1]));
  const missing = [...POLICY_CONSUMED_WAIVERS].filter((w) => !published.has(w));
  if (missing.length) {
    throw new Error(
      `comparison policies consume waivers that ALLOWLIST.md does not publish: ${missing.join(", ")}\n` +
        `  published: ${[...published].sort().join(", ") || "(none)"}`,
    );
  }
}

/**
 * The legacy `dual_run_only` escape hatch must not come back.
 *
 * Removing the runtime exclusion but leaving the field in the schema would keep the
 * documentation asserting that two cases are exempt from byte comparison — and a future
 * reader would have no way to tell a dead field from a live one.
 */
export function assertLegacyFieldsAbsent() {
  const problems = [];
  const raw = readFileSync(PATHS.casesJson, "utf8");
  if (/dual[_-]?run[_-]?only/i.test(raw)) problems.push("cases.json still mentions dual_run_only");

  for (const name of goldenFilesOnDisk()) {
    const g = JSON.parse(readFileSync(resolve(PATHS.goldens, `${name}.json`), "utf8"));
    if ("dual_run_only" in g) problems.push(`golden ${name}.json still carries dual_run_only`);
  }
  const manifest = JSON.parse(readFileSync(resolve(PATHS.goldens, "manifest.json"), "utf8"));
  if ("dualRunOnly" in manifest) problems.push("manifest.json still carries dualRunOnly");
  const notes = (manifest.notes ?? []).join("\n");
  if (/dual[_-]?run[_-]?only/i.test(notes)) problems.push("manifest notes still describe dual_run_only");

  if (problems.length) {
    throw new Error(`the dual_run_only escape hatch is not fully retired:\n  - ${problems.join("\n  - ")}`);
  }
}
