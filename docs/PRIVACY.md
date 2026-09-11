# Privacy

## Consent

Consent is explicit, once, at first run, before anything is buffered. The consent text lives in `hook/lib/consent.mjs` and is what `setup.mjs` and `/xrpl-setup` show. Declining writes `{ "declined": true }` to `.xrpl-devex/identity.json`; every hook reads that file first and exits immediately. The decision holds until the participant deletes the file.

## Identity

Participants are identified by a pseudonym generated locally (`adjective-animal-number`, for example `plain-ibex-69`) and by the team name they typed, normalized to a slug (`zetlar-labs`) with the typed form kept as `team_display`. No real name, no email, no machine identifier, no IP stored (the Worker uses the client IP for rate limiting only and does not write it).

Team plus pseudonym can still be re-identifying in a small cohort: an organizer who knows a team has two members can often tell who is who. The data is used for developer experience reporting only, and reports are aggregated by team and across teams.

## What is captured

Only when the text has an XRPL allowlist hit (`hook/xrpl-allowlist.json`: transaction types, result codes, xrpl.org and network domains, XRPL field names, XRPL keywords, XRPL packages):

- prompts to the agent that mention XRPL: counted always, stored verbatim (truncated to `prompt_max_chars`, default 2000) only when they name a transaction type or a result code, or read like a question or a problem report (`prompt_text: "signal"`, the default). A mission statement or a task list that merely mentions xrpl.js is counted, not stored. Organizers can set `prompt_text` to `never` or `always`.
- tool output excerpts for Bash, truncated to `output_max_chars` (default 1500), with the command normalized to basenames. When the output is documentation being read (a spec, a reference page, type definitions, recognizable by the dozens of transaction types or result codes it lists), no excerpt is stored, only the URL fetched if any, and it counts as neither an error nor a retry
- for Write, Edit and Read of XRPL-related files: the file name only, never the content
- XRPL docs URLs fetched, XRPL search queries
- XRPL packages installed (`npm install xrpl` records `["xrpl"]`, nothing else)
- retry metadata: attempts, elapsed seconds, last result code before success, per transaction type
- session markers: start, end, compaction, with turn counts
- reflection items the agent's model writes (structured JSON plus one paragraph, 50 to 2000 characters)
- `/xrpl-feedback` text, verbatim, up to 2000 characters, with its classification
- `/xrpl-session-analysis` report and JSON block, after the participant confirms

## Language

Everything the agent writes (reflections, `/xrpl-feedback` items, session analyses) is stored in English; when the developer wrote in another language the skill translates and keeps the original in the event payload. Prompts recorded by the passive hooks stay in the language they were typed in: no model is involved at capture time.

## Invite code

Some events are invite only. The code the organizer hands out is stored in the same local file as the pseudonym and sent with every write. It identifies the event, not the person: every participant of the event shares it, and it is never written to the repo.

## What is never captured

- anything without an XRPL allowlist hit (a generic `npm run lint` failure is never recorded)
- file contents, git history, environment variables
- names, emails, IP addresses
- the transcript itself

## Redaction

`hook/lib/redact.mjs` runs on every event before it is buffered (`capture.mjs`) and again before anything is sent (`submit.mjs`). It replaces with `[redacted:<type>]`: XRPL family seeds (`s` plus 28 to 30 base58 characters, and `sEd` prefixed), 64 hex character strings (raw private keys; transaction hashes have the same shape and are redacted too in hook captures), `Bearer <token>` values, and the value of anything matching `KEY=`, `TOKEN=`, `SECRET=`, `PASSWORD=`, `SEED=`, `PRIVATE=`. Ledger addresses (`r...`) are kept: they are public and useful. The session analysis skill does a fuller manual redaction pass and lists what it removed in `redacted`.

## Where the data goes

Locally: `.xrpl-devex/` in the participant's project, gitignored (the installer adds the line). `buffer.jsonl` is what has not been sent yet, `sent.jsonl` is a copy of what went out, `reports/` holds the participant's own analyses. Participants can read all of it at any time.

Remotely: the organizer's Cloudflare Worker and D1 database, described in `docs/SETUP.md` in the reference repo (https://github.com/RippleDevRel/xrpl-devex-capture.git). The ingest key that ships with the repo only allows adding events for a pseudonym. Reading requires a separate admin key held by the organizer.

## Retention

`retention_days` in `hook/devex.config.json` (default 90) is stated in the consent text. A Cloudflare Cron Trigger runs nightly and deletes events, analyses and inactive participants older than that. The organizer can also run the purge on demand.

## Opting out

At any time: `/xrpl-setup disable` removes the Claude Code hooks; deleting `.xrpl-devex/identity.json` stops all capture and forgets the pseudonym; deleting `.xrpl-devex/` removes all local data. To have already-sent data removed, give the organizer your pseudonym (shown by `/xrpl-status`); they can delete by `participant_id` in the D1 console.

## Abuse

Because the ingest key is effectively public, a bad actor could send junk under a made-up pseudonym. Rate limits bound the volume, idempotent inserts bound duplicates, and the organizer can ban a pseudonym so its further submissions are rejected while what was already stored stays available for review.
