# XRPL DevEx Capture: participant hook

## Paste this into your coding agent

```
Download the XRPL DevEx Capture install instructions from https://github.com/RippleDevRel/xrpl-devex-hook/blob/main/agent-instruction.md and follow them.
```

Your agent clones this repo, shows you a one-paragraph consent text, asks for your team name, and registers the hooks for this project only. About a minute. Nothing is captured until you say yes, and never your name, never file contents.

If the event uses an invite code, the organizer hands it out on site; your agent asks you for it during the setup.

## Then, during the event

| command | what it does |
|---|---|
| `/xrpl-status` | is the hook alive, what has been buffered and sent. No network. |
| `/xrpl-feedback <what happened>` | log one thing in five seconds, including praise. One-line reply. |
| `/xrpl-session-analysis` | a structured analysis of your session, shown to you, submitted only when you say so. Run it mid-day and end of day. |
| `/xrpl-setup` | consent, team, pseudonym, hook registration. `/xrpl-setup disable` removes the hooks. |

What this is, what is captured and what is not: `docs/PARTICIPANT.md` (one page) and `docs/PRIVACY.md`. Manual install, per agent: `INSTALL.md`.

## Uninstall

From your project root, either tell your agent `/xrpl-setup disable` or run:

```bash
node <path to this clone>/hook/setup.mjs --unregister   # removes the project hooks this setup wrote, for every agent
rm -rf .xrpl-devex                                       # local buffer, identity (pseudonym) and reports; stops all capture
```

Then delete the `xrpl-*` skill folders in `.claude/skills`, `.cursor/skills`, `.codex/skills` or `.grok/skills`, remove the `precommit-secrets` line from `.git/hooks/pre-commit` if you installed the optional guard, and delete the clone. Nothing is written outside your project and the clone, so that is the whole footprint. To have the data already sent deleted, give the organizer your pseudonym (shown by `/xrpl-status` before you delete `.xrpl-devex`); see `docs/PRIVACY.md`.

## What is in here

```
agent-instruction.md    what your agent reads to install this
INSTALL.md              full install guide, per agent, human and agent readable
hook/                   the scripts: setup, capture, submit, status, reflection, allowlist, per-agent stop hooks
skills/                 /xrpl-setup, /xrpl-status, /xrpl-feedback, /xrpl-session-analysis and the installer
scripts/                precommit-secrets.mjs, the optional pre-commit guard (bash skills/install.sh --git-hook)
docs/                   PARTICIPANT.md, PRIVACY.md, TAXONOMY.md
```

Requires Node 18 or newer. No npm install, no API key, no token setup.

## For organizers

This repo is generated from the reference repo https://github.com/RippleDevRel/xrpl-devex-capture.git (Worker, D1 schema, organizer export and report tooling, tests) by `scripts/sync-participant-repo.sh`. Do not edit files here: change the reference repo, run the sync, commit here. Version 2.5.0.
