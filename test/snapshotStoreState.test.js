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

module.exports = {
  testSnapshotStoreRestoreAndReapplyStateMachine,
  testSnapshotStoreRestoreAddThenDeleteOnRestore
};
