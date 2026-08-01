#!/usr/bin/env node
/**
 * Compute ALLOWLIST coverage from EXECUTION, not from prose.
 *
 * Before this existed, an allowlist entry counted as enforced if a test with a plausible name
 * could be pointed at. That is the "code exists, therefore it ran" argument this repo removed
 * `dualRunOnly` to escape: a test can be renamed, skipped, `describe`d out, or short-circuited
 * by an early return, and the name survives all four.
 *
 * So this runs the suites with a witness sink, collects the ids that actually recorded
 * themselves at the moment their assertion succeeded, and compares that set against what
 * tests/golden/allowlist-assertions.json claims. Both directions are errors:
 *
 *   claimed but not witnessed  — the assertion did not run. The claim is false.
 *   witnessed but not claimed  — something asserts an id the declaration does not mention,
 *                                so the declaration has drifted from the tests.
 *
 * Run: npm run test:allowlist
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DECL = JSON.parse(readFileSync(join(REPO, "tests/golden/allowlist-assertions.json"), "utf8"));
const ALLOWLIST = readFileSync(join(REPO, "tests/golden/ALLOWLIST.md"), "utf8");

const published = new Set(
  [...ALLOWLIST.matchAll(/\[ALLOWLIST-(\d+[a-z]?)\]/g)].map((m) => `ALLOWLIST-${m[1]}`),
);

/**
 * The cases ALLOWLIST.md itself publishes per id, from its "Cases covered by" lists.
 *
 * These lists are already checked against the registry, but that only says the document and
 * the data agree about which cases CITE an id — not that an assertion ran on each of them. The
 * witnesses close that: a policy that quietly stopped asserting on half its cases would still
 * satisfy every name check while emitting half the witnesses.
 */
const documentedCases = new Map();
for (const m of ALLOWLIST.matchAll(
  /\*\*Cases covered by `\[ALLOWLIST-(\d+[a-z]?)\]`:\*\*(.*?)(?:\n\s*\n)/gs,
)) {
  documentedCases.set(
    `ALLOWLIST-${m[1]}`,
    new Set([...m[2].matchAll(/`([a-z0-9_]+)`/g)].map((c) => c[1])),
  );
}

const problems = [];
const declared = DECL.ids;

// ---------------------------------------------------------------- the declaration itself

for (const id of published) {
  if (!(id in declared)) {
    problems.push(
      `${id} is published in ALLOWLIST.md but absent from allowlist-assertions.json. Declare ` +
        "its mode (policy, witness, or none-with-a-reason); there is deliberately no default.",
    );
  }
}
for (const id of Object.keys(declared)) {
  if (!published.has(id)) {
    problems.push(`${id} is declared but ALLOWLIST.md does not publish it; the declaration is stale.`);
  }
  const d = declared[id];
  // The vocabulary is closed. Without this, a typo ("polcy") falls through every branch below
  // and is treated as asserted — it would pass on any witness at all, and the declaration
  // contract would drift silently, which is the exact failure this file exists to prevent.
  if (!["policy", "witness", "none"].includes(d?.mode)) {
    problems.push(
      `${id} declares mode ${JSON.stringify(d?.mode)}; it must be exactly one of policy, ` +
        "witness, none.",
    );
    continue;
  }
  if (d.mode === "none" && !d.why) {
    problems.push(`${id} is declared unasserted with no reason. An unexplained gap is not a decision.`);
  }
  if (d.mode === "witness" && !(Array.isArray(d.requiredSubjects) && d.requiredSubjects.length)) {
    problems.push(
      `${id} is witness-mode but lists no requiredSubjects. Without them the check degrades to ` +
        `"at least one witness", and deleting one of several assertion sites would pass.`,
    );
  }
}
if (published.size === 0) problems.push("ALLOWLIST.md publishes no ids; nothing could be checked.");

if (problems.length) {
  report(problems);
  process.exit(1);
}

// ------------------------------------------------------------------------------ execute

const sinkDir = mkdtempSync(join(tmpdir(), "spendbar-allowlist-"));
const sink = join(sinkDir, "witnessed.txt");
writeFileSync(sink, "");
const env = { ...process.env, SPENDBAR_ALLOWLIST_WITNESS: sink };

// Both halves are needed and neither substitutes for the other: the `policy` ids are witnessed
// by the parity harness as it compares real cases, and the `witness` ids by ordinary test files
// that have no parity case at all. Running only one would silently zero the other's coverage.
const runs = [
  ["parity", [join("tests-ts", "parity.mjs"), "--final"]],
  ["node --test", ["--test", join("tests-ts", "help-snapshot.test.mjs")]],
];

let ran = 0;
for (const [label, args] of runs) {
  const r = spawnSync(process.execPath, args, { cwd: REPO, env, encoding: "utf8" });
  if (r.status !== 0) {
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    console.error(
      `\n${label} failed, so the witness set is incomplete and coverage cannot be computed. ` +
        "Reporting the failure rather than a coverage number derived from a partial run.",
    );
    rmSync(sinkDir, { recursive: true, force: true });
    process.exit(1);
  }
  ran++;
}

const witnessed = new Map();
if (existsSync(sink)) {
  for (const line of readFileSync(sink, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const [id, source = "", subject = ""] = line.split("\t");
    if (!witnessed.has(id)) witnessed.set(id, new Map());
    if (!witnessed.get(id).has(source)) witnessed.get(id).set(source, new Set());
    witnessed.get(id).get(source).add(subject);
  }
}
rmSync(sinkDir, { recursive: true, force: true });

// ------------------------------------------------------------------------------ compare

if (witnessed.size === 0) {
  report([
    `${ran} suite(s) ran and recorded NO witnesses at all. Either the sink is not being ` +
      "written or witness() has stopped being called; both would make every check below pass " +
      "vacuously, so this is reported as a failure rather than as zero coverage.",
  ]);
  process.exit(1);
}

for (const [id, d] of Object.entries(declared)) {
  const bySource = witnessed.get(id) ?? new Map();
  // The declared MODE must be the mechanism that actually witnessed. An id declared
  // policy-covered is otherwise satisfied by any ordinary test witnessing the same id, so the
  // named enforcement mechanism could be gone entirely while coverage still read green.
  const wantSource = d.mode === "policy" ? "policy" : "test";
  const subjects = bySource.get(wantSource) ?? new Set();
  const n = subjects.size;
  const wrongSource = [...bySource.keys()].filter((src) => src !== wantSource);
  if (d.mode !== "none" && wrongSource.length) {
    problems.push(
      `${id} is declared ${d.mode}, so it must be witnessed by ${wantSource}, but ` +
        `${wrongSource.join(", ")} also witnessed it. Either the declaration names the wrong ` +
        "mechanism or something else is asserting this entry.",
    );
  }
  if (d.mode === "none") {
    if (n > 0) {
      problems.push(
        `${id} is declared unasserted, but ${n} assertion(s) witnessed it. The declaration ` +
          "understates what the tests do — promote it to policy or witness.",
      );
    }
    continue;
  }
  if (n === 0) {
    problems.push(
      `${id} claims mode "${d.mode}" but NO ${wantSource} witnessed it. The assertion did not run: it ` +
        "may have been renamed, skipped, or short-circuited. The claim is false as it stands.",
    );
    continue;
  }

  // For a policy id, the witnesses must be exactly the cases the document publishes. Comparing
  // the SET rather than the count matters: the right number of the wrong cases would otherwise
  // pass, and that is the shape a copy-paste in the case registry produces.
  if (d.mode === "witness") {
    const want = new Set(d.requiredSubjects);
    const missing = [...want].filter((x) => !subjects.has(x)).sort();
    const extra = [...subjects].filter((x) => !want.has(x)).sort();
    if (missing.length) {
      problems.push(
        `${id}: required assertion site(s) did not fire — ${missing.join(", ")}. Another site ` +
          "still witnessed the id, which is exactly why per-site subjects are required.",
      );
    }
    if (extra.length) {
      problems.push(
        `${id}: witnessed by undeclared site(s) — ${extra.join(", ")}. Add them to ` +
          "requiredSubjects so they are covered by this check too.",
      );
    }
    continue;
  }

  const doc = documentedCases.get(id);
  if (d.mode === "policy") {
    if (doc === undefined) {
      problems.push(
        `${id} is a policy id but ALLOWLIST.md publishes no "Cases covered by" list for it, so ` +
          "there is nothing to compare the witnesses against.",
      );
      continue;
    }
    const missing = [...doc].filter((c) => !subjects.has(c)).sort();
    const extra = [...subjects].filter((c) => !doc.has(c)).sort();
    if (missing.length) {
      problems.push(
        `${id}: ALLOWLIST.md lists ${missing.length} case(s) that emitted no witness — ` +
          `${missing.join(", ")}. The document claims coverage the run did not produce.`,
      );
    }
    if (extra.length) {
      problems.push(
        `${id}: ${extra.length} case(s) asserted it that the document does not list — ` +
          `${extra.join(", ")}. Add them, or the published scope understates what is enforced.`,
      );
    }
  }
}
for (const id of witnessed.keys()) {
  if (!(id in declared)) {
    problems.push(`${id} was witnessed but is not declared; the declaration has drifted.`);
  }
}

if (problems.length) {
  report(problems);
  process.exit(1);
}

const unasserted = Object.entries(declared).filter(([, d]) => d.mode === "none");
const summary = Object.entries(declared)
  .map(([id, d]) => {
    const src = d.mode === "policy" ? "policy" : "test";
    const n = (witnessed.get(id)?.get(src) ?? new Set()).size;
    return `  ${id.padEnd(15)} ${d.mode.padEnd(8)} ${d.mode === "none" ? "unwitnessed, as declared" : `${n} subject(s) via ${src}`}`;
  })
  .sort();
// Worded to say what was actually established. "every declared id was witnessed" would be
// false the moment a `none` entry exists, and those are precisely the entries a reader most
// needs to see rather than have folded into a pass.
console.log(
  `allowlist coverage OK — every ASSERTED id was witnessed by the mechanism it declares, and ` +
    `${unasserted.length} declared-unasserted id(s) stayed unwitnessed\n${summary.join("\n")}`,
);

function report(list) {
  console.error(`\nallowlist coverage FAILED (${list.length} problem(s)):\n`);
  for (const p of list) console.error(`  - ${p}`);
  console.error(
    "\nCoverage here is computed from witnesses emitted at the moment an assertion succeeds. " +
      "A name in a test file is not evidence and will not satisfy this check.",
  );
}
