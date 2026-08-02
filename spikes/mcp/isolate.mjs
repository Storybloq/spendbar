// Candidate isolation (plan §2): assembled temporary roots, an exact environment allowlist,
// and positive proof that a candidate's closure resolved entirely within itself.
//
// Why assembly exists: Node resolution walks UPWARD. A candidate workspace sitting under the
// repository can reach the repo's own node_modules and resolve a transitive package from there
// while the opposite top-level SDK stays absent — so an opposite-SDK probe alone proves
// nothing. Candidates therefore execute from a copied root outside the repository, where there
// is no ancestor node_modules to walk into, and every resolution the process actually made is
// enumerated and checked against the root (instrument.mjs, both ESM and CJS paths).

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = realpathSync(join(HERE, "..", ".."));

// The files an isolated root consists of — the verified installation plus the spike sources,
// and nothing else. `probe-def.mjs` and the instrument are canonical at spikes/mcp/ and are
// copied in so the servers' relative imports resolve inside the root.
const WORKSPACE_FILES = ["package.json", "package-lock.json", "server.mjs"];
const SHARED_FILES = ["probe-def.mjs", "instrument.mjs", "instrument-hooks.mjs"];

// §2's environment contract: the child env is CONSTRUCTED from these literal lists — copy
// exactly these names from the parent, add exactly the values the caller supplies. It is never
// process.env spread-and-filtered, so a new variable in the parent cannot appear by default.
export const ENV_ALLOWLIST = ["PATH"];
export const FORBIDDEN_ENV = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

/** The mutation-tested scratch invariant: temporary roots never resolve inside the repo. */
export function assertOutsideRepo(path, repo = REPO) {
  if (realpathSync(path).startsWith(realpathSync(repo) + sep)) {
    throw new Error(`scratch resolved inside the repository: refusing`);
  }
}

/**
 * Deterministic digest of a directory tree: sorted relative paths, file bytes, symlink
 * targets. This is what "the copy is a copy, not a re-resolution" means operationally — the
 * assembled root's node_modules must digest identically to the integrity-verified install.
 */
export function treeDigest(dir) {
  const hash = createHash("sha256");
  const walk = (rel) => {
    const abs = join(dir, rel);
    const entries = readdirSync(abs, { withFileTypes: true })
      .map((e) => e.name)
      .sort();
    for (const name of entries) {
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, relPath));
      if (st.isSymbolicLink()) {
        hash.update(`L ${relPath} ${readlinkSync(join(dir, relPath))}\n`);
      } else if (st.isDirectory()) {
        hash.update(`D ${relPath}\n`);
        walk(relPath);
      } else {
        hash.update(`F ${relPath} `);
        hash.update(readFileSync(join(dir, relPath)));
        hash.update("\n");
      }
    }
  };
  walk("");
  return hash.digest("hex");
}

// §2 requires cleanup on success, failure, signal and timeout. try/finally in callers covers
// the first two and disposes children on the third-party deadline; these handlers cover a
// signal arriving between them.
const liveScratch = new Set();
let handlersInstalled = false;
function reapScratch() {
  for (const dir of liveScratch) rmSync(dir, { recursive: true, force: true });
  liveScratch.clear();
}
function installReapHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", reapScratch);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      reapScratch();
      process.exit(1);
    });
  }
}

/**
 * Copy one candidate workspace to an isolated root outside the repository.
 * Returns `{ root, resolveLog, cleanup }`; the caller owns cleanup (try/finally), with the
 * signal handlers above as backstop.
 */
export function assembleCandidateRoot(candidate, { repo = REPO } = {}) {
  const candidateDir = join(HERE, "candidates", candidate);
  installReapHandlers();

  const root = mkdtempSync(join(tmpdir(), `mcp-iso-${candidate}-`));
  const scratch = mkdtempSync(join(tmpdir(), `mcp-iso-${candidate}-log-`));
  for (const dir of [root, scratch]) {
    chmodSync(dir, 0o700);
    liveScratch.add(dir);
    assertOutsideRepo(dir, repo);
  }

  const cleanup = () => {
    for (const dir of [root, scratch]) {
      rmSync(dir, { recursive: true, force: true });
      liveScratch.delete(dir);
    }
  };

  try {
    for (const f of WORKSPACE_FILES) copyFileSync(join(candidateDir, f), join(root, f));
    for (const f of SHARED_FILES) copyFileSync(join(HERE, f), join(root, f));
    cpSync(join(candidateDir, "node_modules"), join(root, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    // The byte-identity invariant, checked rather than assumed.
    const source = treeDigest(join(candidateDir, "node_modules"));
    const copied = treeDigest(join(root, "node_modules"));
    if (source !== copied) {
      throw new Error(`assembled ${candidate} root differs from the verified install`);
    }
    return { root, resolveLog: join(scratch, "resolve.ndjson"), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Construct the candidate server's environment per the §2 contract, and assert the forbidden
 * credential names are absent from what was constructed — with `extra` being how the
 * mutation test proves the assertion can fail (and how the offline exfiltration fixture
 * seeds its canary).
 */
export function buildServerEnv({ resolveLog, extra = {} } = {}) {
  const env = {};
  for (const name of ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (resolveLog) env.SPENDBAR_RESOLVE_LOG = resolveLog;
  Object.assign(env, extra);
  for (const name of FORBIDDEN_ENV) {
    if (name in env) {
      throw new Error(`constructed environment contains forbidden credential variable ${name}`);
    }
  }
  return env;
}

/**
 * Check an instrument resolution log against an isolated root: every filesystem-backed
 * resolution must land inside the root; Node built-ins are allowed; nothing else is. A log
 * with zero entries is an error, not a pass — an unwritten log means the instrument did not
 * run, and reporting "no violations" would be the vacuous-skip this project forbids.
 */
export function checkResolutions(logPath, root) {
  const rootReal = realpathSync(root);
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("resolution log is empty — instrument did not run");
  let builtins = 0;
  let inside = 0;
  const violations = [];
  for (const line of lines) {
    const entry = JSON.parse(line); // malformed log lines are a hard error, deliberately
    let filePath = null;
    if (entry.kind === "esm") {
      if (entry.resolved.startsWith("node:") || entry.resolved.startsWith("data:")) {
        builtins++;
        continue;
      }
      if (!entry.resolved.startsWith("file:")) {
        violations.push(entry);
        continue;
      }
      filePath = fileURLToPath(entry.resolved);
    } else if (entry.kind === "cjs") {
      if (isBuiltin(entry.resolved)) {
        builtins++;
        continue;
      }
      filePath = entry.resolved;
    } else {
      throw new Error(`unknown resolution kind in log: ${entry.kind}`);
    }
    const real = realpathSync(filePath);
    if (real === rootReal || real.startsWith(rootReal + sep)) {
      inside++;
    } else {
      violations.push(entry);
    }
  }
  return { total: lines.length, builtins, inside, violations };
}

/**
 * The opposite-SDK probe (§2: one mutation among several, not the proof): resolve a bare
 * specifier with a require anchored INSIDE the given root. Returns the resolved path, or
 * throws MODULE_NOT_FOUND — which is what each candidate must do for the other's SDK.
 */
export function resolveFromRoot(root, specifier) {
  return createRequire(pathToFileURL(join(root, "server.mjs"))).resolve(specifier);
}
