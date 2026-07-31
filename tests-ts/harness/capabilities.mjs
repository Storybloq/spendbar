/**
 * Which slices of the CLI are implemented in TypeScript right now.
 *
 * The port lands one renderer at a time, so an unconditional differential suite would be
 * red from Step 4 to Step 7 and its gates would mean nothing. Every case is tagged with
 * the capability it needs, and the runner executes only the tagged cases whose capability
 * is enabled here.
 *
 * That is an escape hatch, so `--final` closes it: it demands that every capability below
 * be enabled, every declared case run exactly once, and the skip count be zero. A case
 * tagged with a capability that is never enabled would otherwise sit skipped forever while
 * the suite reported "complete".
 *
 * ORDER OF ENABLEMENT (each entry is switched on by the step that implements it):
 *   Step 4  render:alltime            (render_table lands with the simplest renderer)
 *   Step 5  the remaining render:*    (one at a time)
 *   Step 6  parser, help, errors
 *   Step 7  hourly
 */
export const ALL_CAPABILITIES = Object.freeze([
  "parser",
  "help",
  "errors",
  "render:projects",
  "render:daily",
  "render:share",
  "render:compare",
  "render:blocks",
  "render:alltime",
  "render:codex",
  "render:combined",
  "hourly",
]);

/**
 * What the TypeScript side can currently be held to. Each step appends to this as its
 * capability lands and its differential cases go green.
 *
 * The harness self-tests, the wrapper self-tests, the Python-oracle replay and the argv
 * matrix all run unconditionally and do not consult this set.
 */
export const ENABLED = Object.freeze([
  "parser",
  "help",
  "errors",
  "render:alltime",
  "render:projects",
  "render:daily",
  "render:share",
  "render:compare",
  "render:blocks",
  "render:codex",
  "render:combined",
  "hourly",
]);

export function parseCapabilities(spec) {
  if (spec === undefined) return new Set(ENABLED);
  if (spec === "all") return new Set(ALL_CAPABILITIES);
  const requested = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((c) => !ALL_CAPABILITIES.includes(c));
  if (unknown.length) {
    throw new Error(`unknown capability: ${unknown.join(", ")}\nknown: ${ALL_CAPABILITIES.join(", ")}`);
  }
  return new Set(requested);
}
