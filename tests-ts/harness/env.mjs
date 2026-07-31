/**
 * The environment both implementations run under — constructed, asserted, never inherited.
 *
 * tests/harness/parity-env.json is the contract; tests/golden/capture.py builds its child
 * environment from the same file and copies the pinned block into goldens/manifest.json.
 * This module re-reads both and refuses to run if they have drifted, so "the goldens were
 * captured under a different environment than the harness compares under" is a loud
 * failure rather than a silent one.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const PATHS = {
  usagePy: resolve(REPO, "usage.py"),
  usageWrapper: resolve(REPO, "tests", "harness", "usage-wrapper.py"),
  cliWrapper: resolve(REPO, "tests-ts", "harness", "cli-wrapper.mjs"),
  distMain: resolve(REPO, "dist", "main.js"),
  fakeCcusage: resolve(REPO, "tests", "fake_ccusage.py"),
  fixtureConfig: resolve(REPO, "tests", "fixture-config.json"),
  fixturesPy: resolve(REPO, "tests", "harness", "fixtures.py"),
  envContract: resolve(REPO, "tests", "harness", "parity-env.json"),
  goldens: resolve(REPO, "tests", "golden", "goldens"),
  stub: resolve(HERE, "stub.mjs"),
};

export const CONTRACT = JSON.parse(readFileSync(PATHS.envContract, "utf8"));
export const MANIFEST = JSON.parse(readFileSync(resolve(PATHS.goldens, "manifest.json"), "utf8"));

/**
 * Fail loudly when the recorded capture environment and the live contract disagree, and
 * when the interpreter about to act as the oracle is not the one the goldens came from.
 * @returns {string} absolute path to the verified Python interpreter
 */
export function assertEnvironmentContract() {
  const problems = [];

  if (!MANIFEST.env || !MANIFEST.envPassthrough) {
    problems.push(
      "goldens/manifest.json has no 'env' block — it predates the pinned environment. " +
        "Re-run `python3 tests/golden/capture.py`.",
    );
  } else {
    const a = JSON.stringify(MANIFEST.env);
    const b = JSON.stringify(CONTRACT.pinned);
    if (a !== b) problems.push(`manifest env ${a} != parity-env.json pinned ${b}`);
    const pa = JSON.stringify(MANIFEST.envPassthrough);
    const pb = JSON.stringify(CONTRACT.passthrough);
    if (pa !== pb) problems.push(`manifest passthrough ${pa} != parity-env.json ${pb}`);
  }

  const python = resolvePython();
  if (python.version !== MANIFEST.pythonInterpreter) {
    problems.push(
      `oracle interpreter is Python ${python.version}, goldens were captured with ` +
        `${MANIFEST.pythonInterpreter}. Set PARITY_PYTHON to the recorded interpreter.`,
    );
  }

  if (problems.length) {
    throw new Error(`parity environment contract violated:\n  - ${problems.join("\n  - ")}`);
  }
  return python.executable;
}

function resolvePython() {
  const candidate = process.env.PARITY_PYTHON || "python3";
  const r = spawnSync(candidate, ["-c", "import sys;print(sys.executable);print('.'.join(map(str,sys.version_info[:3])))"], {
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) {
    throw new Error(`cannot run the oracle interpreter ${candidate}: ${r.error?.message ?? r.stderr}`);
  }
  const [executable, version] = r.stdout.trim().split("\n");
  return { executable, version };
}

/**
 * The child environment, mirroring `child_env` in tests/golden/capture.py.
 * Only the pinned keys, the declared passthroughs, HOME and the per-case keys get through.
 */
export function childEnv(fixtureHome, extra = {}) {
  const env = { ...CONTRACT.pinned };
  for (const k of CONTRACT.passthrough) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  env.HOME = fixtureHome;
  return { ...env, ...extra };
}

/** Build the synthetic HOME + CODEX_HOME from the one Python definition both sides share. */
export function buildFixtures(python) {
  const r = spawnSync(python, [PATHS.fixturesPy, "--build"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(`fixtures.py --build failed: ${r.error?.message ?? r.stderr}`);
  }
  const paths = JSON.parse(r.stdout);
  return {
    ...paths,
    dispose() {
      for (const p of [paths.codexHome, paths.codexOutside, paths.home]) {
        rmSync(p, { recursive: true, force: true });
      }
    },
  };
}

/** Today's date in the PINNED zone — the default anchor both wrappers are given. */
export function anchorToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CONTRACT.pinned.TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
