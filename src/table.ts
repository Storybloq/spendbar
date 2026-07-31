/**
 * The table frame. Ports usage.py's `render_table` (usage.py:141).
 *
 * The oracle owns only the frame — header, rules, an optional TOTAL line — while each caller
 * keeps its own per-cell f-strings. Reproducing that split exactly is what makes the output
 * byte-identical without this function knowing anything about columns.
 *
 * The one difference is that this RETURNS the text where Python prints it. Renderers must be
 * callable without a process attached: the menubar UI and the MCP server need the same
 * strings, and a core that writes to a stream cannot be reused by either.
 */
import { pyLen } from "./format.js";

export interface TableOptions {
  /**
   * The TOTAL line. Python's guard is `if total is not None`, so an EMPTY total still
   * prints its (blank) line — the test is presence, not truthiness. `undefined` is the
   * only value that suppresses it.
   */
  total?: string;
  /** `blocks` is the sole caller that omits the closing rule (usage.py:595). */
  bottomRule?: boolean;
}

export function renderTable(hdr: string, rows: readonly string[], opts: TableOptions = {}): string {
  // `len(hdr)` is CODE POINTS. An astral character in a header would make a UTF-16 rule two
  // dashes too long, and the rule is what any embedded ' | ' separators line up against.
  const rule = "-".repeat(pyLen(hdr));

  const lines = [hdr, rule, ...rows];
  if (opts.bottomRule !== false) lines.push(rule);
  if (opts.total !== undefined) lines.push(opts.total);

  // Each Python `print(x)` is exactly `x` plus one newline — including for an empty string,
  // which is why this appends per line rather than joining. A `join("\n")` would drop the
  // final newline and silently change every table's last byte.
  return lines.map((l) => `${l}\n`).join("");
}
