---
name: xrpl-status
description: Show whether XRPL DevEx Capture is alive in this project, with buffered, sent and analysis counts. No network call. Use when the developer asks if the feedback hook is working or what has been captured.
allowed-tools: Bash(node *), Bash(find *)
---

Find the capture repo: `./hook/status.mjs` if it exists, otherwise `find . -path '*/hook/status.mjs' -not -path '*/node_modules/*' | head -1`. If neither exists, say the capture system is not installed in this project and point to `/xrpl-setup`.

Run `node <repo>/hook/status.mjs` from the project root and relay its output verbatim in a code block, followed by at most one sentence. The `Capturing:` line is the verdict: when it says `NO`, repeat its reason (agent not registered, hook path missing, agent opened in another directory, no identity) and say that `/xrpl-setup` or the command it names fixes it. Do not add advice, do not run anything else.
