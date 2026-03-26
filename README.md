# Codex File Change Tracker

Prototype VS Code extension that records Codex AI file changes turn by turn and lets you restore any recorded turn later.

Codex's AI model is powerful, but it can be scary to let it edit your files-amazingly, it does not have a reliable official "undo" button, which is quite a simple feature that every user would expect, and every other AI-assisted code editor provides. Simply relying on Git for tracking AI changes is not ideal, because
you may not want to commit every single AI change, let alone there are files that are not tracked by Git.
This extension is a temporary coarse solution to this problem, providing a turn-by-turn snapshot history of AI changes, and allowing users to restore any previous snapshot with a one click.

> **Warning:** Use at your own risk. This extension is still a prototype, has not been fully reviewed, and may contain severe bugs that could lead to file corruption or data loss. Always ensure you have a backup of important files before use. It only tracks successful Codex `apply_patch` edits; it does not track unrelated manual edits, shell-side effects, multi-agent conflicts, or arbitrary deletes outside that flow. Using it alongside these may lead to unexpected results.

## What it does

- Watches local `.codex/sessions/**/*.jsonl`
- Detects completed Codex turns that used `apply_patch`
- Stores per-file `before` and `after` bodies in `.codex/ai-file-history`
- Shows history grouped by Codex session
- Lets you preview diffs, restore an old AI turn, and reapply a restore

The tracker only follows successful `apply_patch` edits. It does not try to recover arbitrary shell-side effects, deletes done outside `apply_patch`, or unrelated manual edits.

## Install

For normal use, install the VSIX that is already in this repository. You do not need `npm install`.

1. In VS Code, open `Extensions`.
2. Open the `...` menu.
3. Choose `Install from VSIX...`.
4. Select the packaged file in this repo, for example `codex-file-change-tracker-0.0.8.vsix`.

Or install from the command line:

```bash
code --install-extension /absolute/path/to/codex-file-change-tracker-0.0.8.vsix --force
```

Then run `Developer: Reload Window`.

## Development

If you want to modify the extension itself:

1. Open `codex-session-snapshots` in VS Code.
2. Run `npm install`.
3. Press `F5` to launch an Extension Development Host.

Useful scripts:

- `npm run check`
- `npm test`
- `npm run package:vsix`

Debug config is in `.vscode/launch.json`, and helper tasks are in `.vscode/tasks.json`.

## How it works

The extension scans Codex session logs for:

- `event_msg.payload.type = "task_started"`
- `event_msg.payload.type = "user_message"`
- `response_item.payload.type = "custom_tool_call"` where `name = "apply_patch"`
- matching `custom_tool_call_output`
- `event_msg.payload.type = "task_complete"`

Only successful `apply_patch` calls are recorded. For each affected file, the tracker stores:

- the user prompt for that turn
- session id and turn id
- the patch text
- the full file body after the AI change
- the reconstructed full file body before the AI change

## Current scope

- Records are created while the extension is active and can also be refreshed from recent session logs.
- History is grouped by Codex session title when available.
- Supported file operations are `Add File` and `Update File` from `apply_patch`.
- Diff preview compares the stored `before` and `after` file bodies.
- Restore can jump to any recorded AI turn, not just the latest one.

## Commands

- `Codex File Change Tracker: Refresh`
- `Codex File Change Tracker: Clear All Records`
- `Codex File Change Tracker: Clear Session Records`
- `Codex File Change Tracker: Restore Turn`
- `Codex File Change Tracker: Reapply Restore`
- `Codex File Change Tracker: Preview Turn Diff`
- `Codex File Change Tracker: Open Turn Record`
- `Codex File Change Tracker: Open Source Session Log`
