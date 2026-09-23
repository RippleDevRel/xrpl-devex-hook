# Install XRPL DevEx Capture

This wires your coding agent to record XRPL developer experience friction from this project and send it, pseudonymously, to the event organizer's server. The agent's own model does any judging. Nothing calls an external LLM. The only network calls are small POSTs to the organizer's Cloudflare Worker.

Written so an AI agent can install it, and a human can too.

## How it works

Four channels, one taxonomy (`docs/TAXONOMY.md`):

| channel | mechanism | agents |
|---|---|---|
| passive hooks | `capture.mjs` runs on `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact`, `SessionEnd`. Records only text with an XRPL allowlist hit, buffers locally in `.xrpl-devex/`, flushes in batches on `Stop` and `SessionEnd`. Always exits 0, never prints to you. | Claude Code, Cursor, Codex (verified against their hook docs); GitHub Copilot and Grok Build (best effort, see below) |
| reflection | a `Stop` hook injects an instruction into the agent's own model when the turn had an XRPL error, a result code, or a strong XRPL mention (plus a 10 percent random fallback). The model may submit one structured item via `submit.mjs`. | Claude Code, Codex (exit 2), Cursor (`followup_message`), GitHub Copilot (JSON `decision: block`); Grok does not document a way to continue the turn |
| `/xrpl-feedback` | you type what happened, the model classifies it, one-line ack | Claude Code, Cursor, Codex, Grok |
| `/xrpl-session-analysis` | the model writes a report plus JSON from the transcript and hook evidence, asks before submitting | Claude Code, Cursor, Codex, Grok |

Cursor maps `beforeSubmitPrompt`, `afterShellExecution`, `afterFileEdit` and `afterMCPExecution` onto the same capture script. Codex `PostToolUse` covers `Bash` and `apply_patch`. All stdin shapes (snake_case, camelCase, Cursor top-level `command` and `output`, Copilot CLI `toolArgs`) are normalized in `hook/lib/normalize.mjs`.

## Prerequisites

- Node 18 or newer (`node --version`). Zero dependencies, nothing to `npm install`.
- No token setup. The ingest key ships in `hook/devex.config.json`.
- No LLM API key of any kind.

## Get the repo

```bash
git clone https://github.com/RippleDevRel/xrpl-devex-hook.git
```

Without git, or where github.com does not resolve for `git clone` (exit 128), download the tarball instead:

```bash
curl -L https://github.com/RippleDevRel/xrpl-devex-hook/archive/refs/heads/main.tar.gz | tar xz && mv xrpl-devex-hook-main xrpl-devex-hook
```

## Two layouts

- **Vendored (the normal case).** The repo sits in a subfolder of your project (for example the event starter repo ships it, or you cloned it there). `REPO` is that subfolder; the project root is where your agent's `.claude/`, `.grok/`, `.cursor/` or `.codex/` lives. Run every command from the project root: `setup.mjs`, `status.mjs` and `submit.mjs` resolve the nearest project root above the current directory (the first folder holding `.xrpl-devex/`, else one holding an agent config folder, never your home directory), so a subfolder of the project works too. What does not work is running them with `REPO` itself as the project: the setup refuses (`... is the capture tool's own clone, not your project`) unless you pass `--project <project root>` explicitly.
- **This repo is the project.** You cloned the hook repo and build inside it. Then `REPO` and the project root are the same directory and every command needs `--project .` to say so.

Every command works in both cases because `setup.mjs` emits absolute paths, which is the fix for the classic failure where `$CLAUDE_PROJECT_DIR/hook/...` resolves to the outer project and the hook dies with exit 127.

Data always lives in `<project root>/.xrpl-devex/` (gitignored, `setup.mjs` adds the line).

## Step 1: consent, team, pseudonym

### Human

```bash
node REPO/hook/setup.mjs
```

Shows the consent paragraph, asks yes or no, then the team name, then which of the detected agents to register (Enter keeps them all), then the invite code when the event requires one. Writes `.xrpl-devex/identity.json` with a random pseudonym like `plain-ibex-69`. No real name.

### Agent

Do not launch the interactive prompt in a non-interactive shell. Show the developer the text from `node REPO/hook/setup.mjs --show-consent`, ask for consent and team name in chat, then:

```bash
TEAM_NAME="<their team>" CONSENT=yes node REPO/hook/setup.mjs --non-interactive
```

`CONSENT=no` records the refusal; every hook then exits immediately and nothing is captured. Delete `.xrpl-devex/identity.json` to change your mind either way.

`--project /path/to/project` names the project root explicitly. It is required when the current directory resolves to the capture repo itself (see "Two layouts"), optional otherwise.

Every consent and registration ends with a self-test: one synthetic prompt goes through `capture.mjs` into `.xrpl-devex/buffer.jsonl` (`Self-test: 1 event written ...`) and, when the organizer's endpoint is configured, is flushed (`sent 1 to <endpoint>`). A network failure is reported and the event stays buffered; `Self-test: FAILED` means the hook itself did not write, look at `.xrpl-devex/debug.log`.

### Invite code

Some events are invite only: the Worker then refuses writes without the code the organizer handed out. `node REPO/hook/setup.mjs --check-invite` prints `{ "invite_only": true }` when that is the case. Pass the code at consent time with the `--invite <code>` flag (`--invite-code <code>` and the `INVITE_CODE` environment variable are accepted too, but agents' permission classifiers refuse an env prefix on the command line, so use the flag), or later with `node REPO/hook/setup.mjs --invite <code>` (`/xrpl-setup invite <code>` in your agent). On a terminal, the interactive setup asks for the code when the event requires one and none was given. The setup verifies it against the server and stores it in the local, gitignored `.xrpl-devex/identity.json`; every write then carries it as `X-Invite-Code`. If the organizer rotates the code, `/xrpl-status` says the last flush was refused, events stay buffered, and the new code drains them.

## Step 2: register the hooks (project scoped, never global)

Consent (`--non-interactive` or the interactive prompt) registers every agent it detects, that is the agent running the command (from its environment markers) plus every agent whose config folder exists in the project (`.claude/`, `.cursor/`, `.codex/`, `.grok/`, `.github/hooks/`), and installs the skills. The interactive setup lets you deselect; `--agents` names the list explicitly:

```bash
node REPO/hook/setup.mjs --register                     # every detected agent
node REPO/hook/setup.mjs --register claude-code        # or cursor, codex, grok, vscode-copilot, all
node REPO/hook/setup.mjs --register --agents claude-code,codex
CONSENT=yes TEAM_NAME="..." node REPO/hook/setup.mjs --non-interactive --agents cursor
```

`node REPO/hook/status.mjs` lists the registration per agent (`Agents:` line) and ends with a `Capturing:` verdict.

Every file is written inside the project, never in a home directory, and every hook calls the same `hook/capture.mjs`. The generated files carry absolute local paths, so they must not be committed: Claude Code hooks go to `.claude/settings.local.json` (ignored by convention), the dedicated Grok and Copilot files are added to the project `.gitignore`, and `setup.mjs` warns about the merged `.cursor/hooks.json` and `.codex/hooks.json`. `--unregister` removes everything this setup wrote.

### Trust and restart

New hooks only load in a new session, and each agent asks you to trust them once. Nothing is captured before that.

- **Claude Code** reads `.claude/settings.local.json` at session start. Restart Claude Code (or start a new session) in the project; when it opens a project it asks whether you trust the files in this folder, answer yes. `/hooks` only lists the loaded hooks, it has no trust action.
- **Codex** shows a prompt to review and approve the project hooks defined in `.codex/hooks.json` the first time it sees the file, then loads them in a new session.
- **Cursor** shows a prompt to review and approve the project hooks defined in `.cursor/hooks.json`, then loads them in a new session.
- **Grok** skips project hooks until you run `/hooks-trust` in the project.
- **GitHub Copilot** loads `.github/hooks/*.json` in a new session.

Then run `node REPO/hook/status.mjs` (or `/xrpl-status`) and check the last lines: `Capturing: yes`. `Capturing: NO (not capturing: ...)` names the reason (agent not registered, a registered hook path that no longer exists, the agent opened in another directory than the project, no identity).

### Claude Code

```bash
node REPO/hook/setup.mjs --register claude-code
```

Merges the registrations with absolute paths into `<project>/.claude/settings.local.json` (the project-local file Claude Code keeps out of git), keeps any hooks you already had there, and is idempotent. `--unregister claude-code` removes only ours, from both `settings.local.json` and an older `settings.json`. To see or paste the block yourself: `node REPO/hook/setup.mjs --emit-hooks --agent claude-code`. Reference copy: `hook/agents/claude-code/settings.snippet.json`.

What gets registered: `SessionStart`, `UserPromptSubmit`, `PostToolUse` (matcher `Bash|Write|Edit|Read|WebFetch|WebSearch`, plus one handler per install pattern with `"if": "Bash(npm install *)"` and friends), `PostToolUseFailure` (`Bash|Write|Edit`), two `Stop` handlers (flush plus nudge, and the reflection hook), `PreCompact`, `SessionEnd` with `"timeout": 10` (mandatory: SessionEnd hooks share a 1.5 second budget otherwise and the flush would be killed).

Restart Claude Code in the project to load them (see "Trust and restart"); `/hooks` then lists them.

### Grok

```bash
node REPO/hook/setup.mjs --register grok
```

Writes `<project>/.grok/hooks/xrpl-devex.json` with absolute command strings (Grok does not use Claude's `command` + `args` split) and adds it to the project `.gitignore`. Then `/hooks-trust` in the project; until the folder is trusted, Grok skips project hooks. `/hooks` lists them. Reference: `hook/agents/grok/hooks.snippet.json`. `--unregister grok` deletes that file.

Grok Build's hook docs confirm the events and the camelCase stdin (`hookEventName`, `sessionId`, `cwd`, `workspaceRoot`, `toolName`, `toolInput`) and say Claude tool names such as `Bash`, `Read` and `Edit` are mapped automatically. They do not document tool results on `PostToolUse`, nor `stop_hook_active` or `last_assistant_message` on `Stop`, and they state that stdout is ignored on passive events. Expect prompts, commands and package installs to be captured, tool output and the reflection channel to be best effort until verified in a real session.

### Cursor

```bash
node REPO/hook/setup.mjs --register cursor
```

Merges into `<project>/.cursor/hooks.json` (version 1): `sessionStart`, `beforeSubmitPrompt`, `afterShellExecution` (plus package-install), `afterMCPExecution`, `afterFileEdit`, `postToolUseFailure`, `preCompact`, `sessionEnd`, and `stop` (`loop_limit: 2` on the reflection handler). Cursor stdin uses `conversation_id`, `workspace_roots`, and top-level `command`/`output` on shell events; capture normalizes that, and a `/c:/Users/...` workspace root is turned into `C:\Users\...` on Windows. On Windows the commands point at `hook/agents/cursor/capture.mjs`, a Node wrapper that inherits stdin (Cursor's PowerShell pipeline drops it for `.cmd` wrappers) and hands it to `capture.mjs`. `--unregister cursor` removes only ours. Alternative: `--emit-hooks --agent cursor`.

### Codex

```bash
node REPO/hook/setup.mjs --register codex
```

Merges into `<project>/.codex/hooks.json` (SessionStart, UserPromptSubmit, PostToolUse for Bash and apply_patch, Stop, PreCompact, SessionEnd). Codex asks you to review and approve the project hooks the first time it sees the file, and loads them in a new session. SessionEnd timeout is 3 seconds (Codex's cap). On Windows the Stop hook continues the turn with the JSON decision (`{ "decision": "block", "reason": ... }`, exit 0) instead of exit 2, which PowerShell turns into a hook failure. Alternative: `--emit-hooks --agent codex`, or the TOML form in `hook/agents/codex/config.toml.snippet`. `--unregister codex` removes only ours.

### GitHub Copilot (VS Code and CLI)

```bash
node REPO/hook/setup.mjs --register vscode-copilot
```

Writes `<project>/.github/hooks/xrpl-devex.json` (version 1) and adds it to the project `.gitignore`. VS Code loads the PascalCase events (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `PreCompact`) with a `command` string; Copilot CLI reads the same file's camelCase aliases (`sessionStart`, `userPromptSubmitted`, `postToolUse`, `agentStop`, `sessionEnd`) with `bash`/`powershell` and `timeoutSec`. Tool names such as `runTerminalCommand`, `editFiles`, `createFile` and `replace_string_in_file` are normalized. The Stop hook continues the agent with a JSON `decision: "block"` on stdout, which both VS Code and the CLI document; exit 2 would only show an error. `--unregister vscode-copilot` deletes that file.

Optional extra: paste `node REPO/hook/print-instruction.mjs` into `.github/copilot-instructions.md` if hooks are disabled by org policy.

### Any other agent (fallback, for an AI installer)

1. Find the agent's hook or lifecycle docs (search `"<agent> hooks"`, `"<agent> stop hook"`, `"<agent> after response hook"`). You need an event that fires when a turn finishes and a way to register a shell command for it.
2. If it can surface stderr (exit 2) or a block decision back to its model, register `node REPO/hook/agents/generic/stop-hook.mjs` in the agent's project-scoped config. It honors `stop_hook_active` and adds a per-session cooldown.
3. If it expects a JSON stdout field instead (like Cursor's `followup_message`), copy `hook/agents/cursor/stop-hook.mjs` and rename the field.
4. If it has no injecting hook, paste `node REPO/hook/print-instruction.mjs` into its instructions or rules file.
5. Verify with Step 4.

## Step 3: install the skills

```bash
bash REPO/skills/install.sh                       # this repo is the project
bash REPO/skills/install.sh --project /path/to/project   # vendored
```

Links `xrpl-setup`, `xrpl-status`, `xrpl-feedback`, `xrpl-session-analysis` into `.claude/skills`, `.cursor/skills`, `.codex/skills` and `.grok/skills`. Organizers add `--organizer` to also get `xrpl-team-report`. `setup.mjs` runs this for you (`install.ps1` on Windows, `install.sh` elsewhere).

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File REPO\skills\install.ps1 -Project C:\path\to\project
```

Both installers copy the skill folders instead of symlinking them when symlinks are unavailable: when the checkout has `core.symlinks=false` (the Git for Windows default, where committed symlinks appear as small text stubs), when the link call fails (no Developer Mode, no elevated shell), or under Git Bash. Copies do not follow the repo, so re-run the installer after pulling changes. If a sync of the participant repo brings in skill symlinks that collide with these copies, delete the copied `xrpl-*` folders and re-run the installer.

## Step 4: test

```bash
node REPO/hook/status.mjs
```

(The test suite lives in the reference repo, `xrpl-devex-capture`.)

Shows pseudonym, team, event, the registration per agent, the `Capturing:` verdict, and buffered and sent counts. The setup already ran a self-test through `capture.mjs`; the `Sent:` count is at least 1 when the endpoint is configured. Then test the pieces:

```bash
# the reflection hook injects on an XRPL error: exit 0 and a JSON hookSpecificOutput.additionalContext on stdout, nothing is submitted here
printf '{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"VaultDeposit failed with tecNO_PERMISSION"}' | node REPO/hook/agents/claude-code/stop-hook.mjs; echo "exit $?"

# an invalid item is rejected
node REPO/hook/submit.mjs --local --json '{"surface":"backend","friction_type":"doc_gap","summary":"x","text":"y"}'
```

In your agent, type `/xrpl-status`, then `/xrpl-feedback the devnet faucet is slow today` and check the buffer grew by one.

## Configuration

`REPO/hook/devex.config.json` is edited by the organizer per event: `event`, `focus_features`, `endpoint`, `ingest_key`. Everything else has sane defaults:

| key | default | meaning |
|---|---|---|
| `retention_days` | 90 | stated in the consent text; enforced server side |
| `flush_max_batch` | 10 | flush on `Stop` when the buffer reaches this many events |
| `flush_max_age_seconds` | 60 | or when the oldest buffered event is older than this, so the organizer's feed lags one turn at most |
| `flush_timeout_seconds` | 3 | hard timeout per network call |
| `reflection_sample` | 0.1 | random fallback rate for turns with no XRPL signal (0 to 1) |
| `reflection_cooldown_turns` | 3 | minimum turns between two random-fallback reflection prompts; an XRPL error or a strong XRPL mention fires regardless (at most once per turn) |
| `reflection_max_per_session` | 8 | cap on reflection items per session |
| `nudge_after_turns` | 40 | one-time reminder to run `/xrpl-session-analysis` |
| `nudge_after_minutes` | 180 | or after this long (only used when checkpoints are off) |
| `analysis_checkpoint_hours` | 2 | every N hours of XRPL activity, the Stop hook has the agent run a session analysis of the period and submit it without review (`trigger: checkpoint`); `0` disables and keeps the one-time reminder |
| `analysis_checkpoint_min_events` | 5 | XRPL hook events needed in the period before a checkpoint fires |
| `prompt_max_chars` | 2000 | stored prompt length |
| `prompt_text` | `signal` | which XRPL prompts keep their text: `signal` (names a transaction type or result code, or reads like a question or problem), `always`, `never` (counted, no text) |
| `output_max_chars` | 1500 | stored tool output length |

Environment overrides: `INVITE_CODE` (event invite code at consent time, prefer the `--invite` flag), `XRPL_DEVEX_CONFIG` (path to another config file), `XRPL_DEVEX_ENDPOINT`, `XRPL_DEVEX_INGEST_KEY`, `XRPL_DEVEX_EVENT`, `XRPL_DEVEX_REFLECTION_SAMPLE` (set to `0` to pause the reflection, `1` for every turn), `XRPL_DEVEX_PROJECT_DIR` (where `.xrpl-devex/` lives, used as is without the walk-up), `XRPL_DEVEX_DEBUG=1` (writes verbose diagnostics to `.xrpl-devex/debug.log`). Independently of `XRPL_DEVEX_DEBUG`, every hook run that exits without doing anything for a reason worth knowing (unreadable stdin, identity file not found at the resolved path) appends one line to `.xrpl-devex/debug.log` (or `xrpl-devex-hook.log` in the OS temp directory when that folder cannot be created), capped at 512 KB.

If the organizer has not filled in `endpoint` and `ingest_key` yet, everything still buffers locally and flushes once they do.

## Uninstall

```bash
node REPO/hook/setup.mjs --unregister
```

Then delete `<project>/.xrpl-devex/identity.json` (or the whole `.xrpl-devex/` directory) for local data. Skills: delete the `xrpl-*` entries in `.claude/skills`, `.cursor/skills`, `.codex/skills`, `.grok/skills`.

## Safety notes

- Hooks never break a turn: parse problem, missing config, network down, all exit 0 (with one line in `.xrpl-devex/debug.log` when the exit hides a problem). The reflection stop hook continues the turn on purpose (Claude Code: JSON `additionalContext`, shown as "Stop hook feedback"; Codex and Grok: exit 2; Cursor: `followup_message`; Copilot: JSON `decision: block`) and never fires inside its own continuation (`stop_hook_active`), on a turn that ran one of our skills, during the cooldown or past the per-session cap.
- Nothing is stored without an XRPL allowlist hit. File contents are never stored (only the file name for XRPL-related writes). A redaction pass removes seeds, hex keys, bearer tokens and `KEY=`, `TOKEN=`, `SECRET=` values before anything is written.
- What leaves the machine: pseudonym, team, event id, and the events described in `docs/PRIVACY.md`, sent only to the organizer's Worker.

## Troubleshooting

- `/xrpl-status` says hooks NOT registered, or `Capturing: NO (not capturing: <agent> is running but its hooks are not registered here)`: run `node REPO/hook/setup.mjs --register <agent>`, restart the agent and accept its trust prompt (see "Trust and restart"). Grok also needs `/hooks-trust`.
- `Capturing: NO (not capturing: the agent was opened in X but the hooks are registered in Y)`: the agent only reads the hook files of the folder it was opened in. Open it from the project root (Y), or run the setup from X if that is really the project.
- `Capturing: NO (not capturing: no identity in X/.xrpl-devex/identity.json; found one in X/my-project)`: the agent was opened in the parent folder of the project. Open it from the project.
- `Capturing: NO (not capturing: a registered hook path does not exist)`: the capture repo moved or was deleted since the registration. Restore it or re-run `--register`, which rewrites the absolute paths.
- Setup says `... is the capture tool's own clone, not your project`: you ran it from inside `REPO`. Run it from the project root, or pass `--project <project root>` (`--project .` when the clone really is your project).
- Nothing is captured although status says `Capturing: yes`: the session predates the registration or the trust prompt was dismissed. Restart the agent in the project; then look for `exit 0:` lines in `.xrpl-devex/debug.log`.
- Nothing ever gets sent, buffer keeps growing: `endpoint` or `ingest_key` still say `REPLACE-ME`, the Worker is unreachable, or the event requires an invite code you have not stored (`/xrpl-status` says so). Run `node REPO/hook/submit.mjs --retry-pending` to see the error, `node REPO/hook/setup.mjs --invite <code>` to fix the code.
- Claude continues after a turn with an "XRPL developer experience check": that is the reflection hook doing its job. Set `XRPL_DEVEX_REFLECTION_SAMPLE=0` to reduce it to error-triggered turns only, or `/xrpl-setup disable` to remove all hooks.
- Cursor loops: make sure `loop_limit` is set in `.cursor/hooks.json`.
- Exit 127 in the hook log: a relative path; re-run `--register` or `--emit-hooks` so the paths are absolute.
