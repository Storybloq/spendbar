/**
 * The `--help` body: the module docstring usage.py renders via `description=__doc__`.
 *
 * Every product-bearing span is an explicit template field (plan section 9), never a textual
 * substitution over rendered output — a blanket `s/usage/spendbar/` would corrupt ordinary
 * English like "Per-project usage" in six goldens.
 *
 * The command table is DATA, not pre-aligned text, because its description column is aligned
 * against the program name: `spendbar` is three characters longer than `usage`, so the whole
 * table shifts. Storing the Python spacing verbatim and swapping the word would leave the
 * shipped help visibly ragged.
 *
 * One sentence is deliberately NOT reproduced: the config path. Python says the config comes
 * from "usage-config.json next to this script", which for an npm install means a file inside
 * global node_modules that this port never reads. Correcting it is sanctioned by ALLOWLIST 22
 * — which exists precisely because ALLOWLIST 5 covers the config PATH and says nothing about
 * rewriting help TEXT.
 */
import {
  formatOptionsSection, formatUsage, HELP_OPTION, MAX_HELP_POSITION, wrapText,
  type CommandSpec,
} from "./argparse.js";

/** `{name, args, description}` for each row of the docstring's command table. */
const COMMAND_TABLE: ReadonlyArray<readonly [string, string, string]> = [
  ["projects", "[--since D] [--until D]", "Per-project × model table (+ Fable cost)"],
  ["daily", "[--since D] [--until D]", "Per-day cost, split by model family"],
  ["share", "[--since D] [--vs D]", "% of spend per project; --vs adds a 2nd window"],
  ["compare", "--day1 D --day2 D", "Two calendar days, per project, side by side"],
  ["blocks", "[--since D]", "Billing blocks + $/hour burn rate"],
  ["hourly", "[--date D]", "Half-hour cost histogram from raw logs (burst finder)"],
  ["alltime", "", "Every project's cost to date + first/last active"],
  ["codex", "[--since D] [--until D]", "Per-project Codex spend (from Codex session logs)"],
  ["combined", "[--since D] [--until D]", "Claude + Codex per project in one table (Total$)"],
];

const INTRO = (prog: string): string[] => [
  `${prog} — a CLI over ccusage for per-project Claude Code / Codex cost tracking.`,
  ``,
  `Wraps \`ccusage\` and applies your project grouping/renames (from ~/.config/spendbar/config.json,`,
  `or $USAGE_CONFIG), then answers the questions we keep asking:`,
  ``,
];

const NOTES = (prog: string): string[] => [
  ``,
  `Dates: YYYYMMDD or YYYY-MM-DD, or relative like -3d / -30d (trailing window from today).`,
  ``,
  `Accuracy notes:`,
  `  * Per-project/per-day numbers use \`ccusage claude daily --instances\`, which buckets by`,
  `    real calendar date. Do NOT use \`ccusage session --since\` for windows — it stamps a whole`,
  `    session on its last-activity date, pulling earlier days' tokens across the boundary.`,
  `  * \`--instances\` is Claude Code ONLY — Codex/GPT sessions are absent entirely (NOT folded into`,
  `    \`misc\`), so projects/share/alltime undercount total spend. \`misc\` is only Claude runs from the`,
  `    home dir / ~/Developer root. Use \`${prog} daily\`/\`blocks\` for Codex-inclusive totals,`,
  `    \`${prog} codex\` for the per-project Codex breakdown, and \`${prog} combined\` for both at once.`,
  `  * \`${prog} codex\` attributes each session to the cwd it STARTED in (from the rollout log's`,
  `    session_meta record) and windows by that session's START date (the rollout filename), which`,
  `    avoids ccusage's last-activity bleed. Because that date basis differs from \`ccusage codex`,
  `    daily\` (calendar day), each windowed run prints a Δ cross-check against the codex-daily total;`,
  `    sessions with an unparseable filename can't be placed in a window and are excluded (noted).`,
  `  * Every command verifies its aggregation against ccusage's own grand totals and prints the check.`,
  ``,
];

/** The docstring, rendered for a given program name. */
export function renderDoc(prog: string): string {
  const rows = COMMAND_TABLE.map(
    ([name, args, desc]) => `  ${prog} ${name.padEnd(8)} ${args.padEnd(26)}${desc}`,
  );
  return [...INTRO(prog), ...rows, ...NOTES(prog)].join("\n");
}

/**
 * The complete top-level `--help`, which argparse assembles as
 * usage block, description, positional-arguments section, options section.
 */
export function renderTopHelp(
  prog: string,
  usage: string,
  commands: CommandSpec[],
  width: number,
): string {
  const choices = `{${commands.map((c) => c.name).join(",")}}`;
  // The subcommand list is 67 characters, so argparse's action_max_length exceeds the
  // max_help_position cap and BOTH sections indent their help to 24. Computing the options
  // section in isolation would give 14 and misplace the `-h` help by ten columns.
  const helpPosition = MAX_HELP_POSITION;
  const helpWidth = Math.max(width - 2 - helpPosition, 11);

  let out = `${usage}\n${renderDoc(prog).replace(/\n+$/, "")}\n\npositional arguments:\n  ${choices}\n`;
  for (const c of commands) {
    const wrapped = wrapText(c.help ?? "", helpWidth);
    out += `    ${c.name.padEnd(helpPosition - 4)}${wrapped[0]}\n`;
    for (const extra of wrapped.slice(1)) out += `${" ".repeat(helpPosition)}${extra}\n`;
  }
  out += `\n${formatOptionsSection([HELP_OPTION], width, helpPosition)}`;
  return out;
}

export { formatUsage };
