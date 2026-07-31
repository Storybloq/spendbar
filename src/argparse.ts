/**
 * The argparse behaviours this CLI's parser definition can actually produce.
 *
 * Not a general argparse port — the plan's section 6 bounds the FORMATTER to constructs this
 * parser can emit, while keeping the PARSER's behaviour complete for this definition. What
 * that rules in is wider than it looks, and was measured rather than guessed (44 rows, all
 * re-checked against live CPython on every `parity.mjs` run):
 *
 *   - option ABBREVIATION, which `--met` and `--m` rely on and which a from-the-goldens
 *     parser would have rejected outright
 *   - ambiguity detection, reachable only as `compare --day`
 *   - `--name value` and `--name=value`
 *   - five error forms, each in the usage prefix it is actually reachable in
 *   - leftmost-failure precedence, measured in both directions
 *   - an EMPTY `--since` behaving as unset, because usage.py tests `if a.since:`
 *
 * The usage-line wrapper is reproduced from CPython's `_format_usage`, including its
 * `get_lines` accumulator, because prog length changes both the wrap points AND the
 * continuation indent — and the shipped binary calls itself `spendbar`, so this code path
 * produces different (correct) bytes there by design. ALLOWLIST 22.
 */
import { pyLen } from "./format.js";
import { pyRepr } from "./pyrepr.js";
import { isDecimalDigit } from "./unicode-tables.js";

/** argparse's default terminal width handling: `shutil.get_terminal_size().columns - 2`. */
export const HELP_WIDTH_MARGIN = 2;

export interface OptionSpec {
  /** Every flag this option answers to, in declaration order. */
  flags: string[];
  /** `dest`, from the first long flag with dashes stripped. */
  dest: string;
  required?: boolean;
  choices?: readonly string[];
  help?: string;
  /** True for `-h`, which takes no value. */
  isFlag?: boolean;
}

export interface CommandSpec {
  name: string;
  options: OptionSpec[];
  help?: string;
}

/** Raised for any argparse failure. The CLI boundary renders it and exits 2. */
export class ArgparseError extends Error {
  readonly code = 2;
  /** The usage block to print above the error line, already newline-terminated. */
  readonly usage: string;
  /** The `prog` the error line is attributed to — top-level or `<prog> <subcommand>`. */
  readonly errorProg: string;

  constructor(message: string, usage: string, errorProg: string) {
    super(message);
    this.usage = usage;
    this.errorProg = errorProg;
  }

  /** `<usage>\n<prog>: error: <message>\n`, exactly as argparse writes it to stderr. */
  render(): string {
    return `${this.usage}${this.errorProg}: error: ${this.message}\n`;
  }
}

/** Signals `-h`/`--help`: not a failure, so it carries the text and exits 0. */
export class HelpRequested extends Error {
  readonly text: string;
  constructor(text: string) {
    super("help");
    this.text = text;
  }
}

const HELP_OPTION: OptionSpec = {
  flags: ["-h", "--help"],
  dest: "help",
  isFlag: true,
  help: "show this help message and exit",
};

/** `--since` -> `SINCE`; with choices, `{a,b,c}`. */
function metavar(o: OptionSpec): string {
  return o.choices ? `{${o.choices.join(",")}}` : o.dest.toUpperCase();
}

/**
 * One option's span in the usage line: `[-h]`, `[--since SINCE]`, `--day1 DAY1`.
 *
 * The FIRST flag, not the last: argparse formats `option_strings[0]`, so `-h, --help` renders
 * as `[-h]`. Using the last put `[--help]` in every usage block and broke all 38 parser cases
 * plus all 11 help goldens at once.
 */
function usagePart(o: OptionSpec): string {
  const flag = o.flags[0] as string;
  const body = o.isFlag ? flag : `${flag} ${metavar(o)}`;
  return o.required ? body : `[${body}]`;
}

/**
 * CPython's `get_lines` from `HelpFormatter._format_usage`, transcribed.
 *
 * The `line_len` seeding differs between the first group (which continues the `usage: `
 * prefix) and later ones (which start at the indent), and the flush test requires a non-empty
 * line — so an over-long part sits alone rather than being dropped. Both details are load
 * bearing: the first is what puts `[-h]` on the prefix line, the second is what lets the
 * 67-character subcommand-choice list exceed the width instead of vanishing.
 */
function getLines(parts: string[], indent: string, textWidth: number, prefix?: string): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let lineLen = (prefix !== undefined ? prefix.length : indent.length) - 1;
  for (const part of parts) {
    if (lineLen + 1 + part.length > textWidth && line.length > 0) {
      lines.push(indent + line.join(" "));
      line = [];
      lineLen = indent.length - 1;
    }
    line.push(part);
    lineLen += 1 + part.length;
  }
  if (line.length > 0) lines.push(indent + line.join(" "));
  if (prefix !== undefined && lines.length > 0) lines[0] = (lines[0] as string).slice(indent.length);
  return lines;
}

/**
 * `formatter.format_usage()` — the `usage: ...` block, newline-terminated.
 *
 * `positionals` carries the subcommand-choice list and its `...` for the top-level parser.
 */
export function formatUsage(
  prog: string,
  options: OptionSpec[],
  positionals: string[],
  width: number,
): string {
  const prefix = "usage: ";
  const optParts = options.map(usagePart);
  const oneLine = [prog, ...optParts, ...positionals].join(" ");
  const textWidth = width - HELP_WIDTH_MARGIN;

  if (prefix.length + oneLine.length <= textWidth) return `${prefix}${oneLine}\n`;

  // "if prog is short, follow it with optionals or positionals"
  let lines: string[];
  if (prefix.length + prog.length <= 0.75 * textWidth) {
    const indent = " ".repeat(prefix.length + prog.length + 1);
    if (optParts.length > 0) {
      lines = getLines([prog, ...optParts], indent, textWidth, prefix);
      lines.push(...getLines(positionals, indent, textWidth));
    } else if (positionals.length > 0) {
      lines = getLines([prog, ...positionals], indent, textWidth, prefix);
    } else {
      lines = [prog];
    }
  } else {
    const indent = " ".repeat(prefix.length);
    const parts = [...optParts, ...positionals];
    lines = getLines(parts, indent, textWidth);
    lines = [prog, ...lines];
  }
  return `${prefix}${lines.join("\n")}\n`;
}

/**
 * argparse's action-help column, which is computed per parser rather than fixed: it tracks
 * the longest invocation, capped at `max_help_position` (24). `alltime` has only `-h, --help`
 * and so indents its help to column 14, where `projects` indents to 24 — reproducing that
 * requires the computation, not a constant.
 */
const MAX_HELP_POSITION = 24;
const INDENT = 2;

function invocation(o: OptionSpec): string {
  return o.isFlag ? o.flags.join(", ") : `${o.flags.join(", ")} ${metavar(o)}`;
}

/**
 * `formatter.format_help()` for a section of options.
 *
 * `helpPosition` is passed in when a parser has OTHER actions that widen the column: the
 * top-level parser's subcommand list is 67 characters, which pins its help column at the
 * cap of 24, while `alltime`'s only action is `-h, --help` and its column lands at 14.
 * Computing it from this section alone would put the top-level `-h` help in the wrong place.
 */
function formatOptionsSection(options: OptionSpec[], width: number, helpPositionOverride?: number): string {
  const invocations = options.map(invocation);
  const actionMaxLength = Math.max(...invocations.map((i) => i.length + INDENT));
  const helpPosition = helpPositionOverride ?? Math.min(actionMaxLength + 2, MAX_HELP_POSITION);
  const actionWidth = Math.max(helpPosition - INDENT - 2, 11);
  const helpWidth = Math.max(width - HELP_WIDTH_MARGIN - helpPosition, 11);

  let out = "options:\n";
  for (const [i, o] of options.entries()) {
    const inv = invocations[i] as string;
    if (o.help === undefined) {
      out += `${" ".repeat(INDENT)}${inv}\n`;
      continue;
    }
    const wrapped = wrapText(o.help, helpWidth);
    if (inv.length <= actionWidth) {
      out += `${" ".repeat(INDENT)}${inv.padEnd(helpPosition - INDENT)}${wrapped[0]}\n`;
    } else {
      out += `${" ".repeat(INDENT)}${inv}\n${" ".repeat(helpPosition)}${wrapped[0]}\n`;
    }
    for (const extra of wrapped.slice(1)) out += `${" ".repeat(helpPosition)}${extra}\n`;
  }
  return out;
}

/** `textwrap.wrap` for the single-paragraph help strings this parser holds. */
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = words[0] as string;
  for (const w of words.slice(1)) {
    if (pyLen(line) + 1 + pyLen(w) <= width) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  lines.push(line);
  return lines;
}

export interface ParseResult {
  cmd: string;
  /** dest -> value. Absent options are absent, matching an argparse namespace default of None. */
  opts: Record<string, string>;
}

export interface ParserDefinition {
  prog: string;
  commands: CommandSpec[];
  width: number;
  /** Rendered top-level help. Supplied by the caller so this module holds no product text. */
  topHelp: (usage: string) => string;
}

/** The subcommand-choice list as argparse renders it in usage and in errors. */
const choiceList = (names: readonly string[]): string => `{${names.join(",")}}`;
/**
 * argparse's `_negative_number_matcher`, `^-\d+$|^-\d*\.\d+$`.
 *
 * Compiled from a Python string, so its `\d` is Unicode Nd — `--since -١` is a VALUE to the
 * oracle, not another option. JavaScript's `\d` is ASCII-only in every mode, so a literal
 * transcription of this regex silently makes the port stricter and turns an exit-0 run into
 * `expected one argument` (code review R1). Same pinned CPython table as `rewriteArgv`.
 */
function isNegativeNumber(s: string): boolean {
  if (!s.startsWith("-")) return false;
  const cps = [...s.slice(1)];
  const nd = (c: string): boolean => isDecimalDigit(c.codePointAt(0) as number);
  const dot = cps.indexOf(".");
  if (dot === -1) return cps.length > 0 && cps.every(nd);          // ^-\d+$
  if (cps.indexOf(".", dot + 1) !== -1) return false;               // at most one point
  const after = cps.slice(dot + 1);                                 // ^-\d*\.\d+$
  return cps.slice(0, dot).every(nd) && after.length > 0 && after.every(nd);
}
const quotedList = (names: readonly string[]): string => names.map((n) => `'${n}'`).join(", ");

export function parseArgs(def: ParserDefinition, argv: string[]): ParseResult {
  const topUsage = formatUsage(
    def.prog,
    [HELP_OPTION],
    [choiceList(def.commands.map((c) => c.name)), "..."],
    def.width,
  );
  const topError = (msg: string): never => {
    throw new ArgparseError(msg, topUsage, def.prog);
  };

  // Tokens BEFORE the subcommand. Measured against the oracle (code review R1), because an
  // earlier version tested only for an exact `-h`/`--help` here and silently DISCARDED
  // everything else — so `--bogus projects` rendered a table where argparse exits 2:
  //
  //   --bogus projects        unrecognized arguments: --bogus          (exit 2)
  //   --h projects            help, exit 0        (--help abbreviates, subcommands do not)
  //   --hel projects          help, exit 0
  //   --help=value projects   argument -h/--help: ignored explicit argument 'value'
  //   --bogus                 the following arguments are required: cmd  (required wins)
  const rewritten = rewriteArgv(argv);
  const headIdx = rewritten.findIndex((t) => !t.startsWith("-") || t === "-" || t === "--");
  const beforeHead = headIdx === -1 ? rewritten : rewritten.slice(0, headIdx);
  const topExtras: string[] = [];
  for (const tok of beforeHead) {
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok : tok.slice(0, eq);
    // `--help` is the only top-level option, so any non-empty `--` prefix of it is
    // unambiguous. `-h` does not abbreviate: short flags are matched exactly.
    const isHelp = name === "-h" || (name.startsWith("--") && name.length > 2 && "--help".startsWith(name));
    if (!isHelp) {
      topExtras.push(tok);
      continue;
    }
    if (eq !== -1) {
      // A zero-argument action rejects an attached value rather than ignoring it.
      topError(`argument -h/--help: ignored explicit argument ${pyRepr(tok.slice(eq + 1))}`);
    }
    throw new HelpRequested(def.topHelp(topUsage));
  }

  if (headIdx === -1 || rewritten.length === 0) {
    // Measured: with no subcommand at all, the required-argument error outranks any
    // unrecognized token, so `--bogus` alone reports the missing `cmd`.
    topError("the following arguments are required: cmd");
  }
  const head = rewritten[headIdx] as string;
  const cmd = def.commands.find((c) => c.name === head);
  if (cmd === undefined) {
    // Subcommands do NOT abbreviate — measured: `proj` is an invalid choice, not a prefix.
    topError(
      `argument cmd: invalid choice: '${head}' (choose from ${quotedList(def.commands.map((c) => c.name))})`,
    );
  }

  const subProg = `${def.prog} ${(cmd as CommandSpec).name}`;
  const options = [HELP_OPTION, ...(cmd as CommandSpec).options];
  const subUsage = formatUsage(subProg, options, [], def.width);
  const subError = (msg: string): never => {
    throw new ArgparseError(msg, subUsage, subProg);
  };

  const opts: Record<string, string> = {};
  const extras: string[] = [];
  const rest = rewritten.slice(headIdx + 1);

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok === "--") {
      // argparse KEEPS the `--` and treats everything after it as positional — measured:
      // `projects -- --since` reports `unrecognized arguments: -- --since`, not a missing
      // value for `--since`. Consuming the separator would lose a token from that message.
      extras.push(...rest.slice(i));
      break;
    }
    if (tok === "-" || !tok.startsWith("-")) {
      // argparse collects leftovers and reports them at the TOP level, even though the token
      // followed a subcommand — measured for `projects extra`, `projects -`, `projects --`.
      extras.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok : tok.slice(0, eq);
    const attached = eq === -1 ? undefined : tok.slice(eq + 1);

    const exact = options.find((o) => o.flags.includes(name));
    let opt = exact;
    if (opt === undefined) {
      const matches = options.filter((o) => o.flags.some((f) => f.startsWith(name)));
      const flat = matches.flatMap((o) => o.flags.filter((f) => f.startsWith(name)));
      if (flat.length > 1) {
        subError(`ambiguous option: ${name} could match ${flat.join(", ")}`);
      }
      if (flat.length === 0) {
        extras.push(tok);
        continue;
      }
      opt = matches[0] as OptionSpec;
    }

    if (opt.isFlag) {
      // Matches the top-level rule, but reports under the SUBCOMMAND prog: measured
      // `usage projects: error: argument -h/--help: ignored explicit argument 'value'`.
      if (attached !== undefined) {
        subError(`argument -h/--help: ignored explicit argument ${pyRepr(attached)}`);
      }
      throw new HelpRequested(formatSubHelp(subUsage, options, def.width));
    }

    let value = attached;
    if (value === undefined) {
      const next = rest[i + 1];
      // An option-looking next token is not a value. argparse's own test is its
      // `_negative_number_matcher`, `^-\d+$|^-\d*\.\d+$` — a WHOLE negative number and
      // nothing else. `-3d` and `-3x` both fail it, which is why `--s -3d` errors while
      // `--since -3d` succeeds: only the exact-name rewrite turns the latter into
      // `--since=-3d` before the parser ever sees a bare `-3d`. A looser `^-\d` test here
      // accepts both and silently makes the port more permissive than the oracle.
      if (next === undefined || (next.startsWith("-") && next !== "-" && !isNegativeNumber(next))) {
        subError(`argument ${opt.flags[0]}: expected one argument`);
      }
      value = next as string;
      i++;
    }
    if (opt.choices && !opt.choices.includes(value)) {
      subError(
        `argument ${opt.flags[0]}: invalid choice: '${value}' ` +
          `(choose from ${quotedList(opt.choices)})`,
      );
    }
    // Last occurrence wins — measured for a repeated `--since`.
    opts[opt.dest] = value;
  }

  if (extras.length > 0) topError(`unrecognized arguments: ${extras.join(" ")}`);

  const missing = (cmd as CommandSpec).options
    .filter((o) => o.required && !(o.dest in opts))
    .map((o) => o.flags[0] as string);
  if (missing.length > 0) {
    subError(`the following arguments are required: ${missing.join(", ")}`);
  }

  // argparse's `parse_args` runs `parse_known_args` FIRST and only then rejects leftovers,
  // so a subcommand-level error (a bad --metric, a missing required option) outranks this.
  // Reporting it earlier would surface the wrong message for `--bogus projects --metric x`.
  if (topExtras.length > 0) {
    topError(`unrecognized arguments: ${topExtras.join(" ")}`);
  }

  return { cmd: (cmd as CommandSpec).name, opts };
}

function formatSubHelp(usage: string, options: OptionSpec[], width: number): string {
  return `${usage}\n${formatOptionsSection(options, width)}`;
}

export { formatOptionsSection, HELP_OPTION, MAX_HELP_POSITION, wrapText };

/** The options that take a date, whose bare relative values need re-attaching. */
export const DATE_OPTS = new Set(["--since", "--until", "--vs", "--date", "--day1", "--day2"]);

/**
 * usage.py's `rewrite_argv`: `--since -3d` becomes `--since=-3d` so argparse does not mistake
 * the leading `-` for a flag.
 *
 * Matched against the RAW token, so an abbreviation is deliberately not rewritten — measured,
 * `--s -3d` fails with `argument --since: expected one argument` while `--since -3d` and
 * `--s 20260101` both succeed. Rewriting after resolving abbreviations would be more correct
 * than the oracle and therefore wrong.
 *
 * The digit test is CPython's `\\d`, which is Unicode Nd, not ASCII (ISS-016): `-١d` really
 * does resolve to yesterday. `isDecimalDigit` is pinned to the reference interpreter's table
 * rather than JS's newer `\\p{Nd}`.
 */
export function rewriteArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    const next = argv[i + 1];
    if (DATE_OPTS.has(tok) && next !== undefined && isRelativeDays(next)) {
      out.push(`${tok}=${next}`);
      i++;
    } else {
      out.push(tok);
    }
  }
  return out;
}

/** `re.fullmatch(r"-\\d+d", s)` with CPython's Unicode-Nd digit set. */
function isRelativeDays(s: string): boolean {
  if (!s.startsWith("-") || !s.endsWith("d") || s.length < 3) return false;
  const digits = [...s.slice(1, -1)];
  return digits.length > 0 && digits.every((c) => isDecimalDigit(c.codePointAt(0) as number));
}

