"use strict";

function parseApplyPatch(patchText) {
  const lines = normalizeLines(patchText).split("\n");
  const operations = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      const body = [];
      const start = index;
      index += 1;
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        body.push(lines[index]);
        index += 1;
      }
      operations.push({
        kind: "add",
        path: filePath,
        originalPath: null,
        body,
        patchText: lines.slice(start, index).join("\n")
      });
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const originalPath = line.slice("*** Update File: ".length).trim();
      const start = index;
      index += 1;
      let targetPath = originalPath;
      if (index < lines.length && lines[index].startsWith("*** Move to: ")) {
        targetPath = lines[index].slice("*** Move to: ".length).trim();
        index += 1;
      }
      const body = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        body.push(lines[index]);
        index += 1;
      }
      operations.push({
        kind: "update",
        path: targetPath,
        originalPath,
        body,
        patchText: lines.slice(start, index).join("\n")
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const filePath = line.slice("*** Delete File: ".length).trim();
      operations.push({
        kind: "delete",
        path: filePath,
        originalPath: filePath,
        body: [],
        patchText: line
      });
      index += 1;
      continue;
    }

    index += 1;
  }

  return operations;
}

function renderAfterForAdd(operation) {
  const lines = operation.body
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1));
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function reconstructBeforeFromPatch(afterText, operation) {
  const normalizedAfter = normalizeLines(afterText);
  const afterLines = splitLines(normalizedAfter);
  const hunks = parseHunks(operation.body);

  if (hunks.length === 0) {
    return normalizedAfter;
  }

  const beforeLines = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const afterPattern = hunk
      .filter((line) => line.type !== "-")
      .map((line) => line.text);
    const startIndex = findPattern(afterLines, afterPattern, cursor);
    if (startIndex === -1) {
      throw new Error(`Could not reconstruct pre-patch content for ${operation.path}`);
    }

    beforeLines.push(...afterLines.slice(cursor, startIndex));
    let afterIndex = startIndex;

    for (const line of hunk) {
      if (line.type === " ") {
        beforeLines.push(line.text);
        afterIndex += 1;
      } else if (line.type === "+") {
        afterIndex += 1;
      } else if (line.type === "-") {
        beforeLines.push(line.text);
      }
    }

    cursor = afterIndex;
  }

  beforeLines.push(...afterLines.slice(cursor));
  return beforeLines.join("\n") + (normalizedAfter.endsWith("\n") ? "\n" : "");
}

function parseHunks(bodyLines) {
  const hunks = [];
  let current = [];

  for (const rawLine of bodyLines) {
    if (rawLine.startsWith("@@")) {
      if (current.length > 0) {
        hunks.push(current);
        current = [];
      }
      continue;
    }
    if (rawLine === "*** End of File") {
      continue;
    }
    if (rawLine.startsWith(" ") || rawLine.startsWith("+") || rawLine.startsWith("-")) {
      current.push({
        type: rawLine[0],
        text: rawLine.slice(1)
      });
    }
  }

  if (current.length > 0) {
    hunks.push(current);
  }
  return hunks;
}

function findPattern(lines, pattern, fromIndex) {
  if (pattern.length === 0) {
    return fromIndex;
  }
  for (let i = fromIndex; i <= lines.length - pattern.length; i += 1) {
    let matched = true;
    for (let j = 0; j < pattern.length; j += 1) {
      if (lines[i + j] !== pattern[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return i;
    }
  }
  return -1;
}

function splitLines(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function normalizeLines(text) {
  return text.replace(/\r\n/g, "\n");
}

module.exports = {
  parseApplyPatch,
  reconstructBeforeFromPatch,
  renderAfterForAdd
};
