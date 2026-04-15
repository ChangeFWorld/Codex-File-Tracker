"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { makeTempDir, makeVscodeMock, requireFresh, withMockedVscode } = require("./testHelpers");

async function testWatcherConsumesOnlySuccessfulApplyPatchCallsAndUpdatesPrompt() {
  const codexRoot = makeTempDir();
  const workRoot = path.join(codexRoot, "workspace");
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(path.join(workRoot, "a.txt"), "old\n");

  const vscode = makeVscodeMock(codexRoot);
  await withMockedVscode(vscode, async () => {
    const { CodexWatcher } = requireFresh("../src/codexWatcher");
    const calls = [];
    const watcher = new CodexWatcher(
      {
        async createSnapshot(options) {
          calls.push(options);
          return { created: true, snapshot: { id: "snap-1" } };
        }
      },
      () => {}
    );

    const state = {
      filePath: "/tmp/session.jsonl",
      offset: 0,
      remainder: "",
      sessionId: null,
      lastUserMessage: "",
      activeTurn: null
    };

    const events = [
      {
        timestamp: "2026-03-25T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-1" }
      },
      {
        timestamp: "2026-03-25T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      },
      {
        timestamp: "2026-03-25T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "real prompt" }
      },
      {
        timestamp: "2026-03-25T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          status: "completed",
          call_id: "ok",
          input: `*** Begin Patch\n*** Update File: ${path.join(workRoot, "a.txt")}\n@@\n-old\n+new\n*** End Patch\n`
        }
      },
      {
        timestamp: "2026-03-25T10:00:04.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "ok",
          output: { output: "Success. Updated the following files:\nM /tmp/a.txt\n", metadata: { exit_code: 0 } }
        }
      },
      {
        timestamp: "2026-03-25T10:00:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          status: "completed",
          call_id: "bad",
          input: `*** Begin Patch\n*** Update File: ${path.join(workRoot, "b.txt")}\n@@\n-old\n+new\n*** End Patch\n`
        }
      },
      {
        timestamp: "2026-03-25T10:00:06.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "bad",
          output: "apply_patch verification failed: Failed to find expected lines in /tmp/b.txt"
        }
      },
      {
        timestamp: "2026-03-25T10:00:07.000Z",
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "done" }
      }
    ];

    const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await watcher.consumeText(state, text, { createRecords: true, notify: false });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].sessionId, "session-1");
    assert.strictEqual(calls[0].turnId, "turn-1");
    assert.strictEqual(calls[0].prompt, "real prompt");
    assert.strictEqual(calls[0].patches.length, 1);
    assert.ok(calls[0].patches[0].includes(path.join(workRoot, "a.txt")));
    assert.deepStrictEqual(calls[0].prePatchFiles[path.join(workRoot, "a.txt")], {
      existed: true,
      text: "old\n"
    });
    assert.strictEqual(state.activeTurn, null);
  });
}

async function testWatcherRecordsAbortedTurnsWhenSuccessfulPatchExists() {
  const codexRoot = makeTempDir();
  const workRoot = path.join(codexRoot, "workspace");
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(path.join(workRoot, "a.txt"), "old\n");

  const vscode = makeVscodeMock(codexRoot);
  await withMockedVscode(vscode, async () => {
    const { CodexWatcher } = requireFresh("../src/codexWatcher");
    const calls = [];
    const watcher = new CodexWatcher(
      {
        async createSnapshot(options) {
          calls.push(options);
          return { created: true, snapshot: { id: "snap-1" } };
        }
      },
      () => {}
    );

    const state = {
      filePath: "/tmp/session.jsonl",
      offset: 0,
      remainder: "",
      sessionId: "session-1",
      lastUserMessage: "",
      activeTurn: null
    };

    const events = [
      {
        timestamp: "2026-03-25T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      },
      {
        timestamp: "2026-03-25T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "prompt" }
      },
      {
        timestamp: "2026-03-25T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          status: "completed",
          call_id: "ok",
          input: `*** Begin Patch\n*** Update File: ${path.join(workRoot, "a.txt")}\n@@\n-old\n+new\n*** End Patch\n`
        }
      },
      {
        timestamp: "2026-03-25T10:00:04.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "ok",
          output: { output: "Success. Updated the following files:\nM /tmp/a.txt\n", metadata: { exit_code: 0 } }
        }
      },
      {
        timestamp: "2026-03-25T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "turn_aborted" }
      }
    ];

    const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await watcher.consumeText(state, text, { createRecords: true, notify: false });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].turnId, "turn-1");
    assert.strictEqual(calls[0].completedAt, "2026-03-25T10:00:05.000Z");
    assert.strictEqual(calls[0].lastAgentMessage, "");
    assert.deepStrictEqual(calls[0].prePatchFiles[path.join(workRoot, "a.txt")], {
      existed: true,
      text: "old\n"
    });
    assert.strictEqual(state.activeTurn, null);
  });
}

async function testWatcherSkipsAbortedTurnsWithoutSuccessfulPatch() {
  const vscode = makeVscodeMock("/tmp/mock-codex-root");
  await withMockedVscode(vscode, async () => {
    const { CodexWatcher } = requireFresh("../src/codexWatcher");
    let called = false;
    const watcher = new CodexWatcher(
      {
        async createSnapshot() {
          called = true;
          return { created: true, snapshot: { id: "snap-1" } };
        }
      },
      () => {}
    );

    const state = {
      filePath: "/tmp/session.jsonl",
      offset: 0,
      remainder: "",
      sessionId: "session-1",
      lastUserMessage: "",
      activeTurn: null
    };

    const events = [
      {
        timestamp: "2026-03-25T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      },
      {
        timestamp: "2026-03-25T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "prompt" }
      },
      {
        timestamp: "2026-03-25T10:00:03.000Z",
        type: "event_msg",
        payload: { type: "turn_aborted" }
      },
      {
        timestamp: "2026-03-25T10:00:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete" }
      }
    ];

    const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await watcher.consumeText(state, text, { createRecords: true, notify: false });

    assert.strictEqual(called, false);
    assert.strictEqual(state.activeTurn, null);
  });
}

async function testWatcherLogsSnapshotRecordedForCompletedTurn() {
  const codexRoot = makeTempDir();
  const workRoot = path.join(codexRoot, "workspace");
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(path.join(workRoot, "a.txt"), "old\n");

  const vscode = makeVscodeMock(codexRoot);
  await withMockedVscode(vscode, async () => {
    const { CodexWatcher } = requireFresh("../src/codexWatcher");
    const events = [];
    const watcher = new CodexWatcher(
      {
        async createSnapshot() {
          return { created: true, snapshot: { id: "snap-1" } };
        },
        async appendTrackerEvent(kind, payload) {
          events.push({ kind, payload });
        }
      },
      () => {}
    );

    const state = {
      filePath: "/tmp/session.jsonl",
      offset: 0,
      remainder: "",
      sessionId: "session-1",
      lastUserMessage: "",
      activeTurn: null
    };

    const eventsText = [
      {
        timestamp: "2026-03-25T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      },
      {
        timestamp: "2026-03-25T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          status: "completed",
          call_id: "ok",
          input: `*** Begin Patch\n*** Update File: ${path.join(workRoot, "a.txt")}\n@@\n-old\n+new\n*** End Patch\n`
        }
      },
      {
        timestamp: "2026-03-25T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "ok",
          output: { output: "Success. Updated the following files:\nM /tmp/a.txt\n", metadata: { exit_code: 0 } }
        }
      },
      {
        timestamp: "2026-03-25T10:00:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "done" }
      }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";

    await watcher.consumeText(state, eventsText, { createRecords: true, notify: false });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, "snapshot_recorded");
    assert.strictEqual(events[0].payload.interrupted, false);
    assert.strictEqual(events[0].payload.turnId, "turn-1");
    assert.strictEqual(events[0].payload.patchCount, 1);
    assert.strictEqual(events[0].payload.completedAt, "2026-03-25T10:00:04.000Z");
  });
}

async function testWatcherLogsSnapshotRecordedForAbortedTurn() {
  const codexRoot = makeTempDir();
  const workRoot = path.join(codexRoot, "workspace");
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(path.join(workRoot, "a.txt"), "old\n");

  const vscode = makeVscodeMock(codexRoot);
  await withMockedVscode(vscode, async () => {
    const { CodexWatcher } = requireFresh("../src/codexWatcher");
    const events = [];
    const watcher = new CodexWatcher(
      {
        async createSnapshot() {
          return { created: true, snapshot: { id: "snap-1" } };
        },
        async appendTrackerEvent(kind, payload) {
          events.push({ kind, payload });
        }
      },
      () => {}
    );

    const state = {
      filePath: "/tmp/session.jsonl",
      offset: 0,
      remainder: "",
      sessionId: "session-1",
      lastUserMessage: "",
      activeTurn: null
    };

    const eventsText = [
      {
        timestamp: "2026-03-25T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      },
      {
        timestamp: "2026-03-25T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          status: "completed",
          call_id: "ok",
          input: `*** Begin Patch\n*** Update File: ${path.join(workRoot, "a.txt")}\n@@\n-old\n+new\n*** End Patch\n`
        }
      },
      {
        timestamp: "2026-03-25T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "ok",
          output: { output: "Success. Updated the following files:\nM /tmp/a.txt\n", metadata: { exit_code: 0 } }
        }
      },
      {
        timestamp: "2026-03-25T10:00:04.000Z",
        type: "event_msg",
        payload: { type: "turn_aborted" }
      }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";

    await watcher.consumeText(state, eventsText, { createRecords: true, notify: false });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, "snapshot_recorded");
    assert.strictEqual(events[0].payload.interrupted, true);
    assert.strictEqual(events[0].payload.turnId, "turn-1");
    assert.strictEqual(events[0].payload.patchCount, 1);
    assert.strictEqual(events[0].payload.completedAt, "2026-03-25T10:00:04.000Z");
  });
}

async function testWatcherPrunesMissingSessionStatesDuringScan() {
  const codexRoot = makeTempDir();
  const sessionsRoot = path.join(codexRoot, "sessions", "2026", "04", "16");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const sessionA = path.join(sessionsRoot, "a.jsonl");
  const sessionB = path.join(sessionsRoot, "b.jsonl");
  fs.writeFileSync(sessionA, "");
  fs.writeFileSync(sessionB, "");

  const vscode = makeVscodeMock(codexRoot);
  await withMockedVscode(vscode, async () => {
    const { CodexWatcher } = requireFresh("../src/codexWatcher");
    const watcher = new CodexWatcher(
      {
        async createSnapshot() {
          return { created: false, snapshot: null };
        }
      },
      () => {}
    );

    await watcher.scanOnce();
    assert.strictEqual(watcher.sessionStates.size, 2);

    fs.unlinkSync(sessionB);
    await watcher.scanOnce();

    assert.strictEqual(watcher.sessionStates.size, 1);
    assert.ok(watcher.sessionStates.has(sessionA));
    assert.strictEqual(watcher.sessionStates.has(sessionB), false);
  });
}

async function testWatcherIgnoresEventLoggingFailureAfterSnapshotCreation() {
  const codexRoot = makeTempDir();
  const workRoot = path.join(codexRoot, "workspace");
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(path.join(workRoot, "a.txt"), "old\n");

  const vscode = makeVscodeMock(codexRoot);
  await withMockedVscode(vscode, async () => {
    const { CodexWatcher } = requireFresh("../src/codexWatcher");
    let created = false;
    const watcher = new CodexWatcher(
      {
        async createSnapshot() {
          created = true;
          return { created: true, snapshot: { id: "snap-1" } };
        },
        async appendTrackerEvent() {
          throw new Error("log failed");
        }
      },
      () => {}
    );

    const state = {
      filePath: "/tmp/session.jsonl",
      offset: 0,
      remainder: "",
      sessionId: "session-1",
      lastUserMessage: "",
      activeTurn: null
    };

    const eventsText = [
      {
        timestamp: "2026-03-25T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      },
      {
        timestamp: "2026-03-25T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          status: "completed",
          call_id: "ok",
          input: `*** Begin Patch\n*** Update File: ${path.join(workRoot, "a.txt")}\n@@\n-old\n+new\n*** End Patch\n`
        }
      },
      {
        timestamp: "2026-03-25T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "ok",
          output: { output: "Success. Updated the following files:\nM /tmp/a.txt\n", metadata: { exit_code: 0 } }
        }
      },
      {
        timestamp: "2026-03-25T10:00:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "done" }
      }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";

    await watcher.consumeText(state, eventsText, { createRecords: true, notify: false });

    assert.strictEqual(created, true);
  });
}

module.exports = {
  testWatcherConsumesOnlySuccessfulApplyPatchCallsAndUpdatesPrompt,
  testWatcherRecordsAbortedTurnsWhenSuccessfulPatchExists,
  testWatcherSkipsAbortedTurnsWithoutSuccessfulPatch,
  testWatcherLogsSnapshotRecordedForCompletedTurn,
  testWatcherLogsSnapshotRecordedForAbortedTurn,
  testWatcherPrunesMissingSessionStatesDuringScan,
  testWatcherIgnoresEventLoggingFailureAfterSnapshotCreation
};
