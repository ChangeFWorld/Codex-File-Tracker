"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { makeTempDir, makeVscodeMock, requireFresh, withMockedVscode } = require("./testHelpers");

async function testSnapshotStoreRestoreAndReapplyStateMachine() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });

    const file1 = path.join(workRoot, "file1.txt");
    const file2 = path.join(workRoot, "file2.txt");
    fs.writeFileSync(file1, "after-one\n");
    fs.writeFileSync(file2, "after-two\n");

    const before1 = await store.writeBlob("before-one\n");
    const after1 = await store.writeBlob("after-one\n");
    const before2 = await store.writeBlob("before-two\n");
    const after2 = await store.writeBlob("after-two\n");

    const manifest1Path = path.join(store.recordsDir, "turn1.json");
    const manifest2Path = path.join(store.recordsDir, "turn2.json");

    fs.writeFileSync(
      manifest1Path,
      JSON.stringify(
        {
          id: "turn1",
          sessionId: "session-1",
          sessionTitle: "session title",
          turnId: "turn-id-1",
          prompt: "first",
          completedAt: "2026-03-25T10:00:00.000Z",
          sessionPath: "/tmp/session.jsonl",
          files: [
            {
              path: file1,
              originalPath: file1,
              kind: "update",
              restoreMode: "write",
              restorePath: file1,
              deleteOnRestore: [],
              beforeBlobId: before1,
              afterBlobId: after1
            }
          ]
        },
        null,
        2
      )
    );

    fs.writeFileSync(
      manifest2Path,
      JSON.stringify(
        {
          id: "turn2",
          sessionId: "session-1",
          sessionTitle: "session title",
          turnId: "turn-id-2",
          prompt: "second",
          completedAt: "2026-03-25T10:05:00.000Z",
          sessionPath: "/tmp/session.jsonl",
          files: [
            {
              path: file2,
              originalPath: file2,
              kind: "update",
              restoreMode: "write",
              restorePath: file2,
              deleteOnRestore: [],
              beforeBlobId: before2,
              afterBlobId: after2
            }
          ]
        },
        null,
        2
      )
    );

    store.index = {
      version: 3,
      turns: [
        {
          id: "turn1",
          type: "ai_turn",
          active: true,
          sessionId: "session-1",
          sessionTitle: "session title",
          turnId: "turn-id-1",
          prompt: "first",
          completedAt: "2026-03-25T10:00:00.000Z",
          fileCount: 1,
          manifestPath: manifest1Path,
          sessionPath: "/tmp/session.jsonl"
        },
        {
          id: "turn2",
          type: "ai_turn",
          active: true,
          sessionId: "session-1",
          sessionTitle: "session title",
          turnId: "turn-id-2",
          prompt: "second",
          completedAt: "2026-03-25T10:05:00.000Z",
          fileCount: 1,
          manifestPath: manifest2Path,
          sessionPath: "/tmp/session.jsonl"
        }
      ]
    };
    await store.saveIndex();

    const restoreResult = await store.restoreSnapshot("turn2");
    assert.strictEqual(restoreResult.written, 1);
    assert.strictEqual(fs.readFileSync(file2, "utf8"), "before-two\n");

    const restoreOp = store.index.turns.find((turn) => turn.type === "restore_op");
    assert.ok(restoreOp);
    assert.strictEqual(store.findSnapshot("turn1").active, true);
    assert.strictEqual(store.findSnapshot("turn2").active, false);

    const reapplyResult = await store.reapplyRestoreOperation(restoreOp.id);
    assert.strictEqual(reapplyResult.written, 1);
    assert.strictEqual(fs.readFileSync(file2, "utf8"), "after-two\n");
    assert.strictEqual(store.findSnapshot("turn1").active, true);
    assert.strictEqual(store.findSnapshot("turn2").active, true);
    assert.strictEqual(store.index.turns.some((turn) => turn.id === restoreOp.id), false);
  });
}

async function testSnapshotStoreRestoreAddThenDeleteOnRestore() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const addedFile = path.join(workRoot, "added.txt");
    fs.writeFileSync(addedFile, "created-by-ai\n");

    const afterBlob = await store.writeBlob("created-by-ai\n");
    const manifestPath = path.join(store.recordsDir, "turn-add.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          id: "turn-add",
          sessionId: "session-2",
          sessionTitle: "session two",
          turnId: "turn-add-id",
          prompt: "add file",
          completedAt: "2026-03-25T11:00:00.000Z",
          sessionPath: "/tmp/session2.jsonl",
          files: [
            {
              path: addedFile,
              originalPath: addedFile,
              kind: "add",
              restoreMode: "delete",
              restorePath: addedFile,
              deleteOnRestore: [addedFile],
              beforeBlobId: null,
              afterBlobId: afterBlob
            }
          ]
        },
        null,
        2
      )
    );

    store.index = {
      version: 3,
      turns: [
        {
          id: "turn-add",
          type: "ai_turn",
          active: true,
          sessionId: "session-2",
          sessionTitle: "session two",
          turnId: "turn-add-id",
          prompt: "add file",
          completedAt: "2026-03-25T11:00:00.000Z",
          fileCount: 1,
          manifestPath,
          sessionPath: "/tmp/session2.jsonl"
        }
      ]
    };
    await store.saveIndex();

    const restoreResult = await store.restoreSnapshot("turn-add");
    assert.strictEqual(restoreResult.deleted, 1);
    assert.strictEqual(fs.existsSync(addedFile), false);
  });
}

async function testSnapshotStoreTreatsDeleteThenAddSamePathAsUpdateUsingPrePatchState() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, "report.txt");
    const beforeText = "old version\n";
    const afterText = "new version\n";
    fs.writeFileSync(filePath, afterText);

    const result = await store.createSnapshot({
      sessionId: "session-3",
      turnId: "turn-3",
      prompt: "replace file",
      completedAt: "2026-03-25T12:00:00.000Z",
      patches: [
        [
          "*** Begin Patch",
          `*** Delete File: ${filePath}`,
          `*** Add File: ${filePath}`,
          "+new version",
          "*** End Patch"
        ].join("\n")
      ],
      prePatchFiles: {
        [filePath]: {
          existed: true,
          text: beforeText
        }
      }
    });

    assert.strictEqual(result.created, true);
    const manifest = JSON.parse(fs.readFileSync(result.snapshot.manifestPath, "utf8"));
    assert.strictEqual(manifest.files.length, 1);
    assert.strictEqual(manifest.files[0].kind, "update");
    assert.strictEqual(manifest.files[0].restoreMode, "write");
    assert.strictEqual(await store.readBlob(manifest.files[0].beforeBlobId), beforeText);
    assert.strictEqual(await store.readBlob(manifest.files[0].afterBlobId), afterText);

    const restoreResult = await store.restoreSnapshot(result.snapshot.id);
    assert.strictEqual(restoreResult.deleted, 0);
    assert.strictEqual(fs.readFileSync(filePath, "utf8"), beforeText);
  });
}

async function testSnapshotStorePrefersReconstructedBeforeAndLogsMismatch() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, "report.txt");
    const reconstructedBeforeText = "old version\n";
    const capturedBeforeText = "wrong old version\n";
    const afterText = "new version\n";
    fs.writeFileSync(filePath, afterText);

    const result = await store.createSnapshot({
      sessionId: "session-4",
      turnId: "turn-4",
      prompt: "update file",
      completedAt: "2026-03-25T13:00:00.000Z",
      patches: [
        [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          "-old version",
          "+new version",
          "*** End Patch"
        ].join("\n")
      ],
      prePatchFiles: {
        [filePath]: {
          existed: true,
          text: capturedBeforeText
        }
      }
    });

    assert.strictEqual(result.created, true);
    const manifest = JSON.parse(fs.readFileSync(result.snapshot.manifestPath, "utf8"));
    assert.strictEqual(manifest.files.length, 1);
    assert.strictEqual(manifest.files[0].beforeSource, "reconstructed");
    assert.strictEqual(manifest.files[0].integrityWarning, true);
    assert.strictEqual(manifest.files[0].integrityWarningReason, "captured_before_mismatch");
    assert.strictEqual(await store.readBlob(manifest.files[0].beforeBlobId), reconstructedBeforeText);
    assert.strictEqual(await store.readBlob(manifest.files[0].capturedBeforeBlobId), capturedBeforeText);
    assert.strictEqual(await store.readBlob(manifest.files[0].reconstructedBeforeBlobId), reconstructedBeforeText);

    const eventLog = fs.readFileSync(store.eventsLogPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.strictEqual(eventLog.length, 1);
    assert.strictEqual(eventLog[0].kind, "prepatch_mismatch");
    assert.strictEqual(eventLog[0].payload.filePath, filePath);
    assert.strictEqual(eventLog[0].payload.capturedBeforeBlobId, manifest.files[0].capturedBeforeBlobId);
    assert.strictEqual(eventLog[0].payload.reconstructedBeforeBlobId, manifest.files[0].reconstructedBeforeBlobId);
  });
}

async function testSnapshotStoreFallsBackToCapturedBeforeWhenReconstructionFails() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, "report.txt");
    const capturedBeforeText = "old version\n";
    const afterText = "new version\n";
    fs.writeFileSync(filePath, afterText);

    const result = await store.createSnapshot({
      sessionId: "session-5",
      turnId: "turn-5",
      prompt: "update file",
      completedAt: "2026-03-25T14:00:00.000Z",
      patches: [
        [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          " missing-context",
          "-different old version",
          "+new version",
          "*** End Patch"
        ].join("\n")
      ],
      prePatchFiles: {
        [filePath]: {
          existed: true,
          text: capturedBeforeText
        }
      }
    });

    assert.strictEqual(result.created, true);
    const manifest = JSON.parse(fs.readFileSync(result.snapshot.manifestPath, "utf8"));
    assert.strictEqual(manifest.files[0].beforeSource, "captured");
    assert.strictEqual(manifest.files[0].integrityWarning, false);
    assert.strictEqual(await store.readBlob(manifest.files[0].beforeBlobId), capturedBeforeText);
    assert.strictEqual(manifest.files[0].reconstructedBeforeBlobId, null);
  });
}

async function testSnapshotStoreRejectsSnapshotWhenReconstructionFailsWithoutCapturedBefore() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, "report.txt");
    fs.writeFileSync(filePath, "new version\n");

    const result = await store.createSnapshot({
      sessionId: "session-6",
      turnId: "turn-6",
      prompt: "update file",
      completedAt: "2026-03-25T15:00:00.000Z",
      patches: [
        [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          " missing-context",
          "-different old version",
          "+new version",
          "*** End Patch"
        ].join("\n")
      ]
    });

    assert.strictEqual(result.created, false);
    assert.strictEqual(store.index.turns.length, 0);
  });
}

async function testSnapshotStoreRestoreAndRedoMoveToKeepsSingleLivePath() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const oldPath = path.join(workRoot, "old.txt");
    const newPath = path.join(workRoot, "new.txt");
    const beforeText = "before\n";
    const afterText = "after\n";
    fs.writeFileSync(newPath, afterText);

    const result = await store.createSnapshot({
      sessionId: "session-7",
      turnId: "turn-7",
      prompt: "rename file",
      completedAt: "2026-03-25T16:00:00.000Z",
      patches: [
        [
          "*** Begin Patch",
          `*** Update File: ${oldPath}`,
          `*** Move to: ${newPath}`,
          "@@",
          "-before",
          "+after",
          "*** End Patch"
        ].join("\n")
      ],
      prePatchFiles: {
        [oldPath]: {
          existed: true,
          text: beforeText
        }
      }
    });

    assert.strictEqual(result.created, true);
    const manifest = JSON.parse(fs.readFileSync(result.snapshot.manifestPath, "utf8"));
    assert.deepStrictEqual(manifest.files[0].deleteOnRedo, [oldPath]);

    const restoreResult = await store.restoreSnapshot(result.snapshot.id);
    assert.strictEqual(restoreResult.written, 1);
    assert.strictEqual(restoreResult.deleted, 1);
    assert.strictEqual(fs.existsSync(oldPath), true);
    assert.strictEqual(fs.existsSync(newPath), false);
    assert.strictEqual(fs.readFileSync(oldPath, "utf8"), beforeText);

    const redoResult = await store.redoSnapshot(result.snapshot.id);
    assert.strictEqual(redoResult.written, 1);
    assert.strictEqual(redoResult.deleted, 1);
    assert.strictEqual(fs.existsSync(oldPath), false);
    assert.strictEqual(fs.existsSync(newPath), true);
    assert.strictEqual(fs.readFileSync(newPath, "utf8"), afterText);
  });
}

async function testSnapshotStoreIgnoresTrackerEventWriteFailure() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const blockedPath = path.join(codexRoot, "blocked");
    fs.mkdirSync(blockedPath, { recursive: true });
    store.eventsLogPath = blockedPath;

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const filePath = path.join(workRoot, "report.txt");
    fs.writeFileSync(filePath, "new version\n");

    const result = await store.createSnapshot({
      sessionId: "session-8",
      turnId: "turn-8",
      prompt: "update file",
      completedAt: "2026-03-25T17:00:00.000Z",
      patches: [
        [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          "-old version",
          "+new version",
          "*** End Patch"
        ].join("\n")
      ],
      prePatchFiles: {
        [filePath]: {
          existed: true,
          text: "wrong old version\n"
        }
      }
    });

    assert.strictEqual(result.created, true);
    assert.strictEqual(store.index.turns.length, 1);
  });
}

async function testSnapshotStoreRedoMoveToSupportsLegacyManifestWithoutDeleteOnRedo() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const oldPath = path.join(workRoot, "old.txt");
    const newPath = path.join(workRoot, "new.txt");
    const beforeBlobId = await store.writeBlob("before\n");
    const afterBlobId = await store.writeBlob("after\n");

    fs.writeFileSync(oldPath, "before\n");

    const manifestPath = path.join(store.recordsDir, "legacy-move.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          id: "legacy-move",
          sessionId: "session-9",
          sessionTitle: "legacy move",
          turnId: "turn-9",
          prompt: "rename file",
          completedAt: "2026-03-25T18:00:00.000Z",
          sessionPath: "/tmp/session9.jsonl",
          files: [
            {
              path: newPath,
              originalPath: oldPath,
              kind: "update",
              restoreMode: "write",
              restorePath: oldPath,
              deleteOnRestore: [newPath],
              beforeBlobId,
              afterBlobId
            }
          ]
        },
        null,
        2
      )
    );

    store.index = {
      version: 3,
      turns: [
        {
          id: "legacy-move",
          type: "ai_turn",
          active: true,
          sessionId: "session-9",
          sessionTitle: "legacy move",
          turnId: "turn-9",
          prompt: "rename file",
          completedAt: "2026-03-25T18:00:00.000Z",
          fileCount: 1,
          manifestPath,
          sessionPath: "/tmp/session9.jsonl"
        }
      ]
    };
    await store.saveIndex();

    const redoResult = await store.redoSnapshot("legacy-move");
    assert.strictEqual(redoResult.written, 1);
    assert.strictEqual(redoResult.deleted, 1);
    assert.strictEqual(fs.existsSync(oldPath), false);
    assert.strictEqual(fs.existsSync(newPath), true);
    assert.strictEqual(fs.readFileSync(newPath, "utf8"), "after\n");
  });
}

async function testSnapshotStoreCapturesMixedTurnNetEffectsAcrossFiles() {
  const codexRoot = makeTempDir();
  const vscode = makeVscodeMock(codexRoot);

  await withMockedVscode(vscode, async () => {
    const { SnapshotStore } = requireFresh("../src/snapshotStore");
    const store = new SnapshotStore();
    await store.initialize();

    const workRoot = path.join(codexRoot, "workspace");
    fs.mkdirSync(workRoot, { recursive: true });
    const addedPath = path.join(workRoot, "added.txt");
    const updatedPath = path.join(workRoot, "updated.txt");
    const movedOldPath = path.join(workRoot, "moved-old.txt");
    const movedNewPath = path.join(workRoot, "moved-new.txt");

    fs.writeFileSync(addedPath, "created\n");
    fs.writeFileSync(updatedPath, "updated\n");
    fs.writeFileSync(movedNewPath, "moved-after\n");

    const result = await store.createSnapshot({
      sessionId: "session-10",
      turnId: "turn-10",
      prompt: "mixed turn",
      completedAt: "2026-03-25T19:00:00.000Z",
      patches: [
        [
          "*** Begin Patch",
          `*** Add File: ${addedPath}`,
          "+created",
          `*** Update File: ${updatedPath}`,
          "@@",
          "-before",
          "+updated",
          `*** Update File: ${movedOldPath}`,
          `*** Move to: ${movedNewPath}`,
          "@@",
          "-moved-before",
          "+moved-after",
          "*** End Patch"
        ].join("\n")
      ],
      prePatchFiles: {
        [updatedPath]: {
          existed: true,
          text: "before\n"
        },
        [movedOldPath]: {
          existed: true,
          text: "moved-before\n"
        }
      }
    });

    assert.strictEqual(result.created, true);
    const manifest = JSON.parse(fs.readFileSync(result.snapshot.manifestPath, "utf8"));
    assert.strictEqual(manifest.files.length, 3);

    const byPath = new Map(manifest.files.map((file) => [file.path, file]));
    assert.strictEqual(byPath.get(addedPath).kind, "add");
    assert.strictEqual(byPath.get(addedPath).restoreMode, "delete");
    assert.strictEqual(await store.readBlob(byPath.get(addedPath).afterBlobId), "created\n");

    assert.strictEqual(byPath.get(updatedPath).kind, "update");
    assert.strictEqual(byPath.get(updatedPath).restoreMode, "write");
    assert.strictEqual(await store.readBlob(byPath.get(updatedPath).beforeBlobId), "before\n");
    assert.strictEqual(await store.readBlob(byPath.get(updatedPath).afterBlobId), "updated\n");

    assert.strictEqual(byPath.get(movedNewPath).kind, "update");
    assert.strictEqual(byPath.get(movedNewPath).restorePath, movedOldPath);
    assert.deepStrictEqual(byPath.get(movedNewPath).deleteOnRedo, [movedOldPath]);
    assert.strictEqual(await store.readBlob(byPath.get(movedNewPath).beforeBlobId), "moved-before\n");
    assert.strictEqual(await store.readBlob(byPath.get(movedNewPath).afterBlobId), "moved-after\n");
  });
}

module.exports = {
  testSnapshotStoreRestoreAndReapplyStateMachine,
  testSnapshotStoreRestoreAddThenDeleteOnRestore,
  testSnapshotStoreTreatsDeleteThenAddSamePathAsUpdateUsingPrePatchState,
  testSnapshotStorePrefersReconstructedBeforeAndLogsMismatch,
  testSnapshotStoreFallsBackToCapturedBeforeWhenReconstructionFails,
  testSnapshotStoreRejectsSnapshotWhenReconstructionFailsWithoutCapturedBefore,
  testSnapshotStoreRestoreAndRedoMoveToKeepsSingleLivePath,
  testSnapshotStoreIgnoresTrackerEventWriteFailure,
  testSnapshotStoreRedoMoveToSupportsLegacyManifestWithoutDeleteOnRedo,
  testSnapshotStoreCapturesMixedTurnNetEffectsAcrossFiles
};
