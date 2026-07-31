/**
 * The CLI entry point, shared by the shipped binary and the parity harness.
 *
 * Both callers reach the program through this one function and differ only in what they
 * inject: `dist/cli.js` passes `prog: "spendbar"` and the real clock, the harness wrapper
 * passes `prog: "usage"` and a frozen anchor. Neither reads an environment variable to
 * decide, so nothing a user sets can move the program name or the date — a user-settable
 * prog would make the CLI's own output unpredictable, and a settable clock would make every
 * relative window a moving target.
 *
 * `main` returns an exit status and writes through injected sinks. It never touches
 * `process` — that belongs to the entry points, which own the write path (plan section 7.1:
 * `process.stdout.write` rather than `console.log`, and `process.exitCode` rather than
 * `process.exit`, because Node's stdout to a pipe is asynchronous and exiting mid-write
 * truncates output silently, exactly under a test harness's pipes).
 *
 * The parser definition below is transcribed from usage.py:724-763 in DECLARATION ORDER,
 * because that order drives both the usage-line token order and which abbreviations collide.
 * Note the two `--metric` choice lists are in DIFFERENT orders — `{tokens,cost,both}` for
 * `projects`, `{cost,tokens,both}` for `daily` — and argparse reproduces each verbatim in the
 * usage line and the `invalid choice` message. Sorting or sharing them, the natural instinct
 * when building one option table, breaks two goldens.
 */
import { bootstrap } from "./config.js";
import type { Ctx, RuntimeDeps } from "./context.js";
import { UsageError } from "./errors.js";
import { bootstrapDeps } from "./main-deps.js";
import {
  ArgparseError, HelpRequested, parseArgs,
  type CommandSpec, type OptionSpec,
} from "./argparse.js";
import { renderTopHelp } from "./help.js";
import {
  cmdAlltime, cmdBlocks, cmdCodex, cmdCombined, cmdCompare, cmdDaily, cmdHourly, cmdProjects,
  cmdShare,
  type RenderArgs,
} from "./renderers.js";

/** Everything the renderers need that is not data: currently just the product name. */
export interface RenderContext {
  /** The name this build calls itself in usage lines, errors and help. See plan section 9. */
  prog: string;
}

export interface MainOptions {
  /** argv WITHOUT the program name — `process.argv.slice(2)`. */
  argv: string[];
  prog: string;
  /** Today as YYYYMMDD. Injected so relative windows are deterministic under test. */
  today: () => string;
  /**
   * Required, not defaulted to `process.env`: a default would let a caller that means to be
   * hermetic silently inherit the developer's CCUSAGE_CMD, CODEX_HOME and HOME. The entry
   * points pass `process.env` explicitly.
   */
  env: Record<string, string | undefined>;
  /** Fully-built deps, for tests that must not touch the real environment. */
  deps?: RuntimeDeps;
  /** Terminal width for argparse wrapping. Defaults to argparse's 80. */
  width?: number;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export const SUBCOMMANDS = Object.freeze([
  "projects",
  "daily",
  "share",
  "compare",
  "blocks",
  "hourly",
  "alltime",
  "codex",
  "combined",
] as const);

export type Subcommand = (typeof SUBCOMMANDS)[number];

const opt = (flag: string, extra: Partial<OptionSpec> = {}): OptionSpec => ({
  flags: [flag],
  dest: flag.replace(/^--/, ""),
  ...extra,
});

/** usage.py:724-763, in declaration order. */
export const COMMANDS: CommandSpec[] = [
  {
    name: "projects",
    help: "per-project × model table (tokens/cost/both)",
    options: [
      opt("--since"),
      opt("--until"),
      opt("--metric", {
        choices: ["tokens", "cost", "both"],
        help: "per-model columns: tokens (default), cost, or both",
      }),
    ],
  },
  {
    name: "daily",
    help: "per-day by model family, incl. Codex (cost/tokens/both)",
    options: [
      opt("--since"),
      opt("--until"),
      opt("--metric", {
        // NOT the same order as projects. Reproduced verbatim in usage and errors.
        choices: ["cost", "tokens", "both"],
        help: "per-model columns: cost (default), tokens, or both",
      }),
    ],
  },
  {
    name: "share",
    help: "% of spend per project; --vs for a 2nd window",
    options: [opt("--since"), opt("--until"), opt("--vs")],
  },
  {
    name: "compare",
    help: "two calendar days side by side",
    options: [opt("--day1", { required: true }), opt("--day2", { required: true })],
  },
  { name: "blocks", help: "billing blocks + $/hour burn rate", options: [opt("--since")] },
  { name: "hourly", help: "half-hour cost histogram (burst finder)", options: [opt("--date")] },
  { name: "alltime", help: "every project's cost to date", options: [] },
  {
    name: "codex",
    help: "per-project Codex spend (from Codex session logs)",
    options: [opt("--since"), opt("--until")],
  },
  {
    name: "combined",
    help: "unified per-project Claude + Codex spend in one table",
    options: [opt("--since"), opt("--until")],
  },
];

/** Renderer registry. Step 5 replaces each entry as that renderer lands. */
type Renderer = (ctx: Ctx, args: RenderArgs, render: RenderContext) => string;

const RENDERERS: Partial<Record<Subcommand, Renderer>> = {
  alltime: (ctx, _args, render) => cmdAlltime(ctx, render),
  projects: (ctx, args) => cmdProjects(ctx, args),
  daily: (ctx, args) => cmdDaily(ctx, args),
  share: (ctx, args) => cmdShare(ctx, args),
  compare: (ctx, args) => cmdCompare(ctx, args),
  blocks: (ctx, args) => cmdBlocks(ctx, args),
  codex: (ctx, args) => cmdCodex(ctx, args),
  combined: (ctx, args) => cmdCombined(ctx, args),
  hourly: (ctx, args) => cmdHourly(ctx, args),
};

/** argparse's namespace -> the renderers' options. Absent options stay absent (Python None). */
function toRenderArgs(opts: Record<string, string>): RenderArgs {
  const get = (name: string): string | null => (name in opts ? (opts[name] as string) : null);
  const metric = get("metric");
  return {
    since: get("since"),
    until: get("until"),
    vs: get("vs"),
    date: get("date"),
    day1: get("day1"),
    day2: get("day2"),
    ...(metric !== null ? { metric: metric as RenderArgs["metric"] } : {}),
  };
}

export function main(o: MainOptions): number {
  try {
    const parsed = parseArgs(
      {
        prog: o.prog,
        commands: COMMANDS,
        width: o.width ?? 80,
        topHelp: (usage) => renderTopHelp(o.prog, usage, COMMANDS, o.width ?? 80),
      },
      o.argv,
    );
    // `warn` is the config-read warning at usage.py:63, which is `print(..., file=sys.stderr)`
    // — message plus one newline, on stderr, without aborting.
    const deps =
      o.deps ??
      bootstrapDeps(o.env, { today: o.today, warn: (msg) => o.stderr(`${msg}\n`) });
    const ctx = bootstrap(deps);
    const render: RenderContext = { prog: o.prog };

    const renderer = RENDERERS[parsed.cmd as Subcommand];
    if (renderer === undefined) {
      throw new UsageError(`internal: ${parsed.cmd} has no renderer`, 70);
    }
    const out = renderer(ctx, toRenderArgs(parsed.opts), render);
    if (out !== "") o.stdout(out);
    return 0;
  } catch (e) {
    if (e instanceof HelpRequested) {
      o.stdout(e.text);
      return 0;
    }
    if (e instanceof ArgparseError) {
      o.stderr(e.render());
      return e.code;
    }
    if (e instanceof UsageError) {
      o.stderr(`${e.message}\n`);
      return e.code;
    }
    throw e;
  }
}
