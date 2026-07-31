/**
 * Runtime dependencies and bootstrapped context.
 *
 * usage.py holds these as module-level globals evaluated at import (_SCRIPT_DIR,
 * CONFIG_PATH, CCUSAGE, HOME_ENC, CODEX_HOME, and RENAMES/WORKSPACE_ROOTS/LEGACY_GROUPS
 * from a load_config() call at import time). A pure core cannot do that: importing a
 * module must not read the filesystem or the environment.
 *
 * So the split is explicit (plan review F6):
 *   RuntimeDeps  — immutable, performs NO I/O; everything injectable for tests
 *   bootstrap()  — the ONLY function that reads config, returning Ctx = { deps, config }
 */
import { encodePath } from "./config.js";
import { UsageError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";

/** Result of one ccusage invocation. Injected so tests never spawn a process. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned at all (ENOENT etc). */
  spawnError?: NodeJS.ErrnoException;
}

export type CcusageRunner = (exe: string, args: string[]) => RunResult;

export interface RuntimeDeps {
  /** Absolute home directory. */
  home: string;
  /** `encodePath(home)` — the prefix ccusage encodes into project directory names. */
  homeEnc: string;
  /** Where the config JSON lives (USAGE_CONFIG override, else the default path). */
  configPath: string;
  /** Executable to spawn, and any prefix args before ours (from CCUSAGE_CMD). */
  ccusageExe: string;
  ccusagePrefixArgs: string[];
  /** $CODEX_HOME, default ~/.codex. */
  codexHome: string;
  /** Today's local date as YYYYMMDD — injected so relative-date tests are deterministic. */
  today: () => string;
  /** Warning sink. Never `console` in the core. */
  warn: (msg: string) => void;
  /** Spawns ccusage. */
  runner: CcusageRunner;
}

export interface Config {
  renames: Record<string, string>;
  workspaceRoots: string[];
  legacyGroups: Record<string, string>;
}

export interface Ctx {
  deps: RuntimeDeps;
  config: Config;
}

export const DEFAULT_CONFIG: Config = {
  renames: {},
  workspaceRoots: ["Developer"],
  legacyGroups: {},
};

/**
 * Split a CCUSAGE_CMD string the way Python's `str.split()` does (any run of whitespace,
 * no quote handling). Keeping the same splitting rule preserves the frozen `cmd:` line in
 * error diagnostics. The result is used as executable + prefix argv with `shell:false`,
 * so the string is never handed to a shell.
 */
export function splitCommand(cmd: string): { exe: string; prefixArgs: string[] } {
  const parts = cmd.split(/\s+/).filter((s) => s.length > 0);
  if (parts.length === 0) return { exe: "", prefixArgs: [] };
  return { exe: parts[0], prefixArgs: parts.slice(1) };
}

export interface DepsOverrides extends Partial<RuntimeDeps> {}

/**
 * Python's os.path.expanduser, for the leading-`~` forms this port can encounter.
 *
 * usage.py:197 is `os.path.expanduser(os.environ.get("CODEX_HOME", "~/.codex"))` — the
 * expansion applies to the OVERRIDE too, not just the default. Skipping it would leave a
 * `~`-prefixed CODEX_HOME as a *relative* path, so a decoy `./~/sessions` tree under the
 * process cwd would become the trusted session root (code review R1).
 *
 * `~user` needs a passwd lookup Node does not expose. Returning it unchanged is NOT a safe
 * fallback — it has the same relative-path problem, just spelled `./~root/...` (code
 * review R2) — so the only `~user` accepted is the current user's own name, and anything
 * else is refused rather than silently demoted to a relative trusted root.
 * ALLOWLIST entry 10.
 */
export function expandUser(p: string, home: string, username?: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  if (!p.startsWith("~")) return p;
  const slash = p.indexOf("/");
  const name = slash === -1 ? p.slice(1) : p.slice(1, slash);
  if (username !== undefined && name === username) {
    return slash === -1 ? home : home + p.slice(slash);
  }
  throw new UsageError(
    `cannot expand CODEX_HOME ${pyRepr(p)}: '~user' paths for other accounts are not ` +
      `supported. Use an absolute path.`,
  );
}

/**
 * Build RuntimeDeps from an environment map. Performs NO I/O — not even a stat.
 */
export function createDeps(
  env: Record<string, string | undefined>,
  homeDir: string,
  runner: CcusageRunner,
  overrides: DepsOverrides = {},
): RuntimeDeps {
  const home = overrides.home ?? homeDir;
  const ccusageCmd = env.CCUSAGE_CMD ?? "npx --yes ccusage@latest";
  const { exe, prefixArgs } = splitCommand(ccusageCmd);
  const codexHome = expandUser(env.CODEX_HOME ?? "~/.codex", home, env.USER);

  const base: RuntimeDeps = {
    home,
    homeEnc: encodePath(home),
    // Deliberate divergence (ALLOWLIST #5): the Python default is "next to the script",
    // which under a global npm install lands inside node_modules. The env override is
    // unchanged and remains byte-frozen.
    configPath: env.USAGE_CONFIG ?? `${home}/.config/spendbar/config.json`,
    ccusageExe: exe,
    ccusagePrefixArgs: prefixArgs,
    codexHome,
    today: () => {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}${m}${dd}`;
    },
    warn: () => {},
    runner,
  };
  return { ...base, ...overrides };
}
