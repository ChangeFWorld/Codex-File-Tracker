"use strict";

const path = require("path");
const vscode = require("vscode");

const { formatTimestamp, shortText } = require("./utils");

class SnapshotItem extends vscode.TreeItem {
  constructor(snapshot) {
    super(formatTimestamp(snapshot.completedAt), vscode.TreeItemCollapsibleState.None);
    this.snapshot = snapshot;
    this.id = snapshot.id;
    const isRestoreOp = snapshot.type === "restore_op";
    const isInactive = !isRestoreOp && snapshot.active === false;
    this.contextValue = isRestoreOp ? "codexRestoreOp" : isInactive ? "codexSnapshotInactive" : "codexSnapshot";
    this.description = isRestoreOp
      ? snapshot.prompt
      : `${isInactive ? "[inactive] " : ""}${snapshot.prompt}  ${snapshot.fileCount} file(s)`;
    this.tooltip = [
      `Completed: ${snapshot.completedAt}`,
      snapshot.sessionTitle ? `Session: ${snapshot.sessionTitle}` : null,
      snapshot.sessionId ? `Session: ${snapshot.sessionId}` : null,
      isRestoreOp && snapshot.targetSnapshotId ? `Restored To: ${snapshot.targetSnapshotId}` : null,
      snapshot.turnId ? `Turn: ${snapshot.turnId}` : null,
      snapshot.sessionPath ? `Log: ${snapshot.sessionPath}` : null,
      `Prompt: ${shortText(snapshot.prompt, 200)}`
    ]
      .filter(Boolean)
      .join("\n");
    this.iconPath = isRestoreOp
      ? new vscode.ThemeIcon("debug-step-back")
      : isInactive
        ? new vscode.ThemeIcon("circle-slash")
        : new vscode.ThemeIcon("history");
    if (!isRestoreOp) {
      this.command = {
        command: "codexSnapshots.previewRestoreDiff",
        title: "Preview Stored Diff",
        arguments: [snapshot]
      };
    }
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(group) {
    super(group.title, vscode.TreeItemCollapsibleState.Expanded);
    this.group = group;
    this.id = `session:${group.sessionId}`;
    this.contextValue = "codexSnapshotSession";
    this.description = `${group.snapshots.length} turn(s)`;
    this.tooltip = [group.title, group.sessionId].filter(Boolean).join("\n");
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
  }
}

class SnapshotTreeProvider {
  constructor(snapshotStore) {
    this.snapshotStore = snapshotStore;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() {
    this.emitter.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element instanceof SessionItem) {
      return element.group.snapshots.map((snapshot) => new SnapshotItem(snapshot));
    }

    const groups = this.snapshotStore.listSessionGroupsForCurrentWorkspace();
    if (groups.length === 0) {
      return [
        new vscode.TreeItem(
          "No AI file records yet. Wait for a completed Codex turn that uses apply_patch.",
          vscode.TreeItemCollapsibleState.None
        )
      ];
    }
    return groups.map((group) => new SessionItem(group));
  }
}

module.exports = {
  SnapshotTreeProvider
};
