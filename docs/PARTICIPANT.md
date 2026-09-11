# For participants: what this is and what to do

**One line.** Your coding agent records XRPL friction from this project (misleading result codes, docs gaps, retry loops, SDK footguns) and sends it to the organizers under a random pseudonym, so the protocol, its docs and its tooling get fixed. It never records anything without an XRPL keyword, never your name, never file contents.

## Do this once (about a minute)

Paste into your agent:

```
Download the XRPL DevEx Capture install instructions from https://github.com/RippleDevRel/xrpl-devex-hook/blob/main/agent-instruction.md and follow them.
```

The agent shows you a consent paragraph and asks for your team name. Say yes or no. If no, nothing is installed beyond a file recording your choice. You get a pseudonym like `plain-ibex-69`; the organizers see that and your team name, nothing else about you.

## Then, during the event

| when | what | cost |
|---|---|---|
| something annoys you or works well | `/xrpl-feedback the VaultDeposit page does not say who can deposit` | 5 seconds, one-line reply |
| mid-day and end of day | `/xrpl-session-analysis` | 2 minutes; the agent writes a report, shows you the top, asks before submitting. You own the file in `.xrpl-devex/reports/`. |
| every 2 hours of XRPL work (automatic) | checkpoint analysis | at the end of a turn, your agent writes a short analysis of the last period and submits it, then tells you in one line where the report is. You lose two or three minutes of agent time; nothing to do. |
| "is this thing on?" | `/xrpl-status` | instant, no network |
| you change your mind | `/xrpl-setup disable`, or delete `.xrpl-devex/identity.json` | |

You will occasionally see your agent do an "XRPL developer experience check" at the end of a turn where an XRPL error happened. That is the reflection hook asking the model whether the turn revealed friction. It costs one short model turn and writes at most one line to you. Set `XRPL_DEVEX_REFLECTION_SAMPLE=0` in your shell to limit it to error turns only.

## What works where

| channel | Claude Code | Cursor | Codex | GitHub Copilot | Grok Build |
|---|---|---|---|---|---|
| passive hooks (prompts, tool results, retries) | yes | yes | yes | yes, best effort | partial: prompts and commands, tool output not documented |
| reflection (model-judged, end of turn) | yes, on signal | yes, on signal | yes, on signal | yes, on signal | not documented by Grok |
| `/xrpl-feedback` | yes | yes | yes | if skills are enabled | yes |
| `/xrpl-session-analysis` | yes | yes | yes | if skills are enabled | yes |

Claude Code, Cursor and Codex were checked against their hook documentation. Copilot and Grok support was contributed and follows their docs but has not been exercised in a real event yet. Whatever your agent, `/xrpl-feedback` and `/xrpl-session-analysis` always count.

## What is captured, what is not

Captured, only when the text contains an XRPL term (transaction type, result code, xrpl.org URL, XRPL package, XRPL keyword): the XRPL questions and problem reports you type to your agent (a prompt that only hands out a task is counted but its text is not stored), excerpts of tool outputs that carry an XRPL result (1500 characters; a spec or reference page being read is not stored, only its URL), XRPL docs URLs you fetch, XRPL packages you install, retry counts and time to first success per transaction type, the structured notes your agent writes, and what you submit yourself. Everything passes through a redaction step that removes seeds, hex keys, bearer tokens and `KEY=`, `TOKEN=`, `SECRET=` values.

Not captured: anything without an XRPL hit, file contents (only the file name for XRPL-related writes), git history, environment variables, names, emails.

Data is buffered in `.xrpl-devex/` inside your project (gitignored) and sent in batches at the end of turns. Look at `.xrpl-devex/buffer.jsonl` and `.xrpl-devex/sent.jsonl` any time to see exactly what went out. Full details in `docs/PRIVACY.md`.
