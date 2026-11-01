# Resilience contract

The resilience contract is optional text you paste into your repository's root `CLAUDE.md`. It tells the coding agent which failures its code will meet, so it builds error, empty and retry states from the start. It is advice whose effect has not been measured, and it changes nothing rough-ride attacks or judges.

## The text

```markdown
<!-- resilience-contract edition=1 -->
## Resilience contract

Code you change here is tested in a real browser with requests that fail, are refused or rate-limited, lose the connection, never answer, answer late or return empty or unreadable data, plus expired sessions, double clicks, reloads, the back button, answers that arrive out of order, odd input and a 375 px wide screen. Design for these from the start:

1. When a request fails and retries do not fix it, say so on the page, not only in the console. Never show a failed or unreadable response as an empty list, a default or a success.
2. Requests your code sends time out after 10 seconds and fail like any other error; longer work, such as an upload, shows progress and can be cancelled. Nothing spins forever or stays disabled.
3. After a failure, trying again on the same page works once the server is back, without a reload. Never cache a failed result.
4. A failed or refused submit keeps everything the user typed.
5. Saving, sending or deleting twice, by a double click or a retry after a timeout, makes one change.
6. Every field accepts a value and shows it correctly, or refuses it with a visible reason, whatever is typed: blank, very long, emoji, other scripts, quotes, markup, extreme numbers or dates. The server validates every input and answers bad input with a 4xx, never a 5xx.
7. Treat responses as untrusted: error bodies may not be JSON, lists may be empty, fields may be null. No error goes uncaught, and the page never shows undefined, NaN, [object Object], Invalid Date or a stack trace.
8. A page that loads data has loading, empty and error states; its error state offers a retry and is the same whether the page was opened directly or through a link in the app.
9. When the session expires, take the user to sign in or say so; never loop or blank the page.
10. Pages fit 375 px wide without sideways scrolling, long user text included.
11. An answer that arrives late never replaces newer results on the page.

This is for real users on bad networks: the app behaves the same for every visitor.
<!-- /resilience-contract -->
```

The same text ships in the package as `templates/resilience-contract.md`, under the MIT-0 licence in `templates/LICENSE`, so you can copy it without attribution.

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
