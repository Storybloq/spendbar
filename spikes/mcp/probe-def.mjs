// The SDK-neutral probe-tool definition (plan §4).
//
// This module owns WHAT the tool is; the per-candidate servers own HOW it is registered. It is
// a factory over the caller's zod instance rather than an object over an imported one, because
// each candidate workspace has its own zod copy and a schema built by one copy is not reliably
// an instance for the other — the exact phantom-dependency trap §2 exists to avoid.
//
// `spendbar_probe` is deliberately NONE of T-013's five production tools: the gate measures the
// SDKs, and reusing a production tool would entangle its future changes with recorded evidence.

export const PROBE_NAME = "spendbar_probe";
export const PROBE_DESCRIPTION =
  "Echo probe for the spendbar MCP conformance gate. Echoes the caller's nonce; " +
  "blockMs > 0 holds the handler open to make cancellation observable.";

/** Maximum test-controlled blocking, kept identical to the spike-wide probe ceiling. */
export const MAX_BLOCK_MS = 60_000;

/**
 * Field shapes, buildable with either candidate's zod. Both installed SDKs accept a full
 * schema in `registerTool` (v1 1.30.0 types it `ZodRawShapeCompat | AnySchema`; v2 2.0.0
 * deprecates the raw-shape form), so each server registers `z.object(shape).strict()` built
 * from its own zod — identical wiring, which keeps the matrix comparing SDKs rather than
 * registration styles.
 */
export function buildProbeShapes(z) {
  return {
    input: {
      nonce: z.string().min(1).describe("Echoed verbatim; binds a transcript to a run."),
      blockMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_BLOCK_MS)
        .optional()
        .describe("Hold the handler open this long (test-controlled blocking mode)."),
    },
    output: {
      nonce: z.string().describe("The caller's nonce, echoed."),
      blocked: z.boolean().describe("Whether the handler entered blocking mode."),
    },
  };
}

/**
 * The handler, shared verbatim by both servers so the matrix compares SDKs rather than two
 * accidentally different tools.
 *
 * Contract with the conformance suite:
 *   * stderr gets `probe-handler-started <nonce>` BEFORE any blocking — the witness that makes
 *     cancellation testable (an immediate echo races the cancel; a started-then-cancelled
 *     handler does not).
 *   * blocking observes `signal`; on abort it releases early and stderr gets
 *     `probe-handler-released <nonce> aborted=true`. The release line is the cancellation
 *     oracle: "the server answered my next request" cannot distinguish an honored cancel from
 *     a concurrent handler still burning its full blockMs.
 *   * the result carries BOTH structuredContent and a non-empty text fallback with the nonce.
 */
export function buildHandler(log) {
  return async ({ nonce, blockMs = 0 }, extra) => {
    log(`probe-handler-started ${nonce}`);
    // A measured API difference, found when v2 failed the cancellation case with the naive
    // `extra.signal` lookup: v1's handler extra carries the abort signal at `extra.signal`,
    // v2's ServerContext carries it at `ctx.mcpReq.signal`. Both are checked; a missing
    // signal is REPORTED, never silently ignored — a handler that cannot observe
    // cancellation must not look like one that was never cancelled.
    const signal = extra?.signal ?? extra?.mcpReq?.signal;
    let blocked = false;
    let aborted = false;
    if (blockMs > 0) {
      blocked = true;
      if (!signal) log(`probe-handler-signal-missing ${nonce}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, blockMs);
        signal?.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(timer);
          resolve();
        });
      });
      log(`probe-handler-released ${nonce} aborted=${aborted}`);
    }
    const structuredContent = { nonce, blocked };
    return {
      content: [{ type: "text", text: `probe nonce=${nonce} blocked=${blocked}` }],
      structuredContent,
    };
  };
}
