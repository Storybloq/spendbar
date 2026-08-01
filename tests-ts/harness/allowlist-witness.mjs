/**
 * Record that an allowlist entry's assertion actually RAN.
 *
 * The problem this exists for: coverage of `tests/golden/ALLOWLIST.md` used to be argued from
 * prose — an entry was "enforced" because a test with a plausible name existed somewhere. That
 * is the same "code exists, therefore it ran" reasoning this repo removed `dualRunOnly` to
 * escape. A test can be renamed, skipped, `describe`d out, or short-circuited by an early
 * return, and every one of those leaves the name in place.
 *
 * So the evidence is a side effect of EXECUTION. `witness(id)` is called at the point an
 * assertion for `id` has just succeeded, and it appends the id to a sink the coverage runner
 * reads afterwards. An entry that claims machine assertion but produces no witness is a
 * failure; the claim cannot outlive the assertion.
 *
 * The id is validated against ALLOWLIST.md on every call, sink or no sink, so a typo or a
 * reference to a deleted entry fails immediately in ordinary `node --test` runs rather than
 * only under the coverage runner.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ALLOWLIST_PATH = resolve(REPO, "tests/golden/ALLOWLIST.md");

/** Every id the allowlist actually publishes, as `[ALLOWLIST-14]` etc. */
export const PUBLISHED = new Set(
  [...readFileSync(ALLOWLIST_PATH, "utf8").matchAll(/\[ALLOWLIST-(\d+[a-z]?)\]/g)].map(
    (m) => `ALLOWLIST-${m[1]}`,
  ),
);

if (PUBLISHED.size === 0) {
  throw new Error(
    `${ALLOWLIST_PATH} publishes no [ALLOWLIST-n] ids. Either the file moved or its id format ` +
      "changed; either way every witness below would validate against an empty set and pass.",
  );
}

/** The sink, or null for an ordinary test run. Set by scripts/allowlist-coverage.mjs. */
const SINK = process.env.SPENDBAR_ALLOWLIST_WITNESS ?? null;

/**
 * Declare that an assertion for `id` has just executed successfully against `subject`.
 *
 * Call it AFTER the assertion, never before: called first, it would record the intent to check
 * rather than the fact of having checked, and an assertion that then threw would still have
 * left its witness behind.
 */
export function witness(id, { source, subject }) {
  if (!PUBLISHED.has(id)) {
    throw new Error(
      `${id} is not published in tests/golden/ALLOWLIST.md (published: ` +
        `${[...PUBLISHED].sort().join(", ")}). A witness for an unpublished id would create ` +
        "coverage for an entry no reader can look up.",
    );
  }
  if (source !== "policy" && source !== "test") {
    throw new Error(`witness(${id}) needs source "policy" or "test", got ${JSON.stringify(source)}`);
  }
  if (!subject) throw new Error(`witness(${id}) needs a subject naming what was asserted`);
  if (SINK === null) return;
  // `source` is the MECHANISM: "policy" for a comparison policy the parity harness watched
  // execute, "test" for an ordinary assertion. Without it, an id declared policy-covered is
  // satisfied by any ordinary test that happens to witness the same id, so the declaration
  // would name an enforcement mechanism nothing checks is still running.
  //
  // `subject` is the case (or artifact) the assertion ran against. Recording it turns the
  // witness from "something asserted this id" into "these named cases asserted it", which is
  // what lets the coverage runner compare against the case list ALLOWLIST.md publishes. A
  // count alone would accept the right number of the wrong cases.
  //
  // One line, opened O_APPEND. POSIX keeps a sub-PIPE_BUF append atomic, so the parity harness
  // and several concurrently-running test files interleave lines rather than corrupting them.
  appendFileSync(SINK, `${id}\t${source}\t${subject}\n`);
}
