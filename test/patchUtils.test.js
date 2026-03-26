"use strict";

const assert = require("assert");

const {
  parseApplyPatch,
  reconstructBeforeFromPatch,
  renderAfterForAdd
} = require("../src/patchUtils");

function testParseApplyPatchHandlesMultiFilePatch() {
  const patch = [
    "*** Begin Patch",
    "*** Add File: /tmp/a.txt",
    "+hello",
    "*** Update File: /tmp/b.txt",
    "@@",
    "-before",
    "+after",
    "*** End Patch"
  ].join("\n");

  const operations = parseApplyPatch(patch);
  assert.strictEqual(operations.length, 2);
  assert.strictEqual(operations[0].kind, "add");
  assert.strictEqual(operations[0].path, "/tmp/a.txt");
  assert.strictEqual(operations[1].kind, "update");
  assert.strictEqual(operations[1].path, "/tmp/b.txt");
}

function testParseApplyPatchHandlesMoveTo() {
  const patch = [
    "*** Begin Patch",
    "*** Update File: /tmp/old.txt",
    "*** Move to: /tmp/new.txt",
    "@@",
    "-before",
    "+after",
    "*** End Patch"
  ].join("\n");

  const operation = parseApplyPatch(patch)[0];
  assert.strictEqual(operation.kind, "update");
  assert.strictEqual(operation.originalPath, "/tmp/old.txt");
  assert.strictEqual(operation.path, "/tmp/new.txt");
}

function testRenderAfterForAddBuildsFullFileText() {
  const operations = parseApplyPatch(
    ["*** Begin Patch", "*** Add File: /tmp/a.txt", "+line1", "+line2", "*** End Patch"].join("\n")
  );
  assert.strictEqual(renderAfterForAdd(operations[0]), "line1\nline2\n");
}

function testReconstructBeforeFromPatchRecoversOriginalContent() {
  const patch = [
    "*** Begin Patch",
    "*** Update File: /tmp/b.txt",
    "@@",
    " alpha",
    "-beta",
    "+beta-updated",
    " gamma",
    "*** End Patch"
  ].join("\n");

  const operation = parseApplyPatch(patch)[0];
  const afterText = "alpha\nbeta-updated\ngamma\n";
  const beforeText = reconstructBeforeFromPatch(afterText, operation);
  assert.strictEqual(beforeText, "alpha\nbeta\ngamma\n");
}

function testReconstructBeforeFromPatchHandlesTwoSequentialUpdates() {
  const firstPatch = parseApplyPatch(
    [
      "*** Begin Patch",
      "*** Update File: /tmp/c.txt",
      "@@",
      " root",
      "+first",
      "*** End Patch"
    ].join("\n")
  )[0];
  const secondPatch = parseApplyPatch(
    [
      "*** Begin Patch",
      "*** Update File: /tmp/c.txt",
      "@@",
      " root",
      " first",
      "+second",
      "*** End Patch"
    ].join("\n")
  )[0];

  const finalText = "root\nfirst\nsecond\n";
  const afterFirst = reconstructBeforeFromPatch(finalText, secondPatch);
  const original = reconstructBeforeFromPatch(afterFirst, firstPatch);

  assert.strictEqual(afterFirst, "root\nfirst\n");
  assert.strictEqual(original, "root\n");
}

function testReconstructBeforeFromPatchHandlesMultipleHunks() {
  const patch = [
    "*** Begin Patch",
    "*** Update File: /tmp/d.txt",
    "@@",
    " one",
    "-two",
    "+two-updated",
    " three",
    "@@",
    " five",
    "-six",
    "+six-updated",
    " seven",
    "*** End Patch"
  ].join("\n");

  const operation = parseApplyPatch(patch)[0];
  const afterText = "one\ntwo-updated\nthree\nfour\nfive\nsix-updated\nseven\n";
  const beforeText = reconstructBeforeFromPatch(afterText, operation);
  assert.strictEqual(beforeText, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
}

function testReconstructBeforeFromPatchUsesCursorForRepeatedContext() {
  const patch = [
    "*** Begin Patch",
    "*** Update File: /tmp/repeated.txt",
    "@@",
    " anchor",
    "-target-one",
    "+target-one-updated",
    " between",
    "@@",
    " anchor",
    "-target-two",
    "+target-two-updated",
    " tail",
    "*** End Patch"
  ].join("\n");

  const operation = parseApplyPatch(patch)[0];
  const afterText = "anchor\ntarget-one-updated\nbetween\nanchor\ntarget-two-updated\ntail\n";
  const beforeText = reconstructBeforeFromPatch(afterText, operation);
  assert.strictEqual(beforeText, "anchor\ntarget-one\nbetween\nanchor\ntarget-two\ntail\n");
}

module.exports = {
  testParseApplyPatchHandlesMultiFilePatch,
  testParseApplyPatchHandlesMoveTo,
  testRenderAfterForAddBuildsFullFileText,
  testReconstructBeforeFromPatchRecoversOriginalContent,
  testReconstructBeforeFromPatchHandlesTwoSequentialUpdates,
  testReconstructBeforeFromPatchHandlesMultipleHunks,
  testReconstructBeforeFromPatchUsesCursorForRepeatedContext
};
