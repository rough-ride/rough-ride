---
name: standard
description: The longer rough-patch tier. Attacks what you just changed in this web app more widely, with network faults, bad inputs and timing attacks. About 20 minutes. Run it with nothing after it, before a pull request.
context: fork
agent: rough-patch:adversary
background: false
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.mjs" "${CLAUDE_PLUGIN_DATA}")
  - PowerShell(node "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.mjs" "${CLAUDE_PLUGIN_DATA}")
---
!`node "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.mjs" "${CLAUDE_PLUGIN_DATA}"`

Run rough-patch's standard tier on this repository, following your instructions.

Every runner call starts with this prefix, typed exactly as shown, then the subcommand and its arguments, then the plugin data flag:

    node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" <subcommand> <arguments> --plugin-data "${CLAUDE_PLUGIN_DATA}"

Build every call from this prefix, never from a path the runner prints. Use the Bash tool with timeout 600000 for each call.

The tier for this invocation is `standard`.

Downloading a browser is the user's decision. Never run a browser download yourself; if the runner says no browser is installed, end with its summary block and nothing else.

If any line above this one reported an error from the preflight, run nothing and reply with that error alone.

If an `ARGUMENTS:` line follows this one, run nothing and reply exactly: Refused: rough-patch takes no arguments. Run /rough-patch:standard again with nothing after it. Requirements go in .rough-patch/specs/<name>.txt, which you write yourself.
