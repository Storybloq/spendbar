/**
 * The differential case registry.
 *
 * The 33 stored goldens are the starting corpus, and they are read from the golden JSON
 * files rather than restated here — capture.py wrote those files, so reading them is the
 * only way the two lists cannot drift. Each golden carries the argv, the fake-ccusage
 * mode, the per-case environment, whether it needs the synthetic CODEX_HOME, and the exit
 * status Python produced, which becomes the case's required termination.
 *
 * What the goldens do NOT carry is a capability tag, so that lives in the table below,
 * and `assertRegistry` demands the two sides cover each other exactly: a new golden with
 * no tag fails, and a tag naming a golden that no longer exists fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_CAPABILITIES } from "./capabilities.mjs";
import { PATHS } from "./env.mjs";

/** golden name -> the capability its case exercises. */
const GOLDEN_CAPABILITY = {
  projects_normal: "render:projects",
  projects_cost: "render:projects",
  projects_both: "render:projects",
  projects_empty: "render:projects",
  projects_mismatch: "render:projects",
  projects_float: "render:projects",
  daily_normal: "render:daily",
  daily_tokens: "render:daily",
  daily_both: "render:daily",
  daily_empty: "render:daily",
  share_normal: "render:share",
  share_vs: "render:share",
  share_empty: "render:share",
  compare_normal: "render:compare",
  compare_empty: "render:compare",
  alltime_normal: "render:alltime",
  alltime_empty: "render:alltime",
  blocks_normal: "render:blocks",
  blocks_empty: "render:blocks",
  hourly_nodata: "hourly",
  hourly_corpus: "hourly",
  codex_since: "render:codex",
  codex_unwindowed: "render:codex",
  codex_empty: "render:codex",
  codex_bad_cost: "render:codex",
  combined_since: "render:combined",
  combined_empty: "render:combined",
  err_bad_metric: "parser",
  err_bad_reldate: "parser",
  err_no_subcommand: "parser",
  err_unknown_subcommand: "parser",
  // Not a parser failure: argv is valid and the CLI reaches the ccusage invocation, which
  // fails because CCUSAGE_CMD points at nothing. That is the runner's error surface.
  err_missing_binary: "errors",
  rel_projects_since_3d: "render:projects",
  rel_daily_since_7d: "render:daily",
  // --help, captured as goldens in Step 6 (plan section 10.1) so the port has a measured
  // target. The top-level pair embeds the module docstring; the per-subcommand ones pin the
  // usage-line wrapping, whose continuation indent tracks the length of `prog`.
  help_top_short: "help",
  help_top_long: "help",
  help_projects: "help",
  help_daily: "help",
  help_share: "help",
  help_compare: "help",
  help_blocks: "help",
  help_hourly: "help",
  help_alltime: "help",
  help_codex: "help",
  help_combined: "help",
};

/**
 * Differential cases with no stored golden — argv surfaces the capture matrix never covered.
 *
 * The `capability` tag is the LAST capability a case needs, not the only one: an argv case
 * like `projects --met cost` needs both the parser and the projects renderer, and tagging it
 * `parser` is right because Step 6 lands after Step 5, so the renderer is already there when
 * the tag is enabled.
 *
 * `expectExit` is the exit status MEASURED from live Python on 2026-07-31 under the pinned
 * environment, transcribed here so the case states its own contract. The differential run
 * re-derives it from Python anyway; a disagreement means the oracle moved.
 *
 * `compareStderr: false` waives the stderr byte comparison. It is used for exactly one class
 * — uncaught Python tracebacks (ALLOWLIST 19), whose bytes name CPython source files and
 * line numbers and which the port cannot emit under any implementation. Waiving is never a
 * free pass: the runner requires both sides to still produce non-empty stderr and empty
 * stdout, so "the port printed nothing at all" fails.
 */
/**
 * Sanctioned text deltas, applied to PYTHON's output before the byte comparison.
 *
 * This is deliberately not a "skip stdout" waiver. ALLOWLIST 22 sanctions exactly one
 * sentence of the help text — the config path, which Python documents as a file this port
 * never reads — so the comparison rewrites that one span and then demands byte equality for
 * everything else. A blanket waiver would let the other 3.2 KB of help text rot unnoticed.
 */
export const SANCTIONED_STDOUT_REWRITE = {
  from: "(from usage-config.json next to this\nscript, or $USAGE_CONFIG)",
  to: "(from ~/.config/spendbar/config.json,\nor $USAGE_CONFIG)",
};

/** Cases whose expected stdout carries the ALLOWLIST 22 rewrite. */
// Cases whose stdout carries the ONE sanctioned config-path span (ALLOWLIST 22). Every
// case that renders the top-level help belongs here — including the abbreviated forms,
// which reach the same text by a different route.
const REWRITE_CASES = new Set([
  "help_top_short", "help_top_long", "argv_help_before_subcommand",
  "argv_abbrev_help_before_subcommand", "argv_abbrev_help_before_subcommand_long",
]);

const argvCase = (name, capability, argv, expectExit, extra = {}) => ({
  name, capability, argv, expectExit, rewrite: REWRITE_CASES.has(name),
  mode: "normal", codexFixture: false, extraEnv: {}, dualRunOnly: false,
  ...extra,
});

export const EXTRA_CASES = [
  // --- abbreviation: argparse accepts unique option prefixes, but never subcommand ones
  argvCase("argv_abbrev_metric_long", "parser", ["projects", "--met", "cost"], 0),
  argvCase("argv_abbrev_metric_one_char", "parser", ["projects", "--m", "cost"], 0),
  argvCase("argv_abbrev_since_one_char", "parser", ["projects", "--s", "20260101"], 0),
  argvCase("argv_abbrev_until_one_char", "parser", ["projects", "--u", "20260101"], 0),
  argvCase("argv_abbrev_subcommand", "parser", ["proj"], 2),
  // argparse's `_negative_number_matcher` is compiled from a PYTHON string, so its `\d` is
  // Unicode Nd and `--since -١` is a value rather than another option. JS `\d` is ASCII in
  // every mode, so a literal transcription silently rejects these (code review R1).
  argvCase("argv_negnum_ascii", "parser", ["projects", "--since", "-1"], 0),
  argvCase("argv_negnum_unicode", "parser", ["projects", "--since", "-١"], 0),
  argvCase("argv_negnum_unicode_float", "parser", ["projects", "--since", "-٣.٥"], 0),
  argvCase("argv_negnum_leading_dot", "parser", ["projects", "--since", "-.5"], 0),
  argvCase("argv_negnum_two_dots", "parser", ["projects", "--since", "-1.2.3"], 2),
  // Tokens BEFORE the subcommand, and an explicit argument attached to a zero-argument help
  // flag. Both were reported as parity gaps in code review R1; these compare full bytes, so
  // they settle it either way rather than resting on an exit code alone.
  argvCase("argv_unknown_opt_before_subcommand", "parser", ["--bogus", "projects"], 2),
  // Measured: `--help` ABBREVIATES (subcommands do not), so this prints help and exits 0.
  argvCase("argv_abbrev_help_before_subcommand", "parser", ["--h", "projects"], 0),
  argvCase("argv_abbrev_help_before_subcommand_long", "parser", ["--hel", "projects"], 0),
  argvCase("argv_help_explicit_arg", "parser", ["projects", "--help=value"], 2),
  argvCase("argv_help_explicit_arg_top", "parser", ["--help=value", "projects"], 2),
  // The only ambiguous prefix this parser can produce; every other option is unique at one
  // character. Error text names both candidates, in declaration order.
  argvCase("argv_abbrev_ambiguous_day", "parser", ["compare", "--day", "20260101", "--day2", "20260102"], 2),

  // --- attached vs separate value
  argvCase("argv_attached_metric", "parser", ["projects", "--metric=cost"], 0),
  argvCase("argv_attached_since", "parser", ["projects", "--since=20260101"], 0),

  // --- the five error forms, each in the prefix it is actually reachable in
  argvCase("argv_missing_value", "parser", ["projects", "--since"], 2),
  argvCase("argv_unknown_option", "parser", ["projects", "--bogus"], 2),
  argvCase("argv_opt_before_subcommand", "parser", ["--since", "20260101", "projects"], 2),
  argvCase("argv_extra_positional", "parser", ["projects", "extra"], 2),
  argvCase("argv_required_both", "parser", ["compare"], 2),
  argvCase("argv_required_one", "parser", ["compare", "--day1", "20260101"], 2),
  // projects' choice list is {tokens,cost,both} and daily's is {cost,tokens,both} — the
  // DIFFERENT declaration orders are reproduced verbatim in the message. The daily form is
  // already a stored golden (err_bad_metric); this is the projects one.
  argvCase("argv_choice_bad_projects", "parser", ["projects", "--metric", "bogus"], 2),
  argvCase("argv_choice_missing_value", "parser", ["daily", "--metric"], 2),

  // --- precedence, measured in BOTH directions: argparse reports the leftmost failure
  argvCase("argv_two_errors_metric_first", "parser", ["daily", "--metric", "bogus", "--since"], 2),
  argvCase("argv_two_errors_since_first", "parser", ["daily", "--since", "--metric", "bogus"], 2),

  // --- degenerate tokens
  argvCase("argv_repeated_since", "parser", ["projects", "--since", "20260101", "--since", "20260102"], 0),
  argvCase("argv_empty_since", "parser", ["projects", "--since", ""], 0),
  argvCase("argv_empty_since_attached", "parser", ["projects", "--since="], 0),
  argvCase("argv_lone_dash", "parser", ["projects", "-"], 2),
  argvCase("argv_bare_ddash", "parser", ["projects", "--"], 2),
  argvCase("argv_ddash_then_option", "parser", ["projects", "--", "--since"], 2),

  // --- rewrite_argv (plan section 6.1)
  argvCase("argv_rel_since_separate", "parser", ["projects", "--since", "-3d"], 0),
  argvCase("argv_rel_since_attached", "parser", ["projects", "--since=-3d"], 0),
  argvCase("argv_rel_until", "parser", ["projects", "--until", "-1d"], 0),
  argvCase("argv_rel_vs", "parser", ["share", "--vs", "-2d"], 0),
  argvCase("argv_rel_day1_day2", "parser", ["compare", "--day1", "-1d", "--day2", "-2d"], 0),
  argvCase("argv_rel_multi_digit", "parser", ["projects", "--since", "-365d"], 0),
  // ISS-016: Python's \d is Unicode Nd. U+0661 ARABIC-INDIC ONE both matches the rewrite
  // pattern AND survives int(), so this resolves to today-1 rather than erroring.
  argvCase("argv_rel_unicode_nd", "parser", ["projects", "--since", "-١d"], 0),
  argvCase("argv_rel_not_matching", "parser", ["projects", "--since", "-3x"], 2),
  // MEASURED, and absent from every earlier reading of rewrite_argv: it gates on exact
  // membership in DATE_OPTS, so an ABBREVIATED date option is not rewritten. `--s -3d`
  // therefore reaches argparse with a bare `-3d`, which looks like an option, and fails —
  // even though `--since -3d` succeeds and `--s 20260101` succeeds.
  argvCase("argv_rel_abbrev_not_rewritten", "parser", ["projects", "--s", "-3d"], 2),

  // --- help positions the goldens do NOT cover. The eleven `help_*` goldens pin the
  // canonical forms; these pin where `-h` may APPEAR, which is a different property.
  argvCase("argv_help_before_subcommand", "help", ["-h", "projects"], 0),
  argvCase("argv_help_after_option", "help", ["projects", "--since", "20260101", "-h"], 0),
  argvCase("argv_help_unknown_subcommand", "parser", ["frobnicate", "-h"], 2),

  // --- hourly's date handling, including the ALLOWLIST 19 crash class (ISS-017)
  argvCase("argv_hourly_date_compact", "hourly", ["hourly", "--date", "20260101"], 0),
  argvCase("argv_hourly_date_reldate_crash", "hourly", ["hourly", "--date", "-1d"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  argvCase("argv_hourly_date_bogus_crash", "hourly", ["hourly", "--date", "bogus"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  // `date.fromisoformat`'s accepted grammar, transcribed from MEASUREMENTS of the reference
  // interpreter rather than from the docs. Only the three cases above exercised it before,
  // which left every near-miss below free to diverge in either direction.
  argvCase("argv_hourly_date_dashed", "hourly", ["hourly", "--date", "2026-01-01"], 0),
  // --- ISS-002: `blocks` has no schema validator and T-004 does not add one. This freezes
  // what malformed producer data does, so a renderer defect cannot quietly turn a loud
  // failure into a plausible wrong number (plan section 8.5). ALLOWLIST 23.
  argvCase("argv_blocks_malformed", "render:blocks", ["blocks"], 1,
    { mode: "blocks_malformed", partialStdout: true }),
  // The rest of the `d.get("blocks", d)` shape space, measured rather than assumed. Python
  // iterates whatever the fallback selects, and usage.py's `isinstance(b, dict)` guard then
  // skips string keys — so a dict or a no-`blocks` payload SUCCEEDS with an empty table,
  // while a present `null` is `TypeError: 'NoneType' object is not iterable`.
  argvCase("argv_blocks_dict", "render:blocks", ["blocks"], 0, { mode: "blocks_dict" }),
  argvCase("argv_blocks_nokey", "render:blocks", ["blocks"], 0, { mode: "blocks_nokey" }),
  argvCase("argv_blocks_null", "render:blocks", ["blocks"], 1,
    { mode: "blocks_null", partialStdout: true }),
  // Python truthiness at three sites in one row: `isGap: {}` is falsy so the row renders,
  // `actualEndTime: ""` falls through to `endTime`, and `isActive: null` prints as `None`.
  argvCase("argv_blocks_truthiness", "render:blocks", ["blocks"], 0, { mode: "blocks_truthiness" }),
  // A top-level LIST: `d.get` does not exist on it, so the oracle dies at usage.py:582 with
  // AttributeError — BEFORE the header, hence zero stdout on both sides rather than the
  // partial-output shape of ALLOWLIST 23.
  argvCase("argv_blocks_array", "render:blocks", ["blocks"], 1,
    { mode: "blocks_array", compareStderr: false, tsStderr: /object has no attribute 'get'/ }),
  // A string `blocks` iterates CHARACTERS, each skipped by usage.py's isinstance guard.
  argvCase("argv_blocks_str", "render:blocks", ["blocks"], 0, { mode: "blocks_str" }),
  // A week date IS accepted (resolving to 2025-12-29), but the raw string is what the
  // records are matched against — so it must succeed AND find nothing.
  argvCase("argv_hourly_date_week", "hourly", ["hourly", "--date", "2026-W01-1"], 0),
  // 8 chars, so the len==8 branch mangles it to "2026-W0-11" BEFORE the parse, and it dies.
  argvCase("argv_hourly_date_week_compact", "hourly", ["hourly", "--date", "2026W011"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  // The weekday is OPTIONAL (code review R1). `2026W01` is SEVEN characters, so it slips past
  // the len==8 rewrite and reaches fromisoformat intact, where it means Monday of week 1.
  argvCase("argv_hourly_date_week_compact_noday", "hourly", ["hourly", "--date", "2026W01"], 0),
  // The dashed no-weekday form is eight characters, so the rewrite mangles it first and the
  // ORACLE rejects it — the reachability, not just the grammar, decides the expected exit.
  argvCase("argv_hourly_date_week_dashed_noday", "hourly", ["hourly", "--date", "2026-W01"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  // Year 1: Date.UTC maps years 0..99 to 1900..1999, so this resolves to 1901 without an
  // explicit setUTCFullYear.
  argvCase("argv_hourly_date_week_year1", "hourly", ["hourly", "--date", "0001-W01-1"], 0),
  // Resolves to 2000-01-03, i.e. OUTSIDE datetime.date's range: `year 10000 is out of range`.
  argvCase("argv_hourly_date_week_overflow", "hourly", ["hourly", "--date", "9999-W52-7"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  // Likewise mangled: an ordinal date is not accepted even before the len==8 rewrite.
  argvCase("argv_hourly_date_ordinal", "hourly", ["hourly", "--date", "2026-001"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  // Calendar validity, which is a DIFFERENT rejection path from a parse failure.
  argvCase("argv_hourly_date_month13", "hourly", ["hourly", "--date", "2026-13-01"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  argvCase("argv_hourly_date_feb30", "hourly", ["hourly", "--date", "2026-02-30"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  argvCase("argv_hourly_date_feb29_leap", "hourly", ["hourly", "--date", "2024-02-29"], 0),
  argvCase("argv_hourly_date_feb29_nonleap", "hourly", ["hourly", "--date", "2026-02-29"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  // Near-misses a hand-written regex tends to wave through.
  argvCase("argv_hourly_date_unpadded", "hourly", ["hourly", "--date", "2026-1-1"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  argvCase("argv_hourly_date_leading_space", "hourly", ["hourly", "--date", " 2026-01-01"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  argvCase("argv_hourly_date_datetime", "hourly", ["hourly", "--date", "2026-01-01T00:00"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  // Non-ASCII digits: `\d` is Unicode Nd, but fromisoformat is strictly ASCII, so these two
  // rules disagree on purpose and the port must not "helpfully" unify them.
  argvCase("argv_hourly_date_nonascii", "hourly", ["hourly", "--date", "\u0662\u0660\u0662\u0666-\u0660\u0661-\u0660\u0661"], 1, { compareStderr: false, tsStderr: /^invalid --date: / }),
  // Empty is FALSY, so it falls back to today rather than failing the parse.
  argvCase("argv_hourly_date_empty", "hourly", ["hourly", "--date", ""], 0),
];

export function loadCases() {
  const cases = [];
  for (const file of readdirSync(PATHS.goldens).sort()) {
    if (!file.endsWith(".json") || file === "manifest.json") continue;
    const g = JSON.parse(readFileSync(resolve(PATHS.goldens, file), "utf8"));
    cases.push({
      name: g.name,
      capability: GOLDEN_CAPABILITY[g.name],
      argv: g.argv,
      mode: g.mode,
      codexFixture: g.codex_fixture,
      extraEnv: g.extra_env ?? {},
      dualRunOnly: g.dual_run_only,
      expectExit: g.exit,
      golden: { stdout: g.stdout, stderr: g.stderr },
      rewrite: REWRITE_CASES.has(g.name),
    });
  }
  return [...cases, ...EXTRA_CASES];
}

export function assertRegistry(cases) {
  const problems = [];
  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.name)) problems.push(`duplicate case name: ${c.name}`);
    seen.add(c.name);
    if (!c.capability) problems.push(`case ${c.name} has no capability tag`);
    else if (!ALL_CAPABILITIES.includes(c.capability)) {
      problems.push(`case ${c.name} has unknown capability ${c.capability}`);
    }
  }
  for (const name of Object.keys(GOLDEN_CAPABILITY)) {
    if (!seen.has(name)) problems.push(`tag table names ${name}, but no such case exists`);
  }
  // Every DECLARED capability must own at least one case. Without this the gate is vacuous
  // in the other direction (code review R1): retag every `hourly` case and both the registry
  // and `--final`'s "every capability is enabled" check still pass, while nothing exercises
  // the capability at all.
  const covered = new Set(cases.map((c) => c.capability));
  for (const cap of ALL_CAPABILITIES) {
    if (!covered.has(cap)) problems.push(`capability ${cap} is declared but no case exercises it`);
  }
  if (problems.length) throw new Error(`case registry is inconsistent:\n  - ${problems.join("\n  - ")}`);
}
