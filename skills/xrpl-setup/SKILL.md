---
name: xrpl-setup
description: Set up XRPL DevEx Capture in this project. Shows the consent text, asks for consent and a team name, generates a pseudonym, registers the hooks project scoped. Use when a session says identity is not set up, or when the developer asks to enable or disable XRPL feedback capture.
argument-hint: "[register | disable | status]"
allowed-tools: Bash(node *), Bash(bash *), Bash(find *), Bash(cat *), Read
---

You are setting up XRPL DevEx Capture v2 for the developer in this project. Everything here is project scoped, never global.

## 1. Locate the repo

The capture scripts live in a directory containing `hook/setup.mjs`. Find it in this order and call its absolute path `REPO`:

1. `./hook/setup.mjs` exists: `REPO` is the project root.
2. Otherwise run `find . -path '*/hook/setup.mjs' -not -path '*/node_modules/*' | head -1` (vendored copy inside the project).
3. Otherwise tell the developer to clone it first: `git clone https://github.com/RippleDevRel/xrpl-devex-hook.git` and stop.

If `$ARGUMENTS` is `status`, run `node REPO/hook/status.mjs` and relay the output. If it is `disable`, unregister the agent you registered (`claude-code`, `grok` or `codex`) with `node REPO/hook/setup.mjs --unregister <agent>` and say that the hooks are removed and the identity file remains until the developer deletes `.xrpl-devex/identity.json`. Otherwise continue.

## 2. Consent first, then team

Run `node REPO/hook/setup.mjs --show-consent` and show the paragraph to the developer verbatim. Then ask two things in one message:

- Do you consent? (yes or no)
- What is your team name?

Do not continue until they answer. Do not guess a team name from the repo, the folder or a previous conversation. Never ask for a real name or an email; none is collected.

## 3. Record the answer

- Yes: `TEAM_NAME="<their team, as typed>" CONSENT=yes node REPO/hook/setup.mjs --non-interactive`
- No: `CONSENT=no node REPO/hook/setup.mjs --non-interactive`, then tell them nothing will be captured and stop.

The script prints the pseudonym. It also adds `.xrpl-devex/` to the project `.gitignore`.

## 4. Register the hooks, project scoped

- Claude Code: `node REPO/hook/setup.mjs --register claude-code`
- Grok: `node REPO/hook/setup.mjs --register grok`. Tell the developer to run `/hooks-trust` in this project.
- Codex: `node REPO/hook/setup.mjs --register codex`. Tell the developer to trust the project hooks in `/hooks`.
- Cursor, VS Code Copilot or another agent: run `node REPO/hook/setup.mjs --emit-hooks` and paste the block for that agent into its project-scoped hooks file. For agents without a hook that can inject into the model, paste the output of `node REPO/hook/print-instruction.mjs` into their instructions file. Never write into a home directory config.

Then install the skills: `bash REPO/skills/install.sh` (or `--project <project root>` when the repo is vendored).

## 5. Verify and report

Run `node REPO/hook/status.mjs`. Report in two or three lines: pseudonym and team, whether hooks are registered, and that the developer should run `/hooks` (or restart the session) to confirm the hooks loaded, since a running Claude Code session may need a restart to pick up new hook registrations. Mention `/xrpl-status`, `/xrpl-feedback` and `/xrpl-session-analysis` once. Then get out of the way.
