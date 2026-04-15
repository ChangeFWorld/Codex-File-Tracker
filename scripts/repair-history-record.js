"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.recordId && !args.sessionId) {
    throw new Error("Missing --record-id or --session-id");
  }

  const codexRoot = path.resolve(expandHome(args.codexRoot || "~/.codex"));
  const historyRoot = path.join(codexRoot, "ai-file-history");
  const recordsDir = path.join(historyRoot, "records");
  const blobsDir = path.join(historyRoot, "blobs");
  const sessionRecords = loadAllSessionRecords(recordsDir);
  const targets = selectTargets(sessionRecords, args);
  const outputs = [];
  const stateBySession = new Map();

  for (const target of targets) {
    const state = getSessionState(stateBySession, sessionRecords, target.sessionId, target.completedAt, blobsDir);
    const result = repairManifest(target, blobsDir, args.apply, state);
    outputs.push(result.output);
    state.updateFromManifest(result.manifest, blobsDir);
  }

  process.stdout.write(`${JSON.stringify(outputs.length === 1 ? outputs[0] : outputs, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = toCamelCase(arg.slice(2));
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function toCamelCase(input) {
  return input.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

function expandHome(inputPath) {
  if (!inputPath || inputPath === "~") {
    return process.env.HOME;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(process.env.HOME, inputPath.slice(2));
  }
  return inputPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (_error) {
      return null;
    }
  }).filter(Boolean);
}

function loadAllSessionRecords(recordsDir) {
  return fs.readdirSync(recordsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const manifest = readJson(path.join(recordsDir, name));
      manifest.__recordPath = path.join(recordsDir, name);
      return manifest;
    })
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
}

function selectTargets(sessionRecords, args) {
  if (args.recordId) {
    const target = sessionRecords.find((record) => record.id === args.recordId);
    if (!target) {
      throw new Error(`Record not found: ${args.recordId}`);
    }
    return [target];
  }

  const targets = sessionRecords.filter((record) => record.sessionId === args.sessionId);
  if (targets.length === 0) {
    throw new Error(`No records found for session: ${args.sessionId}`);
  }
  return targets;
}

function getSessionState(cache, sessionRecords, sessionId, beforeCompletedAt, blobsDir) {
  if (cache.has(sessionId)) {
    return cache.get(sessionId);
  }

  const state = {
    files: new Map(),
    updateFromManifest(manifest, currentBlobsDir) {
      for (const file of manifest.files || []) {
        this.files.set(file.path, readBlob(currentBlobsDir, file.afterBlobId));
      }
    }
  };

  for (const record of sessionRecords) {
    if (record.sessionId !== sessionId || record.completedAt >= beforeCompletedAt) {
      continue;
    }
    state.updateFromManifest(record, blobsDir);
  }

  cache.set(sessionId, state);
  return state;
}

function repairManifest(manifest, blobsDir, apply, state) {
  const sessionEvents = loadJsonl(manifest.sessionPath || "");
  const turnContext = collectTurnContext(sessionEvents, manifest.turnId);
  const changes = [];
  let updated = false;

  for (const file of manifest.files || []) {
    if (!isSuspiciousRecord(file)) {
      continue;
    }

    const beforeText = inferBeforeText(file, state.files, turnContext);
    const afterText = readBlob(blobsDir, file.afterBlobId);
    if (beforeText === undefined) {
      changes.push({
        path: file.path,
        status: "skipped",
        reason: "could not infer pre-turn content"
      });
      continue;
    }

    const oldSummary = summarizeFileRecord(file);
    const beforeBlobId = beforeText === null ? null : writeBlob(blobsDir, beforeText, apply);
    const repaired = repairFileRecord(file, beforeBlobId, beforeText, afterText);
    Object.assign(file, repaired);
    changes.push({
      path: file.path,
      status: "repaired",
      old: oldSummary,
      next: summarizeFileRecord(file)
    });
    updated = true;
  }

  if (updated && apply) {
    fs.writeFileSync(manifest.__recordPath, `${JSON.stringify(stripPrivateFields(manifest), null, 2)}\n`, "utf8");
  }

  return {
    manifest,
    output: {
      recordId: manifest.id,
      sessionId: manifest.sessionId,
      apply: Boolean(apply),
      updated,
      changes
    }
  };
}

function collectTurnContext(events, turnId) {
  const readsByPath = new Map();
  let inTurn = false;
  let reachedFirstPatch = false;

  for (const event of events) {
    if (event.type === "event_msg" && event.payload && event.payload.type === "task_started") {
      inTurn = event.payload.turn_id === turnId;
      reachedFirstPatch = false;
      continue;
    }
    if (!inTurn) {
      continue;
    }
    if (event.type === "event_msg" && event.payload && event.payload.type === "task_complete") {
      break;
    }
    if (
      event.type === "response_item" &&
      event.payload &&
      event.payload.type === "custom_tool_call" &&
      event.payload.name === "apply_patch" &&
      event.payload.status === "completed"
    ) {
      reachedFirstPatch = true;
      continue;
    }
    if (reachedFirstPatch) {
      continue;
    }
    if (event.type !== "event_msg" || !event.payload || event.payload.type !== "exec_command_end") {
      continue;
    }
    if (event.payload.turn_id !== turnId || !Array.isArray(event.payload.parsed_cmd)) {
      continue;
    }
    for (const parsed of event.payload.parsed_cmd) {
      if (parsed.type !== "read" || !parsed.path) {
        continue;
      }
      const content = normalizeOutput(event.payload.aggregated_output);
      readsByPath.set(path.resolve(event.payload.cwd || "", parsed.path), content);
    }
  }

  return { readsByPath };
}

function normalizeOutput(output) {
  if (typeof output !== "string") {
    return "";
  }
  return output.replace(/\r\n/g, "\n");
}

function buildPriorState(recordsDir, manifest, blobsDir) {
  const state = new Map();
  const sessionRecords = fs.readdirSync(recordsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(recordsDir, name)))
    .filter((entry) => entry.sessionId === manifest.sessionId && entry.completedAt < manifest.completedAt)
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt));

  for (const record of sessionRecords) {
    for (const file of record.files || []) {
      const afterText = readBlob(blobsDir, file.afterBlobId);
      state.set(file.path, afterText);
    }
  }

  return state;
}

function isSuspiciousRecord(file) {
  return file && file.kind === "add" && file.restoreMode === "delete" && !file.beforeBlobId;
}

function inferBeforeText(file, priorState, turnContext) {
  if (priorState.has(file.path)) {
    return priorState.get(file.path);
  }
  if (file.originalPath && priorState.has(file.originalPath)) {
    return priorState.get(file.originalPath);
  }
  const readPath = path.resolve(file.originalPath || file.path);
  if (turnContext.readsByPath.has(readPath)) {
    return turnContext.readsByPath.get(readPath);
  }
  return undefined;
}

function repairFileRecord(file, beforeBlobId, beforeText, afterText) {
  const existedBeforeTurn = beforeText !== null;
  const repaired = {
    kind: determineKind(beforeText, afterText),
    restoreMode: existedBeforeTurn ? "write" : "delete",
    restorePath: file.originalPath || file.path,
    deleteOnRestore: existedBeforeTurn ? [] : [file.path],
    beforeBlobId
  };
  return repaired;
}

function determineKind(beforeText, afterText) {
  if (beforeText === null && afterText !== null) {
    return "add";
  }
  if (beforeText !== null && afterText === null) {
    return "delete";
  }
  if (beforeText !== null && afterText !== null) {
    return "update";
  }
  return "add";
}

function summarizeFileRecord(file) {
  return {
    kind: file.kind,
    restoreMode: file.restoreMode,
    restorePath: file.restorePath,
    deleteOnRestore: file.deleteOnRestore || [],
    beforeBlobId: file.beforeBlobId || null,
    afterBlobId: file.afterBlobId || null
  };
}

function stripPrivateFields(manifest) {
  const output = { ...manifest };
  delete output.__recordPath;
  return output;
}

function readBlob(blobsDir, blobId) {
  if (!blobId) {
    return null;
  }
  const blobPath = path.join(blobsDir, `${blobId}.txt`);
  if (!fs.existsSync(blobPath)) {
    return null;
  }
  return fs.readFileSync(blobPath, "utf8");
}

function writeBlob(blobsDir, text, apply) {
  const blobId = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  const blobPath = path.join(blobsDir, `${blobId}.txt`);
  if (apply && !fs.existsSync(blobPath)) {
    fs.writeFileSync(blobPath, text, "utf8");
  }
  return blobId;
}

main();
