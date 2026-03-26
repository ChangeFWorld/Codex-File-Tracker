"use strict";

const tests = [
  require("./utils.test"),
  require("./applyPatchEvents.test"),
  require("./patchUtils.test"),
  require("./codexWatcher.test"),
  require("./snapshotStoreState.test")
];

async function main() {
  let passed = 0;
  for (const testModule of tests) {
    const entries = Object.entries(testModule).filter(([, value]) => typeof value === "function");
    for (const [name, fn] of entries) {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    }
  }
  console.log(`\n${passed} test(s) passed.`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
