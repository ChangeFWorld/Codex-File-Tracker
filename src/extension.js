"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const { CodexWatcher } = require("./codexWatcher");
const { SnapshotStore } = require("./snapshotStore");
const { SnapshotTreeProvider } = require("./treeView");
const { shortText } = require("./utils");

let watcher;

async function activate(context) {
  const snapshotStore = new SnapshotStore(context);
  await snapshotStore.initialize();

  const treeProvider = new SnapshotTreeProvider(snapshotStore);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("codexSnapshotsView", treeProvider));

  watcher = new CodexWatcher(snapshotStore, () => {
    treeProvider.refresh();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("codexSnapshots.refresh", async () => {
      await watcher.scanOnce();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand("codexSnapshots.clearAllSnapshots", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Clear all recorded Codex snapshot history?",
        { modal: true },
        "Clear All"
      );
      if (choice !== "Clear All") {
        return;
      }
      await snapshotStore.clearAll();
      await watcher.scanOnce();
      treeProvider.refresh();
      vscode.window.showInformationMessage("Cleared all Codex snapshot records.");
    }),
    vscode.commands.registerCommand("codexSnapshots.clearSessionSnapshots", async (sessionItem) => {
      const sessionId = extractSessionId(sessionItem);
      if (!sessionId) {
        vscode.window.showWarningMessage("No session selected.");
        return;
      }
      const group = snapshotStore.findSessionGroup(sessionId);
      const label = group ? shortText(group.title, 80) : sessionId;
      const choice = await vscode.window.showWarningMessage(
        `Clear all snapshot records for session "${label}"?`,
        { modal: true },
        "Clear Session"
      );
      if (choice !== "Clear Session") {
        return;
      }
      const removed = await snapshotStore.clearSession(sessionId);
      treeProvider.refresh();
      vscode.window.showInformationMessage(`Cleared ${removed} record(s) from the selected session.`);
    }),
    vscode.commands.registerCommand("codexSnapshots.restoreSnapshot", async (snapshot) => {
      const selected = normalizeSnapshotArg(snapshot) || await promptForSnapshot(snapshotStore);
      if (!selected || selected.type === "restore_op") {
        return;
      }
      if (selected.active === false) {
        vscode.window.showInformationMessage("This AI turn is already inactive. Use the restore entry to reapply it.");
        return;
      }

      const plan = await snapshotStore.planRestore(selected.id);
      const approved = await confirmRestoreWithPreview(snapshotStore, plan);
      if (!approved) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Restoring AI turn ${shortText(selected.prompt, 40)}`,
          cancellable: false
        },
        async () => {
          const result = await snapshotStore.restoreSnapshot(selected.id);
          treeProvider.refresh();
          vscode.window.showInformationMessage(
            `Restored AI turn. Wrote ${result.written} files, deleted ${result.deleted} files.`
          );
        }
      );
    }),
    vscode.commands.registerCommand("codexSnapshots.redoSnapshot", async (snapshot) => {
      const selected = normalizeSnapshotArg(snapshot) || await promptForSnapshot(snapshotStore);
      if (!selected || selected.type === "restore_op") {
        return;
      }

      const plan = await snapshotStore.planRestore(selected.id);
      const approved = await confirmApplyWithPreview(snapshotStore, plan, "redo");
      if (!approved) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Reapplying AI turn ${shortText(selected.prompt, 40)}`,
          cancellable: false
        },
        async () => {
          const result = await snapshotStore.redoSnapshot(selected.id);
          treeProvider.refresh();
          vscode.window.showInformationMessage(
            `Reapplied AI turn. Wrote ${result.written} files, deleted ${result.deleted} files.`
          );
        }
      );
    }),
    vscode.commands.registerCommand("codexSnapshots.reapplyRestoreOperation", async (snapshot) => {
      const selected = normalizeSnapshotArg(snapshot);
      if (!selected || selected.type !== "restore_op") {
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `Reapply the most recent restore for "${shortText(selected.prompt, 60)}"?`,
        { modal: true },
        "Reapply"
      );
      if (choice !== "Reapply") {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Reapplying restore ${shortText(selected.prompt, 40)}`,
          cancellable: false
        },
        async () => {
          const result = await snapshotStore.reapplyRestoreOperation(selected.id);
          treeProvider.refresh();
          vscode.window.showInformationMessage(
            `Reapplied restore. Wrote ${result.written} files, deleted ${result.deleted} files.`
          );
        }
      );
    }),
    vscode.commands.registerCommand("codexSnapshots.previewRestoreDiff", async (snapshot) => {
      const selected = normalizeSnapshotArg(snapshot) || await promptForSnapshot(snapshotStore);
      if (!selected || selected.type === "restore_op") {
        return;
      }
      const plan = await snapshotStore.planRestore(selected.id);
      await openRestorePreview(snapshotStore, plan);
    }),
    vscode.commands.registerCommand("codexSnapshots.openSnapshotManifest", async (snapshot) => {
      const selected = normalizeSnapshotArg(snapshot) || await promptForSnapshot(snapshotStore);
      if (!selected) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(selected.manifestPath);
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand("codexSnapshots.openSessionLog", async (snapshot) => {
      const selected = normalizeSnapshotArg(snapshot) || await promptForSnapshot(snapshotStore);
      if (!selected || !selected.sessionPath) {
        vscode.window.showWarningMessage("This snapshot does not have an associated session log path.");
        return;
      }
      if (!fs.existsSync(selected.sessionPath)) {
        vscode.window.showWarningMessage(`Session log no longer exists: ${selected.sessionPath}`);
        return;
      }
      const document = await vscode.workspace.openTextDocument(selected.sessionPath);
      await vscode.window.showTextDocument(document, { preview: false });
    })
  );

  context.subscriptions.push({
    dispose() {
      if (watcher) {
        watcher.stop();
      }
    }
  });

  await watcher.start();
  treeProvider.refresh();
}

function deactivate() {
  if (watcher) {
    watcher.stop();
  }
}

async function promptForSnapshot(snapshotStore) {
  const snapshots = snapshotStore.listSnapshotsForCurrentWorkspace();
  if (snapshots.length === 0) {
    vscode.window.showInformationMessage("No AI file records are available yet.");
    return null;
  }
  const picked = await vscode.window.showQuickPick(
    snapshots.map((snapshot) => ({
      label: snapshot.prompt,
      description: `${snapshot.completedAt}  ${snapshot.sessionTitle || snapshot.sessionId || ""}`,
      detail: `${snapshot.fileCount} file(s)`,
      snapshot
    })),
    { placeHolder: "Select a Codex AI turn record" }
  );
  return picked ? picked.snapshot : null;
}

async function confirmRestoreWithPreview(snapshotStore, plan) {
  return confirmApplyWithPreview(snapshotStore, plan, "restore");
}

async function confirmApplyWithPreview(snapshotStore, plan, mode) {
  const changeCount = plan.entries.length;
  const conflicts = await snapshotStore.collectConflicts(plan, mode);
  const actionLabel = mode === "redo" ? "Reapply" : "Restore";
  const targetLabel = mode === "redo" ? "after" : "before";
  const conflictMessage =
    conflicts.length > 0
      ? `\n\n${conflicts.length} file(s) currently differ from the recorded ${mode === "redo" ? "pre-restore" : "post-turn"} state and may be overwritten.`
      : "";

  while (true) {
    const choice = await vscode.window.showWarningMessage(
      `${actionLabel} ${changeCount} file(s) to the AI turn ${targetLabel} state for "${shortText(plan.snapshot.prompt, 60)}"?${conflictMessage}`,
      { modal: true },
      "Preview Diffs",
      actionLabel
    );
    if (choice === actionLabel) {
      return true;
    }
    if (choice === "Preview Diffs") {
      await openRestorePreview(snapshotStore, plan);
      continue;
    }
    return false;
  }
}

async function openRestorePreview(snapshotStore, plan) {
  if (plan.entries.length === 0) {
    vscode.window.showInformationMessage("This AI turn did not capture any supported file changes.");
    return;
  }

  let entry = plan.entries[0];
  if (plan.entries.length > 1) {
    const picked = await vscode.window.showQuickPick(
      plan.entries.map((currentEntry) => ({
        label: currentEntry.path,
        description: currentEntry.kind,
        detail: `${plan.snapshot.prompt} -> ${currentEntry.kind}`,
        entry: currentEntry
      })),
      {
        placeHolder: "Select a file to preview the stored AI diff"
      }
    );

    if (!picked) {
      return;
    }
    entry = picked.entry;
  }

  const diff = await snapshotStore.prepareDiffPreview(plan, entry);
  await vscode.commands.executeCommand("vscode.diff", diff.leftUri, diff.rightUri, diff.title, {
    preview: false
  });
}

function normalizeSnapshotArg(snapshot) {
  if (!snapshot) {
    return null;
  }
  if (snapshot.snapshot) {
    return snapshot.snapshot;
  }
  return snapshot.id ? snapshot : null;
}

function extractSessionId(sessionItem) {
  if (!sessionItem) {
    return null;
  }
  if (sessionItem.group && sessionItem.group.sessionId) {
    return sessionItem.group.sessionId;
  }
  if (sessionItem.sessionId) {
    return sessionItem.sessionId;
  }
  return null;
}

module.exports = {
  activate,
  deactivate
};
