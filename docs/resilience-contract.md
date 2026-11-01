# Resilience contract: placement and limits

The contract text itself is in the [README](../README.md#resilience-contract) and ships as `templates/resilience-contract.md`.

## Where to put it

- Paste it inline in the root `CLAUDE.md`, or in `.claude/CLAUDE.md` when the repository keeps its instructions there.
- Use the root `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists at the root or in any folder you start Claude Code from. Claude Code 2.1.277 and later then reads `AGENTS.md` from the working directory and every folder above it, which the 2.1.299 floor covers. Other agents read it too.
- Never paste it in a subfolder's `CLAUDE.md` or `AGENTS.md`, which loads only on demand, possibly after the design is done; in `CLAUDE.local.md`, which is personal and git-ignored, so teammates and CI never see it; in `.claude/rules/`, because a root rules file may not load in a session started in a subfolder, and other agents never read that folder; in a separate file reached through an `@` import, which a session started in a subfolder treats as an external import and keeps off for good if the approval is declined; or as a symlink, which the docs advise against on Windows.

## Update, decline, edit

To update it, replace everything from the opening marker line to the closing one. To decline it, paste only the line `<!-- resilience-contract declined -->`.

- Keep it whole when `/doctor` or a prompt audit suggests trimming it.
- Edit item 2 for long uploads, exports or LLM calls; rough-ride's `settles` check still flags those flows.
- The opening paragraph describes testing that happens only where rough-ride runs. A team that drops the tool edits or deletes it.
- On Supabase or Firebase backends, "the server validates" means row-level security or security rules.

## Limits

The contract asks for things no check verifies (no fallback shown as real data, untrusted responses, the error state of a page opened directly, loading states, one write after a retry that followed a timeout), so an agent can ignore those with no finding, and the server render of a page's data load is never attacked. Item 2's 10-second timeout doesn't suit streaming or long-polling requests; edit your copy.

## How rough-ride checks for it

`quick`, `standard` and `plan` look for the contract's marker lines in the root `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md` and `.claude/AGENTS.md`, and print one line when it is missing (on runs that show a finding; report.txt always has it), older than this version's edition, in a file Claude Code doesn't load, or removed on your branch. The line never changes what is attacked, the verdicts or the exit code.
