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
 *
 * The character class is spelled out rather than left as `\s`, because the two sets differ
 * in both directions (code review R6 — the old `\s+` did not honour the equivalence this
 * comment claims). Python's `str.split()` treats the C1 separators `\x1c`-`\x1f` and `\x85`
 * as whitespace and JS's `\s` does not; conversely `\s` includes `﻿`, which Python does
 * not split on. Below is Python's set: ASCII whitespace, the C1 separators, and the Unicode
 * space separators — with `﻿` deliberately absent.
 */
const PY_WHITESPACE =
  /[\u0009\u000a\u000b\u000c\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

export function splitCommand(cmd: string): { exe: string; prefixArgs: string[] } {
  const parts = cmd.split(PY_WHITESPACE).filter((s) => s.length > 0);
  if (parts.length === 0) return { exe: "", prefixArgs: [] };
  return { exe: parts[0], prefixArgs: parts.slice(1) };
}

export interface DepsOverrides extends Partial<RuntimeDeps> {
  /**
   * The current account's passwd entry, as CPython's `~user` branch would consult it.
   * Injected rather than read here because `createDeps` performs no I/O; `bootstrapDeps`
   * supplies the real one from `os.userInfo()` (code review R8).
   */
  passwd?: Passwd;
}

/** The fields of a passwd entry this port can obtain: `pw_name` and `pw_dir`. */
export interface Passwd {
  username: string;
  homedir: string;
}

/**
 * Python's os.path.expanduser, for the leading-`~` forms this port can encounter.
 *
 * usage.py:197 is `os.path.expanduser(os.environ.get("CODEX_HOME", "~/.codex"))` — the
 * expansion applies to the OVERRIDE too, not just the default. Skipping it would leave a
 * `~`-prefixed CODEX_HOME as a *relative* path, so a decoy `./~/sessions` tree under the
 * process cwd would become the trusted session root (code review R1).
 *
 * `~user` for ANOTHER account needs `getpwnam`, which Node does not expose. Returning it
 * unchanged is NOT a safe fallback — it has the same relative-path problem, just spelled
 * `./~root/...` (code review R2) — so any other account is refused rather than silently
 * demoted to a relative trusted root. ALLOWLIST entry 10.
 *
 * The CURRENT account is a different matter: `os.userInfo()` does expose its `pw_name` and
 * `pw_dir`, so `~<current user>` is resolved from the passwd entry exactly as CPython does,
 * not from HOME (code review R8).
 *
 * The trailing-slash and empty-home handling is CPython's, not an embellishment. posixpath's
 * `expanduser` ends with:
 *
 *     userhome = userhome.rstrip('/')
 *     return (userhome + path[i:]) or '/'
 *
 * so `HOME=/tmp/foo/` yields `/tmp/foo` and `/tmp/foo/.codex` (measured), where naive
 * concatenation gives `/tmp/foo/` and `/tmp/foo//.codex`. And `HOME=""` yields `/` and
 * `/.codex` — an empty home is a *set* home there, not an unset one. Both cases reached
 * here as silent path divergences until code review R7; `homeEnc` and the codex session
 * root are both derived from this, so an off-by-one slash mis-attributes every project.
 */
export function expandUser(p: string, home: string, passwd?: Passwd): string {
  if (!p.startsWith("~")) return p;
  const slash = p.indexOf("/");
  const i = slash === -1 ? p.length : slash;

  // Bare `~` uses HOME (posixpath consults `os.environ['HOME']` first). A NAMED `~user` does
  // NOT: CPython's `~user` branch goes straight to `pwd.getpwnam(name).pw_dir` and never
  // looks at HOME at all. Resolving it from HOME — as this did until code review R8 — is a
  // silent, measured divergence, because the two are routinely different:
  //
  //   HOME=/tmp/hermetic USER=testuser CODEX_HOME=~testuser/.codex
  //     python -> /Users/testuser/.codex           port -> /tmp/hermetic/.codex
  //
  // Both exit 0 and read a DIFFERENT session tree, so `usage codex` reports different
  // numbers with nothing to indicate why. `$USER` is also not required to name the current
  // account, so comparing against it (rather than against the passwd entry) was wrong twice
  // over: `USER=root` made the port expand `~root` to the real user's HOME.
  let userhome = home;
  if (i !== 1) {
    const name = p.slice(1, i);
    // Node exposes `pw_dir`/`pw_name` for the CURRENT user only (`os.userInfo()`), never
    // `getpwnam` for an arbitrary account — so any other name is still refused, exactly as
    // ALLOWLIST entry 10 records.
    if (passwd === undefined || name !== passwd.username) {
      throw new UsageError(
        `cannot expand CODEX_HOME ${pyRepr(p)}: '~user' paths for other accounts are not ` +
          `supported. Use an absolute path.`,
      );
    }
    userhome = passwd.homedir;
  }
  // `rstrip('/')` strips EVERY trailing slash, not just one — `//` rstrips to `""`.
  return (userhome.replace(/\/+$/, "") + p.slice(i)) || "/";
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
  // Normalized through the same `expanduser` algorithm Python applies at usage.py:49, so
  // `homeEnc` below is `encode_path(os.path.expanduser("~"))` and not merely `encode_path` of
  // whatever the caller happened to pass. A trailing slash would otherwise survive into every
  // encoded project key and match nothing (code review R7).
  const home = expandUser("~", overrides.home ?? homeDir);
  const codexHome = expandUser(env.CODEX_HOME ?? "~/.codex", home, overrides.passwd);

  // There is deliberately NO default command here. The old `npx --yes ccusage@latest`
  // fallback fetched and executed registry code at run time, unpinned; leaving it reachable
  // would keep that path alive for every caller that builds deps directly, which is exactly
  // where it would be used. The composition layer must inject a resolved command instead
  // (see bootstrapDeps in src/main-deps.ts). createDeps still performs no I/O.
  const NO_COMMAND =
    "internal: no ccusage command available. Set CCUSAGE_CMD, or construct deps through " +
    "bootstrapDeps() so the bundled ccusage is resolved.";

  let exe: string;
  let prefixArgs: string[];
  // `!== undefined`, not truthiness: Python uses os.environ.get, so an explicitly EMPTY
  // CCUSAGE_CMD is a set-but-degenerate command there ("".split() == []), NOT "unset". A
  // truthy test would treat it as unset and silently substitute the bundled binary, which
  // is a different program than the user asked for (code review R2). It fails closed below.
  if (env.CCUSAGE_CMD !== undefined) {
    ({ exe, prefixArgs } = splitCommand(env.CCUSAGE_CMD));
  } else if (overrides.ccusageExe !== undefined) {
    exe = overrides.ccusageExe;
    prefixArgs = overrides.ccusagePrefixArgs ?? [];
  } else {
    throw new UsageError(NO_COMMAND);
  }

  // Fail closed on an empty executable rather than deferring it to spawnSync. A
  // whitespace-only CCUSAGE_CMD is truthy but `splitCommand` yields exe "" (Python instead
  // execs the bare subcommand name, since cmd = [] + args — see ALLOWLIST 13); an empty
  // `overrides.ccusageExe` passes the `!== undefined` test the same way. Either would
  // otherwise reach the runner and throw ERR_INVALID_ARG_VALUE (code review R1).
  if (exe === "") throw new UsageError(NO_COMMAND);

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
  // The command fields are applied AFTER the override spread, so the if/else above is the
  // single authority on precedence. Previously they sat in `base` and the spread silently
  // put `overrides.ccusageExe` back on top, which meant an override beat CCUSAGE_CMD —
  // the exact opposite of what that branch and bootstrapDeps both document (code review R1).
  return { ...base, ...overrides, ccusageExe: exe, ccusagePrefixArgs: prefixArgs };
}
