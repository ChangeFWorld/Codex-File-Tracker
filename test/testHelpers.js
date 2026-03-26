"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

function withMockedVscode(mock, loader) {
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === "vscode") {
      return mock;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return loader();
  } finally {
    Module._load = originalLoad;
  }
}

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function makeTempDir(prefix = "codex-file-change-tracker-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeVscodeMock(codexRoot) {
  return {
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            if (key === "codexRoot") {
              return codexRoot;
            }
            if (key === "scanIntervalMs") {
              return 5000;
            }
            return fallback;
          }
        };
      }
    },
    window: {
      showInformationMessage() {},
      showWarningMessage() {},
      registerTreeDataProvider() {}
    },
    Uri: {
      file(filePath) {
        return { fsPath: filePath, path: filePath };
      }
    }
  };
}

module.exports = {
  makeTempDir,
  makeVscodeMock,
  requireFresh,
  withMockedVscode
};
