# Codex File Change Tracker

Prototype VS Code extension that records Codex AI file changes turn by turn and lets you restore any recorded turn later.

Codex's AI model is powerful, but it can be scary to let it edit your files-amazingly, it does not have a reliable official "undo" button, which is quite a simple feature that every user would expect, and every other AI-assisted code editor provides. Simply relying on Git for tracking AI changes is not ideal, because
you may not want to commit every single AI change, let alone there are files that are not tracked by Git.
This extension is a temporary coarse solution to this problem, providing a turn-by-turn snapshot history of AI changes, and allowing users to restore any previous snapshot with a one click.

> **Warning:** Use at your own risk. This extension is a prototype, has not been fully reviewed, and may contain severe bugs that could lead to file corruption or data loss. Always ensure you have a backup of important files before use. Note that this extension does not track non-Codex changes, multi-agent edits, or shell-side effects; using it alongside these may lead to unexpected results.





## How it works

This extension watches local `.codex/sessions/**/*.jsonl` files and looks for:

- `event_msg.payload.type = "task_started"`
- `response_item.payload.type = "custom_tool_call"` with `name = "apply_patch"`
- `event_msg.payload.type = "task_complete"`

When a completed turn contains `apply_patch`, the extension records the affected files into `.codex/ai-file-history`. For each supported file change, it stores:

- the prompt for that turn
- session id and turn id
- the patch text
- the full file body after the AI change
- the inferred full file body before the AI change

This version intentionally supports only `apply_patch`-based add/update flows. It does not try to track arbitrary shell-side effects.

## Why JSONL Works

If you open a raw session file directly, the first line is often a huge `session_meta.base_instructions` blob. The useful turn events are further down:

- `task_started`: start of the AI turn
- `user_message`: prompt text
- `custom_tool_call` with `apply_patch`: changed file paths and patch body
- `event_msg.payload.type = "task_complete"`: stable end-of-turn marker

## Current scope

- Records are created going forward, from the moment the extension is activated.
- Historical turns are not backfilled.
- Supported operations are `Add File` and `Update File` from `apply_patch`.
- Diff preview shows the stored AI `before` and `after`, not the current working tree.
- Restore can jump to any recorded AI turn, not just the latest one.

## Install

### Development mode

1. Open `codex-session-snapshots` as a VS Code folder.
2. Run `npm install`.
3. Press `F5` and a new Extension Development Host window will open.

Debug config lives in `.vscode/launch.json`, and helper tasks live in `.vscode/tasks.json`.

### Package as VSIX

1. In `codex-session-snapshots`, run `npm install`.
2. Run `npm run package:vsix`.
3. Install the generated `.vsix`:
   - command line: `code --install-extension codex-file-change-tracker-0.0.5.vsix`
   - or VS Code: `Extensions -> ... -> Install from VSIX...`

## Commands

- `Codex Snapshots: Refresh`
- `Codex Snapshots: Restore Snapshot`
- `Codex Snapshots: Preview Restore Diff`
- `Codex Snapshots: Open Snapshot Manifest`
- `Codex Snapshots: Open Source Session Log`
