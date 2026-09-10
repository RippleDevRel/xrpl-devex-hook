<!--
Reliable path for VS Code (GitHub Copilot). VS Code exposes a Stop hook, but it
is not confirmed that its Stop hook re-invokes the model to run a command the
way Claude Code, Cursor and Codex do. This standing instruction is read by
Copilot's model every turn, so use it as the primary mechanism for VS Code.
Paste the output of `node hook/print-instruction.mjs` (which fills in the
absolute path to submit.mjs and the taxonomy) under this heading in
.github/copilot-instructions.md at the repo root. Make sure Copilot is allowed
to run terminal commands.
-->

## XRPL developer experience check (run after every response)

Replace this paragraph with the output of `node hook/print-instruction.mjs`.
