# Codex cancels MCP tool calls unless the server is approved

**Status:** measured behaviour of the Codex client, not a defect in spendbar.
**Measured on:** `codex-cli 0.144.0` (recorded in `spikes/mcp/evidence/real-clients/codex-v2.manifest.json`).
**Resolves:** ISS-055. **Consumers:** T-013 (MCP server setup instructions) and the v0.3 setup wizard.

## What happens

When `codex exec` runs a tool against an MCP server that has no approval on record, the client
**cancels the call before it is ever sent**. The exchange stops after `tools/list`:

```
client -> server : initialize, notifications/initialized, tools/list     (and nothing more)
server -> client : correct initialize result, correct tools/list result
client stderr    : mcp: spendbar/spendbar_… started
                   mcp: spendbar/spendbar_… (failed)
                   user cancelled MCP tool call
client stdout    : "The MCP tool call was canceled and did not succeed."
```

**The server is blameless.** It answered both requests correctly and never received `tools/call`.
The user-visible text says `(failed)` next to the server's name, so this reads as a spendbar bug
when it is a missing client-side approval.

## The fix

The governing setting is **per-server**:

```toml
[mcp_servers.spendbar]
command = "/absolute/path/to/node"
args    = ["/absolute/path/to/spendbar/dist/cli.js", "mcp"]
default_tools_approval_mode = "approve"
```

Accepted values are `auto | prompt | writes | approve`. The default is `auto`, which cancels in a
non-interactive `codex exec` run with no prior approval on record. `approve` fixes it.

Equivalent as a one-off override, which is what the capture harness uses
(`spikes/mcp/real-client/capture.mjs`):

```
-c 'mcp_servers.spendbar.default_tools_approval_mode="approve"'
```

## What does not fix it — each measured, not assumed

| Attempt | Result |
|---|---|
| `projects."<cwd>".trust_level = "trusted"` for the run's cwd | **No effect** |
| Dropping `--ephemeral` | **No effect** |
| `--dangerously-bypass-approvals-and-sandbox` | Works, and is **rejected** |

The last one is rejected on principle: it disables the sandbox for *everything the model might run*
in order to approve *one server's tools*. `default_tools_approval_mode` is the narrowest grant that
works — it is scoped to a single named server and leaves the sandbox intact.

## Guidance for T-013

1. **Ship `default_tools_approval_mode = "approve"` inside the registration snippet** users are told
   to paste. Documenting it in prose beside the snippet is not enough: the failure is silent,
   non-obvious, and its error text blames spendbar, so a user who skips the prose reaches a wrong
   conclusion about our software. The snippet is the artefact that gets copied.
2. **Any non-interactive real-client test must set it explicitly.** T-013's AC 9 exit test drives
   Codex non-interactively; without this setting the run cancels and `tools/call` is never received.
   A test that scores that as a spendbar failure is measuring the harness. Assert `tools/call` was
   actually received, so a cancelled run fails loudly instead of looking like a slow one.
3. **Prefer absolute paths in `command`.** Shebang bins break under GUI-launched clients that do not
   inherit the package manager's `PATH` — a separate hazard from this one, noted here because both
   surface at the same moment (a user pasting a registration snippet) and both produce errors that
   name spendbar.

## Evidence hygiene — why this was invisible until it wasn't

Earlier Codex captures in this repo **passed**, and they passed only because the operator's own
`~/.codex/config.toml` carried entries that approved the call. Isolating the config with
`--ignore-user-config` is what made the requirement visible at all.

That is exactly the contamination **ISS-047** was filed about, now *demonstrated* rather than
suspected: a green result that depended on the machine it ran on. The general lesson is worth more
than this specific setting — a real-client test that inherits the operator's configuration is
measuring the operator, and the way to find out is to take the configuration away and see what
breaks.
