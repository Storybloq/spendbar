/**
 * Composition layer: the only place that resolves the real ccusage and the real runner.
 *
 * `createDeps` is pure and has no default command (see the comment there); this module
 * supplies one. Precedence matches the Python original: an explicit `CCUSAGE_CMD` always
 * wins, and only in its absence do we resolve the bundled dependency — fail-closed, with no
 * network fallback.
 */
import { userInfo } from "node:os";
import { createDeps, type RuntimeDeps, type DepsOverrides, type Passwd } from "./context.js";
import { resolveBundledCcusage, type Resolved } from "./resolve-ccusage.js";
import { runner as defaultRunner } from "./runner.js";

export interface BootstrapOptions {
  /**
   * Injected for tests. This module's skip-resolution rule is otherwise unobservable: when a
   * command IS supplied, `createDeps` refuses it independently, so reverting the rule changes
   * nothing a caller can see on a host where the bundled binary happens to resolve. The seam
   * makes "resolution did not even run" assertable (code review R4).
   */
  resolve?: () => Resolved;
  /**
   * The passwd entry to use. Injected for tests so `~user` expansion and the no-HOME
   * fallback are assertable without depending on whoever is running the suite.
   */
  passwd?: Passwd;
}

/**
 * @param env  The environment to read. `home` is derived from it (`HOME`, falling back to the
 *   passwd entry) rather than always from `process.env`: splicing the two would give a
 *   caller that passes a custom `env` a hybrid environment, so a `CODEX_HOME=~/...` in that
 *   map would expand against the real user's home instead (code review R4). The fallback is
 *   `os.userInfo()` rather than `os.homedir()` precisely because the latter reads `$HOME`
 *   first and would reintroduce that splice (code review R8).
 */
export function bootstrapDeps(
  env: Record<string, string | undefined> = process.env,
  overrides: DepsOverrides = {},
  opts: BootstrapOptions = {},
): RuntimeDeps {
  // Only resolve when there is no override — an explicit CCUSAGE_CMD must not require the
  // bundled package to be installed at all. Tested with `!== undefined` so that an
  // explicitly empty CCUSAGE_CMD is still "the user supplied a command" (and is then
  // refused by createDeps) rather than silently falling back to the bundled binary.
  const resolve = opts.resolve ?? resolveBundledCcusage;
  const resolved =
    env.CCUSAGE_CMD !== undefined || overrides.ccusageExe !== undefined ? null : resolve();

  // The passwd entry, which is what CPython's expanduser actually consults in two places:
  // the no-HOME fallback (`pwd.getpwuid(os.getuid()).pw_dir`) and the whole `~user` branch
  // (`pwd.getpwnam(name).pw_dir`, which never reads HOME at all). Node exposes it for the
  // current account only, so `~otheruser` stays refused — see expandUser.
  //
  // `os.userInfo()`, NOT `os.homedir()`: the latter consults `$HOME` FIRST and only falls
  // back to the password database (measured: `HOME=/tmp/fake-home` makes `os.homedir()`
  // return `/tmp/fake-home` while `os.userInfo().homedir` returns the real `pw_dir`). The
  // comment here previously claimed the opposite. Using it meant a caller who passed an
  // `env` map with no HOME, while the process itself had one, got `process.env.HOME` spliced
  // into their custom environment — precisely the hybrid this function documents itself as
  // preventing (code review R8).
  const passwd = opts.passwd ?? userInfo();

  // `!== undefined`, NOT `||`. Python's `expanduser` branches on `'HOME' not in os.environ`,
  // so an explicitly EMPTY HOME is a set home there and resolves to `/` (measured:
  // `HOME= python3 -c 'os.path.expanduser("~")'` -> `'/'`, and `~/.codex` -> `'/.codex'`).
  // `||` treated it as unset and substituted the real user's home, which silently redirected
  // a deliberately hermetic caller into the developer's own `~/.claude` and `~/.codex`
  // (code review R7). Only genuine absence falls back, to the passwd home.
  const rawHome = env.HOME !== undefined ? env.HOME : passwd.homedir;

  return createDeps(env, rawHome, overrides.runner ?? defaultRunner, {
    passwd: { username: passwd.username, homedir: passwd.homedir },
    ...(resolved ? { ccusageExe: resolved.exe, ccusagePrefixArgs: resolved.prefixArgs } : {}),
    ...overrides,
  });
}
