---
name: xrpl-setup
description: Set up XRPL DevEx Capture in this project. Shows the consent text, asks for consent and a team name, generates a pseudonym, registers the hooks project scoped. Use when a session says identity is not set up, or when the developer asks to enable or disable XRPL feedback capture.
argument-hint: "[register | disable | status | invite <code>]"
allowed-tools: Bash(node *), Bash(bash *), Bash(find *), Bash(cat *), Read
---

You are setting up XRPL DevEx Capture v2 for the developer in this project. Everything here is project scoped, never global.

## 1. Locate the repo

The capture scripts live in a directory containing `hook/setup.mjs`. Find it in this order and call its absolute path `REPO`:

1. `./hook/setup.mjs` exists: `REPO` is the current directory. That is the capture repo itself, so every command below needs `--project <the project root>` (or `--project .` when the developer really builds inside the clone).
2. Otherwise run `find . -path '*/hook/setup.mjs' -not -path '*/node_modules/*' | head -1` (vendored copy inside the project).
3. Otherwise tell the developer to clone it first: `git clone https://github.com/RippleDevRel/xrpl-devex-hook.git` (or, without git, `curl -L https://github.com/RippleDevRel/xrpl-devex-hook/archive/refs/heads/main.tar.gz | tar xz && mv xrpl-devex-hook-main xrpl-devex-hook`) and stop.

The current directory matters: run the commands from the project root, the folder that holds the developer's `.claude/`, `.cursor/` or `.codex/` directory. The setup resolves the nearest project root above the current directory and refuses to run when that turns out to be `REPO` itself.

If `$ARGUMENTS` starts with `invite`, run `node REPO/hook/setup.mjs --invite <the code>` (ask for the code first if it is missing), relay the one-line result, and stop. If `$ARGUMENTS` is `status`, run `node REPO/hook/status.mjs` and relay the output. If it is `disable`, run `node REPO/hook/setup.mjs --unregister` and say that the project hooks are removed and the identity file remains until the developer deletes `.xrpl-devex/identity.json`. Otherwise continue.

## 2. Consent first, then team

Run `node REPO/hook/setup.mjs --check-invite` (says whether this event requires an invite code) and `node REPO/hook/setup.mjs --show-consent`, and show the consent paragraph to the developer verbatim. Then ask, in one message:

- Do you consent? (yes or no)
- What is your team name?
- When `invite_only` is true: what is the event invite code the organizer handed out?

Do not continue until they answer. Do not guess a team name or a code from the repo, the folder or a previous conversation. Never ask for a real name or an email; none is collected.

## 3. Record the answer

- Yes: `TEAM_NAME="<their team, as typed>" CONSENT=yes node REPO/hook/setup.mjs --non-interactive --agents <the agent you are running as: claude-code, cursor, codex, grok or vscode-copilot, plus any other the team uses, comma separated>`, with `--invite "<the code>"` appended when the event requires one (a flag, never an environment variable on the command line). A refused code stops the setup with a message: relay it and ask again. Without `--agents`, every agent whose folder exists in the project is registered.
- No: `CONSENT=no node REPO/hook/setup.mjs --non-interactive`, then tell them nothing will be captured and stop.

The script prints the pseudonym, adds `.xrpl-devex/` and the generated hook files to the project `.gitignore`, registers the project-local hooks, installs the skills and ends with a self-test (`Self-test: 1 event written ...`, and `sent 1` when the organizer's endpoint is configured).

## 4. Project hooks

`CONSENT=yes --agents <agents>` already registered those agents' hooks in this project (Claude Code: `.claude/settings.local.json`; Cursor: `.cursor/hooks.json`; Codex: `.codex/hooks.json`; Grok: `.grok/hooks/xrpl-devex.json`; Copilot: `.github/hooks/xrpl-devex.json`) and installed the skills. If they are missing, run `node REPO/hook/setup.mjs --register <agent>`. Never write into a home directory config.

The hooks only load in a new session, so tell the developer to restart the agent (or open a new session) in this project and to accept the trust prompt it shows: Claude Code asks whether to trust the files in the folder when the project opens and reads `.claude/settings.local.json` at session start; Codex and Cursor ask to review and approve the project hooks in `.codex/hooks.json` or `.cursor/hooks.json` the first time they see them; Grok needs `/hooks-trust`. Nothing is captured before that.

## 5. Verify and report

Run `node REPO/hook/status.mjs`. Report in two or three lines: pseudonym and team, which agents are registered, and what the `Capturing:` line says (if it says `NO`, relay the reason verbatim and fix it before moving on). Ask the developer to restart the session and run `/xrpl-status` once more to confirm `Capturing: yes`. Mention `/xrpl-status`, `/xrpl-feedback` and `/xrpl-session-analysis` once. Then get out of the way.
