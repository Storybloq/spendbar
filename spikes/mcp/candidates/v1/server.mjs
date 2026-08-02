// v1 candidate spike server (plan §4): the probe tool on @modelcontextprotocol/sdk.
//
// This file runs from an ASSEMBLED ISOLATED ROOT, never in place: isolate.mjs copies this
// workspace (and `probe-def.mjs`, which is canonical at spikes/mcp/) to a temporary root
// outside the repository so bare-name imports can only resolve from this candidate's own
// verified node_modules — there is no ancestor tree to walk up into. Run it via the
// conformance runner; in place, the `./probe-def.mjs` import fails fast by design.
//
// Wiring is deliberately identical to the v2 server: same probe definition, same handler,
// same `z.object(shape).strict()` registration, same connect-a-stdio-transport shape. The
// only differences are the import specifiers — which is the thing under test.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { PROBE_NAME, PROBE_DESCRIPTION, buildProbeShapes, buildHandler } from "./probe-def.mjs";

// stderr only — stdout belongs to the protocol, and the purity case asserts exactly that.
const log = (line) => process.stderr.write(`${line}\n`);

const shapes = buildProbeShapes(z);
const server = new McpServer({ name: "spendbar-probe-v1", version: "0.0.0-spike" });

server.registerTool(
  PROBE_NAME,
  {
    description: PROBE_DESCRIPTION,
    inputSchema: z.object(shapes.input).strict(),
    outputSchema: z.object(shapes.output),
  },
  buildHandler(log),
);

await server.connect(new StdioServerTransport());
log("spendbar-probe-server ready v1");
