# Claude Code probe results

The one-tarball install test's probes (ticket 02; spec part 1 section 4, part 6 section 28.5, part 11 section 46.6). The probe plugin is `scripts/probes/probe-plugin/`; it never ships (it sits outside `packages/rough-patch/`). Raw hook logs: `run1.jsonl`, `run2.jsonl`, `run3.jsonl`.

## How they ran

- 2026-10-27, macOS 26 (Apple M5 Pro), Claude Code 2.1.311, model `haiku` for the session (the forked agents use `model: inherit`).
- `claude -p --plugin-dir scripts/probes/probe-plugin` in a scratch project: the plugin is loaded for one session and never installed. Run 1 and 2 used `--permission-mode bypassPermissions` or explicit `--allowedTools`; run 3 used `--permission-mode default` with only `Skill` allowed, so `allowed-tools` decided Bash.
- Not run: an install from an npm source through a local registry in a scratch home (a scratch home has no Claude Code login on this machine), Linux, Windows, and Claude Code 2.1.299. These stay for the CI `test-tarball` and `install-smoke` jobs.

## Results (macOS)

| Question | Result | Fallback picked |
|---|---|---|
| Hook input inside the forked skill carries `agent_type` for Bash, Read, Grep and Glob | Yes: `agent_type: "rpprobe:prober"` (the scoped agent name) and an `agent_id`, on every call | None: rules 3 and 7 and handler C stay |
| The fork's own spawn passes `PreToolUse:Agent` | No: the only events were `PreToolUse:Skill`, then the fork's own tool calls | None: rule 4 stays |
| `PreToolUse:Skill` fires for plugin skills; input field names | Yes; `tool_input` is `{"skill": "rpprobe:fork"}` (plus `args` when given) | None: rule 6 stays |
| `SubagentStop` fires for a forked skill; matcher takes the agent type; input has the final message | Yes, with matcher `rpprobe:prober`; input has `agent_type`, `agent_id`, `last_assistant_message`, `agent_transcript_path`, `stop_hook_active` | None |
| `SubagentStop` at `maxTurns` | Does not fire: an agent with `maxTurns: 2` stopped after two Bash calls and no `SubagentStop` came | None in 46.6. Consequence: a run cut by `maxTurns` is caught only by the run record's `phase: planned` (resolution 32), not by the stop hook |
| A failed (exit 2) `SubagentStop` hook | Blocks the stop once and hands its stderr to the agent, which acted on it; the next stop passed. No loop | None: the handler stays |
| `CLAUDE_CODE_SESSION_ID` in the fork's Bash equals the hook's `session_id` | Yes (the hooks' environment and every hook input carried the same id) | None |
| `if: "Edit(//**/.rough-patch/**)"` fires for Write and NotebookEdit | No: it fired for `Edit` only. `if: "Write(//**/.rough-patch/**)"` fired for `Write` | Not pre-decided. Picked: handler A becomes three entries, one `if` each for `Edit(...)`, `Write(...)` and `NotebookEdit(...)`, same script, same `onFailure: block` |
| `if` ignores case | Yes on macOS: `Write(//**/.rough-patch/**)` fired for `.Rough-Patch/upper.txt` | None |
| `if` is evaluated before the hook process spawns | Yes: the `if` handlers left no log line for non-matching paths | None |
| `if: "Read(...)"` prefilters apply to Grep and Glob | No: Grep and Glob on `.rough-patch` produced no `if-read` call | 46.6's fallback: one `Grep|Glob` handler with no `if` runs the same script |
| A hook fails open when its command can't start (no `onFailure`) | Yes: a Bash call ran although its hook's command did not exist | None for handler B. (Handler A with `onFailure: block` is meant to block) |
| An explicit `tools` list leaves out MCP tools | Yes: the fork listed exactly Read, Grep, Glob and Bash although the session had MCP servers | None |
| `allowed-tools`: YAML-list rules | Exact rule `Bash(touch allowed-one.txt)` allowed the command | None |
| `allowed-tools`: a quoted rule with a space | `"Bash(touch 'two words.txt')"` allowed it | None |
| `allowed-tools`: a heredoc command against a prefix rule | Refused: `tee heredoc.txt <<'RP_END' ...` did not match `Bash(tee heredoc.txt <<'RP_END' *)` | The pre-decided one: guard rule 7 returns `permissionDecision: "allow"` for the adversary's exact runner calls (ticket 43) |
| A command not in `allowed-tools` | Refused | None |
| `${CLAUDE_PLUGIN_DATA}` substitutes in a skill's `!` line and in hook args | Yes (`.../plugins/data/rpprobe-inline` for a `--plugin-dir` plugin) | None |
| `${CLAUDE_PLUGIN_DATA}` substitutes in MCP args | Not probed (needs an installed plugin's MCP start) | Open |
| Exit codes through `npx --no` | 0, 64 and 78 unchanged on macOS (packed tarball installed in a scratch project) | None so far; `pnpm exec`, `yarn`, `bunx`, npm's Windows `.cmd`/`.ps1` shims and Windows Ctrl-C are open |
| `npx` starts the MCP entry on Windows for a user name with a space | Not probed | Open: the Windows fallback in part 1 section 4 is ready |
| The sandbox lets the runner write `<git dir>/.rough-patch/` | Not probed (needs a sandboxed session) | Open |

## Also found

- The repository's own `.npmrc` (`min-release-age=7`) stops `npx` from fetching `chrome-devtools-mcp@1.12.0` inside this checkout until 2026-10-29 (it was published 2026-10-22). Users are not affected. `scripts/test-tarball.mjs` runs the MCP check from a scratch folder.
- `claude plugin validate --strict` passes for the package and the marketplace entry on Claude Code 2.1.311. It warns that the plugin has no icon (a plugin-directory check, not a failure).
