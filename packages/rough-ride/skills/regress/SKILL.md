---
name: regress
description: Runs this repository's committed rough-ride regression tests against the running app and reports which pass, fail, flake or went stale. Run it with nothing after it for every test, or with test names to run only those.
argument-hint: "[test names]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" regress *)
---
Run rough-ride's committed regression tests on this repository.

Test names given: $ARGUMENTS

A test name is lowercase letters, digits and dashes, like the file names in the repository's rough-ride tests folder. If any test name given is not, run nothing and reply exactly: Refused: /rough-ride:regress takes test names made of lowercase letters, digits and dashes, or nothing.

Otherwise make exactly one runner call: this prefix, typed exactly as shown, then `--only <name>` for each test name given, in order, then the plugin data flag:

    node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" regress --only <name> --plugin-data "${CLAUDE_PLUGIN_DATA}"

With no test names, the call has no `--only` and runs every test. Build the call from this prefix, never from a path the runner prints. Use the Bash tool with timeout 600000, and run no other command.

Downloading a browser is the user's decision. Never run a browser download yourself; if the runner says no browser is installed, end with its summary block and nothing else.

Reply with the call's summary block, every line from `--- rough-ride summary (copy this block unchanged) ---` through `--- end of rough-ride summary ---`, copied unchanged inside one fence that opens with ```text and closes with ```.
