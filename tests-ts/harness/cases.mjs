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
    golden: c.storedGolden ? readGolden(c.name, c) : undefined,
  }));
}

/**
 * Load a golden AND check that it describes the case it is filed under.
 *
 * The record used to be returned as `record` and never read by anything (code review R2), so
 * the JS harness compared only bytes: a stored case's `captureAnchor` could be edited in
 * cases.json and 43 of the 45 replays still reproduced byte-for-byte, because most goldens do
 * not embed the date. Only `capture.py --check` noticed, and that is a manual step.
 *
 * A golden's own metadata is an independent recording of the invocation. Comparing it against
 * the registry is what turns "these bytes match" into "these bytes match, and they were
 * produced by the invocation this case declares".
 */
function readGolden(name, c) {
  const g = JSON.parse(readFileSync(resolve(PATHS.goldens, `${name}.json`), "utf8"));
  const disagreements = [];
  const claim = (field, stored, declared) => {
    if (JSON.stringify(stored) !== JSON.stringify(declared)) {
      disagreements.push(`${field}: golden has ${JSON.stringify(stored)}, cases.json declares ${JSON.stringify(declared)}`);
    }
  };
  claim("name", g.name, name);
  claim("argv", g.argv, c.argv);
  claim("mode", g.mode, c.mode);
  claim("extra_env", g.extra_env, c.extraEnv);
  claim("codex_fixture", g.codex_fixture, c.codexFixture);
  claim("capture_anchor", g.capture_anchor, c.captureAnchor);
  claim("exit", g.exit, c.expectExit);
  if (disagreements.length) {
    throw new Error(
      `golden ${name}.json does not describe the case it is filed under:\n  - ` +
        disagreements.join("\n  - ") +
        `\n  Re-capture with: python3 tests/golden/capture.py`,
    );
  }
  return { stdout: g.stdout, stderr: g.stderr };
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

    // TYPES, not just presence. Every field below feeds something that would otherwise accept
    // the wrong shape silently (code review R2):
    //
    //   `codexFixture` is read for TRUTHINESS by capture.py and the harness, so the string
    //   "false" sets CODEX_HOME on both sides — and the case then agrees with itself while
    //   exercising the opposite fixture from the one it names.
    //
    //   `storedGolden` decides whether a case has a golden at all, so a truthy non-boolean
    //   silently reclassifies it.
    //
    //   `argv` is spread into a subprocess argument list, where a non-string member is a
    //   different kind of failure entirely.
    //
    // `mode` is deliberately NOT value-checked here. Its vocabulary belongs to
    // tests/fake_ccusage.py, which now rejects an unknown FAKE_MODE outright rather than
    // falling back to a default fixture; validating it in two places is how the two
    // descriptions drift apart, which is the defect this whole ticket exists to remove.
    for (const [field, ok, want] of [
      ["codexFixture", typeof raw.codexFixture === "boolean", "a boolean"],
      ["storedGolden", typeof raw.storedGolden === "boolean", "a boolean"],
      ["mode", typeof raw.mode === "string" && raw.mode.length > 0, "a non-empty string"],
      ["extraEnv", raw.extraEnv !== null && typeof raw.extraEnv === "object" && !Array.isArray(raw.extraEnv),
       "an object"],
      ["argv", Array.isArray(raw.argv) && raw.argv.every((a) => typeof a === "string"),
       "an array of strings"],
    ]) {
      if (field in raw && !ok) {
        problems.push(`case ${raw.name}: ${field} must be ${want}, got ${JSON.stringify(raw[field])}`);
      }
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

    // No separate "names a waiver no policy consumes" check. Every input that would trip it
    // has already been reported by the policy/waiver agreement above — an unknown policy name
    // pushes one problem, and a known policy whose waiverId differs pushes another (code
    // review R2 demonstrated both reachable shapes). A third message for the same defect is a
    // branch no test can kill.

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
 * Parse the machine-readable scope declarations out of ALLOWLIST.md.
 *
 * Format, one per ID'd entry, visible in the rendered document on purpose:
 *
 *   **Cases covered by `[ALLOWLIST-19]`:** `case_a`, `case_b`, …
 *
 * Visible rather than an HTML comment because the point is that the DOCUMENT states its own
 * scope. A hidden marker is one an editor revising the prose would not think to update.
 */
export function parseWaiverScopes(doc) {
  const scopes = new Map();
  const re = /\*\*Cases covered by `\[(ALLOWLIST-[0-9]+[a-z]?)\]`:\*\*([\s\S]*?)(?:\n\s*\n|$)/g;
  for (const m of doc.matchAll(re)) {
    const names = [...m[2].matchAll(/`([A-Za-z0-9_]+)`/g)].map((n) => n[1]);
    scopes.set(m[1], new Set(names));
  }
  return scopes;
}

/**
 * Every waived comparison must be authorised by an entry whose published SCOPE covers it.
 *
 * This used to check only that the ID string appeared somewhere in the document. That is how
 * `argv_blocks_array` came to cite `[ALLOWLIST-19]` — an entry scoped to
 * `hourly --date <value fromisoformat rejects>` — while actually being a `blocks` case dying
 * on an AttributeError, and how `[ALLOWLIST-23]` came to cover a second case it never named
 * (code review R2). The ticket's headline claim was that a comparison cannot grant itself a
 * licence nothing authorised; with an existence check, "authorised" meant "the ID is spelled
 * somewhere in a 500-line file".
 *
 * So the check reads the scope and requires exact set agreement, in BOTH directions:
 *
 *   - a case citing an ID must be NAMED by that entry — otherwise the entry's prose describes
 *     one situation while the harness applies it to another;
 *   - a name in an entry must be a real case citing that ID — otherwise a rename or deletion
 *     leaves the document promising coverage that no longer exists, which reads as authority
 *     to anyone who greps for the case name.
 *
 * Still deliberately NOT claimed: that any test asserts the entry's prose. This proves the
 * scope is agreed, not that the behaviour is measured.
 */
export function assertWaiversArePublished(cases = loadCases()) {
  const doc = readFileSync(resolve(PATHS.goldens, "..", "ALLOWLIST.md"), "utf8");
  const scopes = parseWaiverScopes(doc);
  const problems = [];

  for (const w of POLICY_CONSUMED_WAIVERS) {
    if (!scopes.has(w)) {
      problems.push(
        `${w} is consumed by a comparison policy but ALLOWLIST.md publishes no scope for it ` +
          `(expected a "**Cases covered by \`[${w}]\`:**" line)`,
      );
    }
  }

  const declared = new Map();
  for (const c of cases) {
    if (!c.waiver) continue;
    if (!declared.has(c.waiver)) declared.set(c.waiver, new Set());
    declared.get(c.waiver).add(c.name);
  }

  for (const [id, scope] of scopes) {
    const actual = declared.get(id) ?? new Set();
    for (const name of actual) {
      if (!scope.has(name)) {
        problems.push(`case ${name} cites ${id}, but that entry's published scope does not name it`);
      }
    }
    for (const name of scope) {
      if (!actual.has(name)) {
        problems.push(`${id} claims to cover ${name}, but no case cites ${id} under that name`);
      }
    }
  }

  if (problems.length) {
    throw new Error(`allowlist scope disagrees with the case registry:\n  - ${problems.join("\n  - ")}`);
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

  // The comparison flags this ticket replaced with named policies. Hunting them in
  // ALLOWLIST.md too, not just in the data: the guard previously watched cases.json and the
  // goldens only, so the published contract went on telling readers that cases "carry
  // `compareStderr: false`" for a full ticket after the field stopped existing (code review
  // R2). A retired field surviving in the DOCUMENT is the worse half of the problem — the
  // data is read by machines that would notice, and the prose is read by people who would not.
  //
  // The convention this enforces: a retired field is named in PLAIN PROSE, never in a code
  // span. Backticks mark a live identifier the reader could go and find, so `compareStderr`
  // is a promise the codebase no longer keeps, while "compareStderr" in running text is
  // ordinary history. That makes the rule mechanical instead of a judgement about tone.
  //
  // `rewrite` is deliberately not on the list: it is an ordinary English word used throughout
  // the document in its normal sense, so matching it would be noise rather than signal.
  const RETIRED = ["compareStderr", "partialStdout", "dual_run_only", "dualRunOnly"];
  const doc = readFileSync(resolve(PATHS.goldens, "..", "ALLOWLIST.md"), "utf8");
  for (const [where, text] of [["cases.json", raw], ["ALLOWLIST.md", doc]]) {
    // Whole code SPANS, not a leading backtick. `manifest.dualRunOnly` is a reference to a
    // retired field however it is qualified, and a leading-backtick test would miss it.
    for (const span of text.matchAll(/`([^`\n]+)`/g)) {
      for (const field of RETIRED) {
        if (new RegExp(`\\b${field}\\b`).test(span[1])) {
          problems.push(`${where} refers to the retired field ${field} as live code: \`${span[1]}\``);
        }
      }
    }
  }

  if (problems.length) {
    throw new Error(`the pre-T-005 comparison flags are not fully retired:\n  - ${problems.join("\n  - ")}`);
  }
}
