# XRPL DevEx Capture: participant hook

## Paste this into your coding agent

```
Download the XRPL DevEx Capture install instructions from https://github.com/RippleDevRel/xrpl-devex-hook/blob/main/agent-instruction.md and follow them.
```

Your agent clones this repo, shows you a one-paragraph consent text, asks for your team name, and registers the hooks for this project only. About a minute. Nothing is captured until you say yes, and never your name, never file contents.

## Then, during the event

| command | what it does |
|---|---|
| `/xrpl-status` | is the hook alive, what has been buffered and sent. No network. |
| `/xrpl-feedback <what happened>` | log one thing in five seconds, including praise. One-line reply. |
| `/xrpl-session-analysis` | a structured analysis of your session, shown to you, submitted only when you say so. Run it mid-day and end of day. |
| `/xrpl-setup` | consent, team, pseudonym, hook registration. `/xrpl-setup disable` removes the hooks. |

What this is, what is captured and what is not: `docs/PARTICIPANT.md` (one page) and `docs/PRIVACY.md`. Manual install, per agent: `INSTALL.md`.

## What is in here

```
agent-instruction.md    what your agent reads to install this
INSTALL.md              full install guide, per agent, human and agent readable
hook/                   the scripts: setup, capture, submit, status, reflection, allowlist, per-agent stop hooks
skills/                 /xrpl-setup, /xrpl-status, /xrpl-feedback, /xrpl-session-analysis and the installer
docs/                   PARTICIPANT.md, PRIVACY.md, TAXONOMY.md
```

Requires Node 18 or newer. No npm install, no API key, no token setup.

## For organizers

This repo is generated from the reference repo https://github.com/RippleDevRel/xrpl-devex-capture.git (Worker, D1 schema, organizer export and report tooling, tests) by `scripts/sync-participant-repo.sh`. Do not edit files here: change the reference repo, run the sync, commit here. Version 2.1.0.
