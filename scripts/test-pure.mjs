#!/usr/bin/env node
/**
 * Run every Python-free test with python3 genuinely unreachable.
 *
 * This is the CI story for a machine that has no Python — and for the published package, whose
 * consumers certainly do not. It is not merely "the tests that happen to pass without Python":
 * the suite below runs under a PATH that has been stripped to a node-only directory, and a
 * probe confirms from inside that PATH that python3 cannot be resolved. Without that probe the
 * whole exercise would be a claim rather than a measurement — a test file that quietly found
 * python3 on the ambient PATH would pass and prove nothing.
 *
 * Every test file in tests-ts/ must be classified below EXACTLY ONCE. An unclassified file is a
 * hard error, not a default into either bucket: defaulting to "pure" would run something that
 * needs Python and blame the wrong thing, and defaulting to "needs python" would let a
 * genuinely pure file silently drop out of this suite, which is the failure mode that matters
 * because it is invisible.
 *
 * Run: npm run test:pure
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Python-free, and run here under a stripped PATH.
 *
 * Measured, not assumed: each of these was checked for a python3 spawn, and the stripped-PATH
 * run below is what keeps the classification honest as the files change.
 */
const PURE = [
  "help-snapshot.test.mjs",
  "main.test.mjs",
  "policies.test.mjs",
  "resolve.test.mjs",
  "runner.test.mjs",
  "schema-negative.test.mjs",
  "transcripts.test.mjs",
  "oracle/golden.test.mjs",
  "oracle/materialize.test.mjs",
];

/**
 * These spawn python3 directly — they compare against CPython, which is the point of them.
 * They belong to `npm test` and can never run here.
 */
const NEEDS_PYTHON = [
  "core.test.mjs",
  "fixture-schema.test.mjs",
  "pyrepr.test.mjs",
  "table.test.mjs",
  "tiebreak.test.mjs",
  "unicode-parity.test.mjs",
  "unicode-tables.test.mjs",
];

/**
 * Python-free, but they need a toolchain this stripped PATH deliberately removes: the packaging
 * contract shells out to `npm pack`, the schema contract drives the real ccusage binary, and
 * the privacy-scan suite builds real git fixture repositories.
 * Excluded here and run elsewhere (the contracts by `npm run test:contract`, the privacy-scan
 * suite by `npm test`) — recorded as its own category rather than lumped in with
 * NEEDS_PYTHON, which would misstate why they are absent.
 */
const NEEDS_TOOLCHAIN = [
  "contract/packaging.contract.mjs",
  "contract/schema.contract.mjs",
  "privacy-scan.test.mjs",
];

// ------------------------------------------------------------------ classification guard

function discover() {
  const found = [];
  for (const name of readdirSync(join(REPO, "tests-ts")).sort()) {
    if (name.endsWith(".test.mjs")) found.push(name);
  }
  for (const sub of ["oracle", "contract"]) {
    const dir = join(REPO, "tests-ts", sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".test.mjs") || name.endsWith(".contract.mjs")) found.push(`${sub}/${name}`);
    }
  }
  return found;
}

const classified = [...PURE, ...NEEDS_PYTHON, ...NEEDS_TOOLCHAIN];
const problems = [];

const counts = new Map();
for (const f of classified) counts.set(f, (counts.get(f) ?? 0) + 1);
for (const [f, n] of counts) {
  if (n > 1) problems.push(`${f} is classified ${n} times; it must appear in exactly one list.`);
}

const onDisk = discover();
for (const f of onDisk) {
  if (!counts.has(f)) {
    problems.push(
      `${f} exists but is in no list. Classify it: PURE if it never spawns python3, ` +
        `NEEDS_PYTHON if it compares against CPython, NEEDS_TOOLCHAIN if it needs npm or the ` +
        `real ccusage binary. There is deliberately no default.`,
    );
  }
}
for (const f of counts.keys()) {
  if (!onDisk.includes(f)) {
    problems.push(`${f} is classified but does not exist on disk; the list is stale.`);
  }
}
if (PURE.length === 0) problems.push("PURE is empty, so this suite would trivially pass.");

if (problems.length) {
  console.error(`\ntest:pure classification is broken (${problems.length} problem(s)):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}

// -------------------------------------------------------------------------- stripped PATH

const shim = mkdtempSync(join(tmpdir(), "spendbar-pure-bin-"));
symlinkSync(process.execPath, join(shim, "node"));

// The probe. `spawnSync("python3")` from THIS process would consult this process's PATH, so it
// would answer a question about the parent rather than about the child. Asking the child to
// resolve it is the only version of this check that measures what the tests will actually see.
const probe = spawnSync(
  process.execPath,
  [
    "-e",
    `const {spawnSync}=require("node:child_process");` +
      `const r=spawnSync("python3",["-c","print(1)"],{encoding:"utf8"});` +
      `process.stdout.write(JSON.stringify({err:r.error?r.error.code:null,status:r.status}));`,
  ],
  { env: { ...process.env, PATH: shim }, encoding: "utf8" },
);

let reachable;
try {
  reachable = JSON.parse(probe.stdout);
} catch {
  console.error(`the python3-reachability probe did not report:\n${probe.stdout}\n${probe.stderr}`);
  rmSync(shim, { recursive: true, force: true });
  process.exit(2);
}
if (reachable.err !== "ENOENT") {
  console.error(
    `python3 is still reachable from inside the stripped PATH (${JSON.stringify(reachable)}).\n` +
      `This suite exists to prove the tests below need no Python, and it cannot prove that ` +
      `while python3 is resolvable. Refusing to report a pass that would mean nothing.`,
  );
  rmSync(shim, { recursive: true, force: true });
  process.exit(2);
}

// ---------------------------------------------------------------------------------- run

console.log(
  `test:pure — ${PURE.length} file(s), python3 unreachable (ENOENT), ` +
    `${NEEDS_PYTHON.length} python-dependent and ${NEEDS_TOOLCHAIN.length} toolchain file(s) excluded`,
);

// PER FILE, not one combined run. An aggregate "# tests > 0" check is satisfied by the other
// eight files, so a file that became empty, stopped registering tests, or returned early during
// module load would contribute nothing and be invisible — while the classification guard above
// still reports it as covered. Running each on its own is the only way the zero-test check
// applies to each one.
const counts_ = [];
let failed = 0;

for (const file of PURE) {
  const r = spawnSync(process.execPath, ["--test", join("tests-ts", file)], {
    cwd: REPO,
    // The stripped PATH. TMPDIR is inherited because these tests materialize trees under it;
    // HOME is not relied on, because each test constructs the home it needs.
    env: { ...process.env, PATH: shim },
    encoding: "utf8",
  });
  const out = r.stdout ?? "";
  const num = (re) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : null;
  };
  // Distinguishing "ran nothing" from "ran something" is fiddlier than it looks. Measured:
  //   * an EMPTY file still reports `# tests 1`, because node synthesizes one top-level test
  //     for the file — so `# tests > 0` is not the check it appears to be;
  //   * counting INDENTED subtest lines does not work either, because a file whose tests are
  //     all top-level `test()` calls (no `describe`) emits them at column 0, exactly like the
  //     synthetic wrapper. That heuristic reported three real files as empty.
  // What is unambiguous is the wrapper's NAME: node names it after the file path, which no
  // real test is called. So subtract it when present.
  const rel = join("tests-ts", file);
  const wrapper = new RegExp(`^(?:not )?ok \\d+ - ${rel.replaceAll(/[.*+?^\${}()|[\]\\]/g, "\\$&")}$`, "m");
  const tests = (num(/^# tests (\d+)$/m) ?? 0) - (wrapper.test(out) ? 1 : 0);
  const skipped = num(/^# skipped (\d+)$/m);
  const todo = num(/^# todo (\d+)$/m);

  const problems = [];
  if (r.status !== 0) problems.push(`exited ${r.status}`);
  if (tests === 0) {
    problems.push(
      "registered ZERO tests of its own (node still reports `# tests 1` for the file wrapper, " +
        "and an empty run exits 0, so this is the failure mode that looks most like success)",
    );
  }
  // A skip reports as a pass at the top level, so a file that skipped everything on an
  // unsupported platform would be indistinguishable from one that ran and succeeded. That is
  // exactly the assurance this script exists to give, so a skip is an error rather than a note.
  if (skipped) problems.push(`SKIPPED ${skipped} test(s); a skip here is a failure`);
  if (todo) problems.push(`has ${todo} todo test(s), which do not count as coverage`);

  if (problems.length) {
    failed++;
    process.stdout.write(out);
    process.stderr.write(r.stderr ?? "");
    console.error(`\n  ${file}: ${problems.join("; ")}`);
  } else {
    counts_.push([file, tests]);
    console.log(`  ok  ${file} — ${tests} tests`);
  }
}

rmSync(shim, { recursive: true, force: true });

if (failed) {
  console.error(
    `\ntest:pure FAILED (${failed} of ${PURE.length} file(s)). This ran with python3 ` +
      `unreachable: a failure that does NOT reproduce under \`npm test\` means the file has a ` +
      `Python dependency and is misclassified as PURE.`,
  );
  process.exit(1);
}

const total = counts_.reduce((n, [, t]) => n + t, 0);
console.log(`test:pure OK — ${total} tests across ${PURE.length} files, 0 skipped, no Python`);
process.exit(0);
