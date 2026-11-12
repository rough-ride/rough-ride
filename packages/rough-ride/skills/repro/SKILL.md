---
name: repro
description: Re-runs one rough-ride finding by its id, such as 20261025-141207-quick-k3fz/r01 from a quick or standard summary, and says whether it still reproduces.
argument-hint: "<run id>/r<n>"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" repro *)
---
Re-run one rough-ride finding on this repository and say whether it still reproduces.

Finding id given: $ARGUMENTS

A finding id is one word: 8 digits, a dash, 6 digits, a dash, lowercase letters, a dash, 4 lowercase letters or digits, then `/r` and two or more digits, such as `20261025-141207-quick-k3fz/r01`. If the finding id given is not exactly one such word, run nothing and reply exactly: Refused: /rough-ride:repro takes one finding id, such as 20261025-141207-quick-k3fz/r01, from a quick or standard summary.

Otherwise make exactly one runner call: this prefix, typed exactly as shown, with the finding id in place of `<id>`:

    node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" repro <id> --plugin-data "${CLAUDE_PLUGIN_DATA}"

Build the call from this prefix, never from a path the runner prints. Use the Bash tool with timeout 600000, and run no other command.

Downloading a browser is the user's decision. Never run a browser download yourself; if the runner says no browser is installed, end with its summary block and nothing else.

Reply with the call's summary block, every line from `--- rough-ride summary (copy this block unchanged) ---` through `--- end of rough-ride summary ---`, copied unchanged inside one fence that opens with ```text and closes with ```.
