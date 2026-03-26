"use strict";

const crypto = require("crypto");
const os = require("os");
const path = require("path");

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function normalizeSlashes(value) {
  return value.split(path.sep).join("/");
}

function sha256(bufferOrString) {
  return crypto.createHash("sha256").update(bufferOrString).digest("hex");
}

function shortText(value, maxLength = 80) {
  if (!value) {
    return "";
  }
  const compact = String(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}...`;
}

function extractUserPrompt(value, maxLength = 140) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    return "(no prompt)";
  }

  const requestMatch = [...text.matchAll(/(?:^|\n)#{0,6}\s*My request for Codex:\s*/g)].pop();
  let candidate = requestMatch ? text.slice(requestMatch.index + requestMatch[0].length) : text;

  candidate = candidate
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("## Active file:") && !line.startsWith("## Open tabs:"))
    .join(" ");

  candidate = candidate.replace(/<image>/g, " ").trim();

  if (!candidate) {
    return "(no prompt)";
  }

  const compact = shortText(candidate, maxLength);
  if (
    compact.startsWith("# Context from my IDE setup:") ||
    compact.startsWith("Context from my IDE setup:")
  ) {
    return "(prompt unavailable)";
  }
  return compact;
}

function sortByCreatedDesc(items) {
  return [...items].sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id < right.id ? 1 : -1;
    }
    return right.createdAt.localeCompare(left.createdAt);
  });
}

function isSubPath(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

module.exports = {
  expandHome,
  formatTimestamp,
  isSubPath,
  normalizeSlashes,
  sha256,
  extractUserPrompt,
  shortText,
  sortByCreatedDesc
};
