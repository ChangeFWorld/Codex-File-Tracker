"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const vscode = require("vscode");

const {
  didApplyPatchSucceed,
  recordApplyPatchOutput,
  registerApplyPatchCall
} = require("./applyPatchEvents");
const { parseApplyPatch } = require("./patchUtils");
const { expandHome, extractUserPrompt } = require("./utils");

class CodexWatcher {
  constructor(snapshotStore, onSnapshotsChanged) {
    this.snapshotStore = snapshotStore;
    this.onSnapshotsChanged = onSnapshotsChanged;
    this.timer = null;
    this.running = false;
    this.sessionStates = new Map();
  }

  async start() {
    await this.scanOnce();
    const configuration = vscode.workspace.getConfiguration("codexSnapshots");
    const intervalMs = Number(configuration.get("scanIntervalMs", 5000));
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scanOnce() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const codexRoot = expandHome(
        vscode.workspace.getConfiguration("codexSnapshots").get("codexRoot", "~/.codex")
      );
      const sessionsDir = path.join(codexRoot, "sessions");
      if (!fs.existsSync(sessionsDir)) {
        return;
      }
      const files = await collectJsonlFiles(sessionsDir);
      for (const filePath of files) {
        try {
          await this.processSessionFile(filePath);
        } catch (_error) {
          continue;
        }
      }
    } finally {
      this.running = false;
    }
  }

  async processSessionFile(filePath) {
    const stats = await fsp.stat(filePath);
    const backfillRecent = isRecentSession(stats);
    let state = this.sessionStates.get(filePath);
    if (!state) {
      state = createInitialState(filePath);
      this.sessionStates.set(filePath, state);
      const content = await fsp.readFile(filePath, "utf8");
      await this.consumeText(state, content, { createRecords: backfillRecent, notify: false });
      state.offset = Buffer.byteLength(content, "utf8");
      return;
    }

    if (stats.size < state.offset) {
      state = createInitialState(filePath);
      this.sessionStates.set(filePath, state);
      const content = await fsp.readFile(filePath, "utf8");
      await this.consumeText(state, content, { createRecords: backfillRecent, notify: false });
      state.offset = Buffer.byteLength(content, "utf8");
      return;
    }

    if (stats.size === state.offset) {
      return;
    }

    const handle = await fsp.open(filePath, "r");
    try {
      const length = stats.size - state.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, state.offset);
      const appended = buffer.toString("utf8");
      state.offset = stats.size;
      await this.consumeText(state, appended, { createRecords: true, notify: true });
    } finally {
      await handle.close();
    }
  }

  async consumeText(state, text, options) {
    const payload = `${state.remainder}${text}`;
    const lines = payload.split(/\r?\n/);
    state.remainder = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        continue;
      }
      await this.handleEvent(state, event, options);
    }
  }

  async handleEvent(state, event, options) {
    const createRecords = options && options.createRecords;
    const notify = options && options.notify;

    if (event.type === "session_meta") {
      state.sessionId = event.payload && event.payload.id;
      return;
    }

    if (event.type === "event_msg" && event.payload && event.payload.type === "user_message") {
      const message = sanitizePrompt(event.payload.message || "");
      if (message) {
        state.lastUserMessage = extractUserPrompt(message, 140);
        if (state.activeTurn) {
          state.activeTurn.prompt = state.lastUserMessage;
        }
      }
      return;
    }

    if (event.type === "response_item" && event.payload && event.payload.type === "message") {
      if (event.payload.role === "user") {
        const fragments = event.payload.content || [];
        const userText = fragments
          .filter((part) => part.type === "input_text" || part.type === "output_text")
          .map((part) => part.text)
          .join(" ");
        const sanitized = sanitizePrompt(userText);
        if (sanitized) {
          state.lastUserMessage = extractUserPrompt(sanitized, 140);
          if (state.activeTurn) {
            state.activeTurn.prompt = state.lastUserMessage;
          }
        }
      }
      return;
    }

    if (event.type === "event_msg" && event.payload && event.payload.type === "task_started") {
      state.activeTurn = {
        turnId: event.payload.turn_id,
        startedAt: event.timestamp,
        prompt: state.lastUserMessage || "(no prompt)",
        patches: [],
        pendingPatchCalls: new Map(),
        prePatchFiles: new Map()
      };
      return;
    }

    if (
      event.type === "response_item" &&
      event.payload &&
      event.payload.type === "custom_tool_call" &&
      event.payload.name === "apply_patch" &&
      event.payload.status === "completed"
    ) {
      if (state.activeTurn) {
        registerApplyPatchCall(state.activeTurn, event.payload);
        await this.capturePrePatchFiles(state.activeTurn, event.payload.input || "");
      }
      return;
    }

    if (
      event.type === "response_item" &&
      event.payload &&
      event.payload.type === "custom_tool_call_output"
    ) {
      if (!state.activeTurn) {
        return;
      }
      recordApplyPatchOutput(state.activeTurn, event.payload);
      return;
    }

    if (event.type === "event_msg" && event.payload && event.payload.type === "turn_aborted") {
      state.activeTurn = null;
      return;
    }

    if (event.type === "event_msg" && event.payload && event.payload.type === "task_complete") {
      const activeTurn = state.activeTurn;
      if (!activeTurn || !createRecords) {
        state.activeTurn = null;
        return;
      }
      const result = await this.snapshotStore.createSnapshot({
        sessionId: state.sessionId,
        turnId: activeTurn.turnId,
        prompt: activeTurn.prompt,
        startedAt: activeTurn.startedAt,
        completedAt: event.timestamp,
        sessionPath: state.filePath,
        lastAgentMessage: event.payload.last_agent_message || "",
        patches: activeTurn.patches,
        prePatchFiles: serializePrePatchFiles(activeTurn.prePatchFiles)
      });
      state.activeTurn = null;
      if (result.created) {
        this.onSnapshotsChanged();
        if (notify) {
          vscode.window.showInformationMessage("Codex AI file record captured.");
        }
      }
    }
  }

  async capturePrePatchFiles(activeTurn, patchText) {
    if (!activeTurn || !patchText) {
      return;
    }

    const operations = parseApplyPatch(patchText);
    for (const operation of operations) {
      const probePath = operation.originalPath || operation.path;
      if (!probePath || activeTurn.prePatchFiles.has(probePath)) {
        continue;
      }

      if (fs.existsSync(probePath)) {
        activeTurn.prePatchFiles.set(probePath, {
          existed: true,
          text: await fsp.readFile(probePath, "utf8")
        });
        continue;
      }

      activeTurn.prePatchFiles.set(probePath, {
        existed: false,
        text: null
      });
    }
  }
}

function sanitizePrompt(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("<turn_aborted>")) {
    return "";
  }
  return normalized;
}

function createInitialState(filePath) {
  return {
    filePath,
    offset: 0,
    remainder: "",
    sessionId: null,
    lastUserMessage: "",
    activeTurn: null
  };
}

function serializePrePatchFiles(prePatchFiles) {
  return Object.fromEntries(prePatchFiles || []);
}

async function collectJsonlFiles(rootDir) {
  const files = [];
  const walk = async (currentDir) => {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(absolutePath);
      }
    }
  };
  await walk(rootDir);
  return files.sort();
}

function isRecentSession(stats) {
  const ageMs = Date.now() - stats.mtimeMs;
  return ageMs <= 6 * 60 * 60 * 1000;
}

module.exports = {
  CodexWatcher,
  didApplyPatchSucceed
};
