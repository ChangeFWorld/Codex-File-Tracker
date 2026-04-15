"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const vscode = require("vscode");

const {
  parseApplyPatch,
  reconstructBeforeFromPatch,
  renderAfterForAdd
} = require("./patchUtils");
const { expandHome, extractUserPrompt, formatTimestamp, shortText } = require("./utils");

class SnapshotStore {
  constructor() {
    this.rootDir = null;
    this.recordsDir = null;
    this.blobsDir = null;
    this.previewDir = null;
    this.indexPath = null;
    this.sessionIndexPath = null;
    this.index = null;
  }

  async initialize() {
    const codexRoot = expandHome(
      vscode.workspace.getConfiguration("codexSnapshots").get("codexRoot", "~/.codex")
    );
    this.rootDir = path.join(codexRoot, "ai-file-history");
    this.recordsDir = path.join(this.rootDir, "records");
    this.blobsDir = path.join(this.rootDir, "blobs");
    this.previewDir = path.join(this.rootDir, "previews");
    this.indexPath = path.join(this.rootDir, "index.json");
    this.sessionIndexPath = path.join(codexRoot, "session_index.jsonl");

    await fsp.mkdir(this.recordsDir, { recursive: true });
    await fsp.mkdir(this.blobsDir, { recursive: true });
    await fsp.mkdir(this.previewDir, { recursive: true });
    await this.loadIndex();
  }

  async loadIndex() {
    if (this.index) {
      return this.index;
    }
    try {
      const raw = await fsp.readFile(this.indexPath, "utf8");
      this.index = JSON.parse(raw);
    } catch (error) {
      this.index = { version: 3, turns: [] };
      await this.saveIndex();
    }
    return this.index;
  }

  async saveIndex() {
    await fsp.writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
  }

  listSnapshotsForCurrentWorkspace() {
    if (!this.index) {
      return [];
    }
    return [...this.index.turns]
      .filter((turn) => turn.type !== "restore_op" && turn.fileCount > 0)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  listSessionGroupsForCurrentWorkspace() {
    const snapshots = [...(this.index ? this.index.turns : [])]
      .filter((turn) => turn.type === "restore_op" || turn.fileCount > 0)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    const sessionNames = loadSessionNames(this.sessionIndexPath);
    const groups = new Map();

    for (const snapshot of snapshots) {
      const sessionId = snapshot.sessionId || "(unknown-session)";
      if (!groups.has(sessionId)) {
        groups.set(sessionId, {
          id: sessionId,
          sessionId,
          title: sessionNames.get(sessionId) || sessionId,
          completedAt: snapshot.completedAt,
          snapshots: []
        });
      }
      const group = groups.get(sessionId);
      group.snapshots.push(snapshot);
      if (snapshot.completedAt > group.completedAt) {
        group.completedAt = snapshot.completedAt;
      }
    }

    return [...groups.values()]
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .map((group) => ({
        ...group,
        snapshots: group.snapshots.sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      }));
  }

  findSnapshot(id) {
    if (!this.index) {
      return undefined;
    }
    return this.index.turns.find((turn) => turn.id === id);
  }

  findSessionGroup(sessionId) {
    return this.listSessionGroupsForCurrentWorkspace().find((group) => group.sessionId === sessionId);
  }

  async readManifest(turnId) {
    await this.loadIndex();
    const entry = this.findSnapshot(turnId);
    if (!entry) {
      throw new Error(`Turn record not found: ${turnId}`);
    }
    const raw = await fsp.readFile(entry.manifestPath, "utf8");
    return JSON.parse(raw);
  }

  async createSnapshot(options) {
    await this.loadIndex();

    if (!options.patches || options.patches.length === 0) {
      return { created: false, snapshot: null };
    }

    const existing = this.index.turns.find(
      (turn) => turn.sessionId === options.sessionId && turn.turnId === options.turnId
    );
    if (existing) {
      return { created: false, snapshot: existing };
    }

    const files = await this.captureFilesForTurn(options.patches || [], options.prePatchFiles || {});
    if (files.length === 0) {
      return { created: false, snapshot: null };
    }
    const createdAt = options.completedAt || new Date().toISOString();
    const recordId = buildRecordId(options.sessionId, options.turnId, createdAt);
    const sessionTitle = loadSessionNames(this.sessionIndexPath).get(options.sessionId) || options.sessionId;

    const manifest = {
      id: recordId,
      sessionId: options.sessionId,
      sessionTitle,
      turnId: options.turnId,
      prompt: extractUserPrompt(options.prompt || "(no prompt)", 140),
      promptFull: options.prompt || "",
      completedAt: createdAt,
      startedAt: options.startedAt || null,
      sessionPath: options.sessionPath || null,
      lastAgentMessage: options.lastAgentMessage || "",
      files,
      patchCount: options.patches.length
    };

    const manifestPath = path.join(this.recordsDir, `${recordId}.json`);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const indexEntry = {
      id: recordId,
      type: "ai_turn",
      active: true,
      sessionId: manifest.sessionId,
      sessionTitle: manifest.sessionTitle,
      turnId: manifest.turnId,
      prompt: manifest.prompt,
      promptFull: manifest.promptFull,
      completedAt: manifest.completedAt,
      fileCount: manifest.files.length,
      manifestPath,
      sessionPath: manifest.sessionPath
    };

    this.index.turns.push(indexEntry);
    await this.saveIndex();
    return { created: true, snapshot: indexEntry };
  }

  async captureFilesForTurn(patches, prePatchFiles = {}) {
    const orderedOperations = [];

    for (const patchText of patches) {
      const operations = parseApplyPatch(patchText);
      for (const operation of operations) {
        orderedOperations.push(operation);
      }
    }

    const byKey = new Map();
    for (const operation of orderedOperations) {
      const key = operation.originalPath || operation.path;
      if (!byKey.has(key)) {
        byKey.set(key, []);
      }
      byKey.get(key).push(operation);
    }

    const files = [];
    for (const [key, operations] of byKey.entries()) {
      try {
        const record = await this.captureSingleFileHistory(
          key,
          collapseRepeatedOperations(operations),
          prePatchFiles[key] || null
        );
        if (record) {
          files.push(record);
        }
      } catch (_error) {
        continue;
      }
    }

    return files;
  }

  async captureSingleFileHistory(key, operations, prePatchState = null) {
    const firstOperation = operations[0];
    const lastOperation = operations[operations.length - 1];
    const finalPath = lastOperation.path;

    let finalText = null;
    if (fs.existsSync(finalPath)) {
      finalText = await fsp.readFile(finalPath, "utf8");
    } else if (lastOperation.kind === "add") {
      finalText = renderAfterForAdd(lastOperation);
    }

    const hadPrePatchState = prePatchState && typeof prePatchState.existed === "boolean";
    const existedBeforeTurn = hadPrePatchState ? prePatchState.existed : firstOperation.kind !== "add";

    if (!existedBeforeTurn && finalText === null) {
      return null;
    }

    let currentText = finalText;
    let successfulReverseUpdates = 0;

    if (!hadPrePatchState) {
      for (let index = operations.length - 1; index >= 0; index -= 1) {
        const operation = operations[index];
        if (operation.kind === "update") {
          try {
            currentText = reconstructBeforeFromPatch(currentText, operation);
            successfulReverseUpdates += 1;
          } catch (_error) {
            continue;
          }
          continue;
        }
        if (operation.kind === "add") {
          currentText = null;
        }
      }
    }

    if (firstOperation.kind === "update" && successfulReverseUpdates === 0) {
      return null;
    }

    const beforeText = hadPrePatchState ? prePatchState.text : currentText;
    const recordKind = determineNetKind(existedBeforeTurn, finalText);
    if (!recordKind) {
      return null;
    }

    const beforeBlobId = beforeText === null ? null : await this.writeBlob(beforeText);
    const afterBlobId = finalText === null ? null : await this.writeBlob(finalText);

    return {
      id: buildFileRecordId(finalPath, operations.map((op) => op.patchText).join("\n\n")),
      path: finalPath,
      originalPath: firstOperation.originalPath || firstOperation.path,
      kind: recordKind,
      restoreMode: existedBeforeTurn ? "write" : "delete",
      restorePath: firstOperation.originalPath || firstOperation.path,
      deleteOnRestore: buildDeleteOnRestorePaths(operations, existedBeforeTurn, finalText),
      patch: operations.map((operation) => operation.patchText).join("\n\n"),
      beforeBlobId,
      afterBlobId,
      changedAt: new Date().toISOString()
    };
  }

  async writeBlob(text) {
    const hash = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    const blobPath = path.join(this.blobsDir, `${hash}.txt`);
    if (!fs.existsSync(blobPath)) {
      await fsp.writeFile(blobPath, text, "utf8");
    }
    return hash;
  }

  async readBlob(blobId) {
    if (!blobId) {
      return null;
    }
    return fsp.readFile(path.join(this.blobsDir, `${blobId}.txt`), "utf8");
  }

  async planRestore(turnId) {
    const manifest = await this.readManifest(turnId);
    const entries = manifest.files.map((file) => normalizeManifestFile(file));
    return {
      snapshot: manifest,
      snapshotId: manifest.id,
      entries
    };
  }

  async restoreSnapshot(turnId) {
    const plan = await this.planRestore(turnId);
    const restoreState = await this.buildRestoreOperationState(plan.snapshot);
    const result = await this.applyPlan(plan, "restore");
    await this.markSessionState(plan.snapshot.sessionId, plan.snapshot.completedAt, false);
    await this.recordRestoreOperation(plan.snapshot, restoreState);
    return result;
  }

  async redoSnapshot(turnId) {
    const plan = await this.planRestore(turnId);
    const result = await this.applyPlan(plan, "redo");
    await this.markSessionState(plan.snapshot.sessionId, plan.snapshot.completedAt, true);
    return result;
  }

  async applyPlan(plan, mode) {
    let written = 0;
    let deleted = 0;

    for (const entry of plan.entries) {
      if (mode === "restore") {
        if (entry.restoreMode === "delete") {
          for (const deletePath of entry.deleteOnRestore || []) {
            if (fs.existsSync(deletePath)) {
              await fsp.unlink(deletePath);
              deleted += 1;
            }
          }
          continue;
        }

        const beforeText = await this.readBlob(entry.beforeBlobId);
        if (beforeText !== null) {
          await fsp.mkdir(path.dirname(entry.restorePath), { recursive: true });
          await fsp.writeFile(entry.restorePath, beforeText, "utf8");
          written += 1;
        }
        for (const deletePath of entry.deleteOnRestore || []) {
          if (deletePath !== entry.restorePath && fs.existsSync(deletePath)) {
            await fsp.unlink(deletePath);
            deleted += 1;
          }
        }
        continue;
      }

      const afterText = await this.readBlob(entry.afterBlobId);
      if (afterText !== null) {
        await fsp.mkdir(path.dirname(entry.path), { recursive: true });
        await fsp.writeFile(entry.path, afterText, "utf8");
        written += 1;
      }
    }

    return {
      snapshot: plan.snapshot,
      mode,
      written,
      deleted
    };
  }

  async collectConflicts(plan, mode) {
    const conflicts = [];

    for (const entry of plan.entries) {
      const expected = await this.getExpectedCurrentText(entry, mode);
      const comparePath = this.getComparePath(entry, mode);
      const current = fs.existsSync(comparePath) ? await fsp.readFile(comparePath, "utf8") : null;
      if (current !== expected) {
        conflicts.push({
          path: comparePath,
          mode,
          hasCurrent: current !== null,
          hasExpected: expected !== null
        });
      }
    }

    return conflicts;
  }

  async prepareDiffPreview(plan, entry) {
    const previewRoot = path.join(this.previewDir, plan.snapshotId, safePreviewPath(entry.path));
    const beforePath = path.join(previewRoot, "before", previewDisplayName(entry.path));
    const afterPath = path.join(previewRoot, "after", previewDisplayName(entry.path));

    await fsp.mkdir(path.dirname(beforePath), { recursive: true });
    await fsp.mkdir(path.dirname(afterPath), { recursive: true });
    await fsp.writeFile(beforePath, (await this.readBlob(entry.beforeBlobId)) || "", "utf8");
    await fsp.writeFile(afterPath, (await this.readBlob(entry.afterBlobId)) || "", "utf8");

    return {
      leftUri: vscode.Uri.file(beforePath),
      rightUri: vscode.Uri.file(afterPath),
      title: `${entry.path} (${entry.kind})`
    };
  }

  getComparePath(entry, mode) {
    return mode === "redo" ? entry.restorePath : entry.path;
  }

  async getExpectedCurrentText(entry, mode) {
    if (mode === "redo") {
      if (entry.restoreMode === "delete") {
        return null;
      }
      return this.readBlob(entry.beforeBlobId);
    }
    return this.readBlob(entry.afterBlobId);
  }

  async clearAll() {
    await this.loadIndex();
    await fsp.rm(this.rootDir, { recursive: true, force: true });
    this.index = null;
    await fsp.mkdir(this.recordsDir, { recursive: true });
    await fsp.mkdir(this.blobsDir, { recursive: true });
    await fsp.mkdir(this.previewDir, { recursive: true });
    await this.loadIndex();
  }

  async clearSession(sessionId) {
    await this.loadIndex();
    const removed = this.index.turns.filter((turn) => turn.sessionId === sessionId);
    this.index.turns = this.index.turns.filter((turn) => turn.sessionId !== sessionId);

    for (const turn of removed) {
      if (turn.manifestPath && fs.existsSync(turn.manifestPath)) {
        await fsp.rm(turn.manifestPath, { force: true });
      }
      const previewPath = path.join(this.previewDir, turn.id);
      if (fs.existsSync(previewPath)) {
        await fsp.rm(previewPath, { recursive: true, force: true });
      }
    }

    await this.saveIndex();
    return removed.length;
  }

  async reapplyRestoreOperation(operationId) {
    await this.loadIndex();
    const operation = this.findSnapshot(operationId);
    if (!operation || operation.type !== "restore_op") {
      throw new Error(`Restore operation not found: ${operationId}`);
    }

    const replayIds = Array.isArray(operation.reactivateSnapshotIds) ? operation.reactivateSnapshotIds : [];
    const replaySnapshots = replayIds
      .map((id) => this.findSnapshot(id))
      .filter(Boolean)
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt));

    let written = 0;
    let deleted = 0;
    for (const snapshot of replaySnapshots) {
      const plan = await this.planRestore(snapshot.id);
      const result = await this.applyPlan(plan, "redo");
      written += result.written;
      deleted += result.deleted;
    }

    const previousActiveIds = new Set(operation.previousActiveSnapshotIds || []);
    for (const turn of this.index.turns) {
      if (turn.sessionId !== operation.sessionId || turn.type === "restore_op") {
        continue;
      }
      turn.active = previousActiveIds.has(turn.id);
    }

    this.index.turns = this.index.turns.filter((turn) => turn.id !== operationId);
    await this.saveIndex();

    return {
      written,
      deleted,
      snapshot: operation
    };
  }

  async markSessionState(sessionId, activeUpToCompletedAt, inclusive) {
    await this.loadIndex();
    for (const turn of this.index.turns) {
      if (turn.sessionId !== sessionId || turn.type === "restore_op") {
        continue;
      }
      turn.active = inclusive
        ? turn.completedAt <= activeUpToCompletedAt
        : turn.completedAt < activeUpToCompletedAt;
    }
    await this.saveIndex();
  }

  async buildRestoreOperationState(snapshot) {
    await this.loadIndex();
    const sameSessionTurns = this.index.turns
      .filter((turn) => turn.sessionId === snapshot.sessionId && turn.type !== "restore_op")
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt));

    const previousActiveSnapshotIds = sameSessionTurns
      .filter((turn) => turn.active !== false)
      .map((turn) => turn.id);

    const reactivateSnapshotIds = sameSessionTurns
      .filter((turn) => turn.active !== false && turn.completedAt >= snapshot.completedAt)
      .map((turn) => turn.id);

    return {
      previousActiveSnapshotIds,
      reactivateSnapshotIds
    };
  }

  async recordRestoreOperation(snapshot, restoreState) {
    await this.loadIndex();
    const completedAt = new Date().toISOString();
    const id = buildRestoreOperationId(snapshot.id, completedAt);
    this.index.turns.push({
      id,
      type: "restore_op",
      active: true,
      sessionId: snapshot.sessionId,
      sessionTitle: snapshot.sessionTitle || loadSessionNames(this.sessionIndexPath).get(snapshot.sessionId) || snapshot.sessionId,
      turnId: null,
      prompt: `Restore to ${shortText(snapshot.prompt || snapshot.id, 80)}`,
      promptFull: `Restore to ${snapshot.promptFull || snapshot.prompt || snapshot.id}`,
      completedAt,
      fileCount: snapshot.files ? snapshot.files.length : 0,
      manifestPath: null,
      sessionPath: snapshot.sessionPath || null,
      targetSnapshotId: snapshot.id,
      previousActiveSnapshotIds: restoreState.previousActiveSnapshotIds || [],
      reactivateSnapshotIds: restoreState.reactivateSnapshotIds || []
    });
    await this.saveIndex();
  }
}

function buildDeleteOnRestorePaths(operations, existedBeforeTurn, finalText) {
  const firstPath = operations[0].originalPath || operations[0].path;
  const lastPath = operations[operations.length - 1].path;
  if (!existedBeforeTurn && finalText !== null) {
    return [lastPath];
  }
  if (lastPath !== firstPath && existedBeforeTurn) {
    return [lastPath];
  }
  return [];
}

function buildRecordId(sessionId, turnId, completedAt) {
  return crypto
    .createHash("sha1")
    .update(`${sessionId}:${turnId}:${completedAt}`)
    .digest("hex")
    .slice(0, 16);
}

function buildRestoreOperationId(snapshotId, completedAt) {
  return crypto
    .createHash("sha1")
    .update(`restore:${snapshotId}:${completedAt}`)
    .digest("hex")
    .slice(0, 16);
}

function buildFileRecordId(filePath, patchText) {
  return crypto.createHash("sha1").update(`${filePath}:${patchText}`).digest("hex").slice(0, 12);
}

function safePreviewPath(filePath) {
  return crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 12);
}

function previewDisplayName(filePath) {
  return path.basename(filePath) || "snapshot.txt";
}

function collapseRepeatedOperations(operations) {
  const collapsed = [];
  for (const operation of operations) {
    const previous = collapsed[collapsed.length - 1];
    if (
      previous &&
      previous.kind === operation.kind &&
      previous.path === operation.path &&
      previous.originalPath === operation.originalPath &&
      previous.patchText === operation.patchText
    ) {
      continue;
    }
    collapsed.push(operation);
  }
  return collapsed;
}

function normalizeManifestFile(file) {
  const restoreMode =
    file.restoreMode === "delete"
      ? "delete"
      : file.restoreMode === "write"
        ? "write"
        : file.kind === "add" && !file.beforeBlobId
          ? "delete"
          : "write";
  const deleteOnRestore =
    Array.isArray(file.deleteOnRestore) && file.deleteOnRestore.length > 0
      ? file.deleteOnRestore
      : restoreMode === "delete"
        ? [file.path]
        : [];

  return {
    path: file.path,
    kind: restoreMode === "delete" ? "add" : file.kind,
    restoreMode,
    restorePath: file.restorePath || file.originalPath || file.path,
    deleteOnRestore,
    beforeBlobId: file.beforeBlobId || null,
    afterBlobId: file.afterBlobId || null
  };
}

function determineNetKind(existedBeforeTurn, finalText) {
  if (!existedBeforeTurn && finalText !== null) {
    return "add";
  }
  if (existedBeforeTurn && finalText === null) {
    return "delete";
  }
  if (existedBeforeTurn && finalText !== null) {
    return "update";
  }
  return null;
}

function loadSessionNames(sessionIndexPath) {
  const names = new Map();
  if (!sessionIndexPath || !fs.existsSync(sessionIndexPath)) {
    return names;
  }

  try {
    const raw = fs.readFileSync(sessionIndexPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry.id && entry.thread_name) {
          names.set(entry.id, entry.thread_name);
        }
      } catch (_error) {
        continue;
      }
    }
  } catch (_error) {
    return names;
  }

  return names;
}

module.exports = {
  SnapshotStore,
  buildRecordId,
  formatTimestamp
};
