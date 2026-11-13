---
name: hunt
description: Experimental. Reads what you just changed in this web app, forms hypotheses, tests them in a browser with faults and bad inputs, and reports only bugs that reproduce twice. About 10 minutes. Run it with nothing after it.
context: fork
agent: rough-ride:hunter
background: false
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" *)
---
Hunt for bugs in this repository's current change, following your instructions.

Your runner prefix `<HUNT>` is, typed exactly:

    node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs"

Start with `<HUNT> start`.
