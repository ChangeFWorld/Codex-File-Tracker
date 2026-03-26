"use strict";

const assert = require("assert");

const { extractUserPrompt } = require("../src/utils");

function testExtractUserPromptPrefersCodexRequestSection() {
  const input = [
    "# Context from my IDE setup:",
    "## Active file: demo.txt",
    "## Open tabs:",
    "- demo.txt",
    "",
    "## My request for Codex:",
    "请只修改 file1 和 file2，并解释原因。"
  ].join("\n");

  assert.strictEqual(extractUserPrompt(input, 140), "请只修改 file1 和 file2，并解释原因。");
}

function testExtractUserPromptFallsBackWhenOnlyIdeContextExists() {
  const input = [
    "# Context from my IDE setup:",
    "## Active file: demo.txt",
    "## Open tabs:",
    "- demo.txt"
  ].join("\n");

  assert.strictEqual(extractUserPrompt(input, 140), "(prompt unavailable)");
}

function testExtractUserPromptCompactsPlainPrompt() {
  assert.strictEqual(extractUserPrompt("   fix   the   failing   test   please   ", 140), "fix the failing test please");
}

module.exports = {
  testExtractUserPromptPrefersCodexRequestSection,
  testExtractUserPromptFallsBackWhenOnlyIdeContextExists,
  testExtractUserPromptCompactsPlainPrompt
};
