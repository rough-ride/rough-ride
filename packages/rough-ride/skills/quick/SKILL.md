---
name: quick
description: Attacks what you just changed in this web app with network faults, bad inputs and timing attacks, and reports what breaks. About 5 minutes. Run it with nothing after it, after a change and before you call the work done.
context: fork
agent: rough-ride:adversary
background: false
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.mjs" "${CLAUDE_PLUGIN_DATA}" quick)
  - PowerShell(node "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.mjs" "${CLAUDE_PLUGIN_DATA}" quick)
---
!`node "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.mjs" "${CLAUDE_PLUGIN_DATA}" quick`

Run rough-ride's quick tier on this repository, following your instructions.

Every runner call starts with this prefix, typed exactly as shown, then the subcommand and its arguments, then the plugin data flag:

    node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" <subcommand> <arguments> --plugin-data "${CLAUDE_PLUGIN_DATA}"

Build every call from this prefix, never from a path the runner prints. Use the Bash tool with timeout 600000 for each call.

The tier for this invocation is `quick`.

Downloading a browser is the user's decision. Never run a browser download yourself; if the runner says no browser is installed, end with its summary block and nothing else.

If any line above this one reported an error from the preflight, run nothing and reply with that error alone.

If an `ARGUMENTS:` line follows this one, run nothing and reply exactly: Refused: rough-ride takes no arguments. Run /rough-ride:quick again with nothing after it. Requirements go in .rough-ride/specs/<name>.txt, which you write yourself.
