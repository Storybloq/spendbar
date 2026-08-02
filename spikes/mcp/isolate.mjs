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

/**
 * The candidates that exist. `candidate` is interpolated into a repository path AND into a
 * mkdtemp prefix, and nothing validated it (review round 2, chunk 5): `..` or a separator in
 * that string reaches outside the candidates directory on the read side and outside the
 * intended temp subtree on the write side. The CLI that calls this was hardened one chunk ago;
 * this is the guard for every other caller, present and future.
 */
export const CANDIDATES = ["v1", "v2"];
function assertCandidate(candidate) {
  if (!CANDIDATES.includes(candidate)) {
    throw new Error(`unknown candidate '${String(candidate)}' — expected one of ${CANDIDATES.join(", ")}`);
  }
}

/** The mutation-tested scratch invariant: temporary roots never resolve inside the repo. */
export function assertOutsideRepo(path, repo = REPO) {
  const pathReal = realpathSync(path);
  const repoReal = realpathSync(repo);
  if (pathReal === repoReal || pathReal.startsWith(repoReal + sep)) {
    throw new Error(`scratch resolved inside the repository: refusing`);
  }
}

/**
 * Deterministic digest of a directory tree: one JSON record per entry (type, path, and the
 * file's own sha256 or symlink target), newline-delimited. JSON escaping is what makes the
 * stream UNAMBIGUOUS: raw concatenation of paths and file bytes would let a single file whose
 * contents mimic a record collide with two separate files (review round 1 caught exactly
 * that). This is what "the copy is a copy, not a re-resolution" means operationally — the
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
        hash.update(JSON.stringify(["L", relPath, readlinkSync(join(dir, relPath))]) + "\n");
      } else if (st.isDirectory()) {
        hash.update(JSON.stringify(["D", relPath]) + "\n");
        walk(relPath);
      } else {
        const fileHash = createHash("sha256").update(readFileSync(join(dir, relPath))).digest("hex");
        hash.update(JSON.stringify(["F", relPath, fileHash]) + "\n");
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
/**
 * Remove every live scratch root. Each one is attempted independently (review round 2, chunk
 * 5): the loop used to abort at the first rmSync exception, leaving the remaining roots on disk
 * AND — in a signal handler — throwing past the process.exit(1) that was supposed to follow, so
 * the exit handler ran next and retried the same failing entry before reaching the others.
 * Every entry leaves the set whether or not its removal worked, so nothing is retried forever.
 */
function reapScratch() {
  const failures = [];
  for (const dir of [...liveScratch]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      failures.push(`${dir}: ${error?.code ?? "unknown"}`);
    } finally {
      liveScratch.delete(dir);
    }
  }
  return failures;
}
function installReapHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", reapScratch);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      const failures = reapScratch();
      // Reported, never fatal: a scratch root that could not be removed must not stop the
      // process from leaving, and must not be silent either.
      if (failures.length) process.stderr.write(`isolate: scratch left behind — ${failures.join("; ")}\n`);
      process.exit(1);
    });
  }
}

/**
 * Copy one candidate workspace to an isolated root outside the repository.
 * Returns `{ root, resolveLog, treeSha256, cleanup }`; the caller owns cleanup (try/finally),
 * with the signal handlers above as backstop.
 *
 * `treeSha256` is the digest of the installed dependency tree this root was assembled from —
 * already computed here for the byte-identity invariant, and returned so a caller can PIN what
 * actually executed. A lockfile pins what should have been installed; only this pins what was
 * (review round 1, chunk 13: a locally modified or half-reinstalled node_modules produced a
 * capture whose lockfile digests were still perfectly valid).
 */
export function assembleCandidateRoot(candidate, { repo = REPO } = {}) {
  assertCandidate(candidate);
  const candidateDir = join(HERE, "candidates", candidate);
  installReapHandlers();

  // Everything from the first mkdtemp onward is guarded: a failure in the SECOND creation,
  // a chmod, or an invariant check must still remove whatever was already created.
  const made = [];
  const cleanup = () => {
    for (const dir of made) {
      rmSync(dir, { recursive: true, force: true });
      liveScratch.delete(dir);
    }
  };

  try {
    const makeDir = (suffix) => {
      const dir = mkdtempSync(join(tmpdir(), `mcp-iso-${candidate}${suffix}-`));
      made.push(dir);
      liveScratch.add(dir);
      chmodSync(dir, 0o700);
      assertOutsideRepo(dir, repo);
      return dir;
    };
    const root = makeDir("");
    const scratch = makeDir("-log");

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
    return { root, resolveLog: join(scratch, "resolve.ndjson"), treeSha256: source, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * The digest of a candidate's installed dependency tree, as it stands right now. The receipt
 * recomputes this and compares it against the pin the capture took, so "the server ran from the
 * dependencies this repository currently holds" is checked rather than assumed.
 */
export function candidateTreeDigest(candidate) {
  assertCandidate(candidate);
  return treeDigest(join(HERE, "candidates", candidate, "node_modules"));
}

/**
 * Construct the candidate server's environment per the §2 contract, and assert the forbidden
 * credential names are absent from what was constructed — with `extra` being how the
 * mutation test proves the assertion can fail (and how the offline exfiltration fixture
 * seeds its canary).
 */
export function buildServerEnv({ resolveLog, unaudited = null, extra = {} } = {}) {
  // Instrumentation used to be OPTIONAL BY OMISSION (review round 2, chunk 5): `buildServerEnv({})`
  // returned a perfectly valid-looking environment with no SPENDBAR_RESOLVE_LOG, so a candidate
  // could execute with none of its resolutions recorded and nothing downstream would know the
  // audit had not happened. That is exactly how the real-client captures run — and it was
  // invisible at the call site. Not auditing is still allowed; being silent about it is not.
  if (!resolveLog && !unaudited) {
    throw new Error(
      "buildServerEnv: pass `resolveLog` to audit this candidate's resolutions, or `unaudited: \"<reason>\"` " +
        "to state on the record that this execution is not audited",
    );
  }
  if (resolveLog && unaudited) throw new Error("buildServerEnv: a run is either audited or not, never both");
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
      // Only node: builtins are permitted. A data: URL is executable code from nowhere on
      // disk — not a builtin and not inside the root — so it is a violation like any other
      // non-file scheme (review round 1).
      if (entry.resolved.startsWith("node:")) {
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
  // An empty log was the only vacuous case this refused, and it was not the only one (review
  // round 2, chunk 5). A log of nothing but `node:` builtins is equally uninformative: it proves
  // the instrument loaded and proves NOTHING about where the candidate's own closure came from,
  // yet it returned zero violations and read as a clean audit. A server that resolved not one
  // file inside its own root did not demonstrate isolation; it demonstrated that it never got
  // as far as loading itself.
  if (inside === 0) {
    throw new Error(
      `resolution log has ${builtins} builtin resolution(s) and none inside the root — ` +
        `nothing about the candidate's own closure was observed`,
    );
  }
  // The three buckets are exhaustive by construction. Asserting it here means a future edit
  // that adds a fourth path cannot silently drop entries out of the audit.
  if (builtins + inside + violations.length !== lines.length) {
    throw new Error(`resolution log accounting does not add up: ${lines.length} lines, ${builtins + inside + violations.length} classified`);
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
