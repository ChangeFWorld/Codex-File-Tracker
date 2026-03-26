"use strict";

const assert = require("assert");

const {
  collectSuccessfulApplyPatchInputs,
  didApplyPatchSucceed
} = require("../src/applyPatchEvents");

function testDidApplyPatchSucceedAcceptsSuccessfulOutputs() {
  assert.strictEqual(
    didApplyPatchSucceed("Success. Updated the following files:\nM /tmp/example.txt\n"),
    true
  );

  assert.strictEqual(
    didApplyPatchSucceed(
      JSON.stringify({
        output: "Success. Updated the following files:\nM /tmp/example.txt\n",
        metadata: { exit_code: 0 }
      })
    ),
    true
  );

  assert.strictEqual(
    didApplyPatchSucceed({
      output: "Success. Updated the following files:\nM /tmp/example.txt\n",
      metadata: { exit_code: 0 }
    }),
    true
  );
}

function testDidApplyPatchSucceedRejectsVerificationFailure() {
  const failedOutput =
    "apply_patch verification failed: Failed to find expected lines in /tmp/example.txt";
  assert.strictEqual(didApplyPatchSucceed(failedOutput), false);
  assert.strictEqual(didApplyPatchSucceed({ output: failedOutput, metadata: { exit_code: 1 } }), false);
  assert.strictEqual(
    didApplyPatchSucceed(JSON.stringify({ output: failedOutput, metadata: { exit_code: 1 } })),
    false
  );
}

function testCollectSuccessfulApplyPatchInputsIgnoresFailedCalls() {
  const patchOk = "*** Begin Patch\n*** Update File: /tmp/a.txt\n@@\n-old\n+new\n*** End Patch\n";
  const patchFail = "*** Begin Patch\n*** Update File: /tmp/b.txt\n@@\n-old\n+new\n*** End Patch\n";

  const events = [
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        status: "completed",
        call_id: "call_ok",
        input: patchOk
      }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_ok",
        output: {
          output: "Success. Updated the following files:\nM /tmp/a.txt\n",
          metadata: { exit_code: 0 }
        }
      }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        status: "completed",
        call_id: "call_fail",
        input: patchFail
      }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_fail",
        output: "apply_patch verification failed: Failed to find expected lines in /tmp/b.txt"
      }
    }
  ];

  assert.deepStrictEqual(collectSuccessfulApplyPatchInputs(events), [patchOk]);
}

function testCollectSuccessfulApplyPatchInputsMatchesRealRegressionShape() {
  const dualPatch1 = "*** Begin Patch\n*** Update File: /tmp/dual.py\n@@\n-old1\n+new1\n*** End Patch\n";
  const dualPatch2 = "*** Begin Patch\n*** Update File: /tmp/dual.py\n@@\n-old2\n+new2\n*** End Patch\n";
  const dualPatch3 = "*** Begin Patch\n*** Update File: /tmp/dual.py\n@@\n-old3\n+new3\n*** End Patch\n";
  const dualPatch4 = "*** Begin Patch\n*** Update File: /tmp/dual.py\n@@\n-old4\n+new4\n*** End Patch\n";

  const events = [
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", status: "completed", call_id: "c1", input: dualPatch1 }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c1",
        output: { output: "Success. Updated the following files:\nM /tmp/dual.py\n", metadata: { exit_code: 0 } }
      }
    },
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", status: "completed", call_id: "c2", input: dualPatch2 }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c2",
        output: { output: "Success. Updated the following files:\nM /tmp/dual.py\n", metadata: { exit_code: 0 } }
      }
    },
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", status: "completed", call_id: "c3", input: dualPatch3 }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c3",
        output: "apply_patch verification failed: Failed to find expected lines in /tmp/dual.py"
      }
    },
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", status: "completed", call_id: "c4", input: dualPatch4 }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c4",
        output: { output: "Success. Updated the following files:\nM /tmp/dual.py\n", metadata: { exit_code: 0 } }
      }
    }
  ];

  assert.deepStrictEqual(collectSuccessfulApplyPatchInputs(events), [dualPatch1, dualPatch2, dualPatch4]);
}

function testCollectSuccessfulApplyPatchInputsHandlesInterleavedCallIds() {
  const patchA = "*** Begin Patch\n*** Update File: /tmp/a.txt\n@@\n-old-a\n+new-a\n*** End Patch\n";
  const patchB = "*** Begin Patch\n*** Update File: /tmp/b.txt\n@@\n-old-b\n+new-b\n*** End Patch\n";

  const events = [
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", status: "completed", call_id: "a", input: patchA }
    },
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", status: "completed", call_id: "b", input: patchB }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "b",
        output: { output: "Success. Updated the following files:\nM /tmp/b.txt\n", metadata: { exit_code: 0 } }
      }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "a",
        output: { output: "Success. Updated the following files:\nM /tmp/a.txt\n", metadata: { exit_code: 0 } }
      }
    }
  ];

  assert.deepStrictEqual(collectSuccessfulApplyPatchInputs(events), [patchB, patchA]);
}

function testCollectSuccessfulApplyPatchInputsIgnoresOrphanAndPendingCalls() {
  const patchPending = "*** Begin Patch\n*** Update File: /tmp/pending.txt\n@@\n-old\n+new\n*** End Patch\n";
  const patchOk = "*** Begin Patch\n*** Update File: /tmp/ok.txt\n@@\n-old\n+new\n*** End Patch\n";

  const events = [
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "missing",
        output: { output: "Success. Updated the following files:\nM /tmp/missing.txt\n", metadata: { exit_code: 0 } }
      }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        status: "completed",
        call_id: "pending",
        input: patchPending
      }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        status: "completed",
        call_id: "ok",
        input: patchOk
      }
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "ok",
        output: { output: "Success. Updated the following files:\nM /tmp/ok.txt\n", metadata: { exit_code: 0 } }
      }
    }
  ];

  assert.deepStrictEqual(collectSuccessfulApplyPatchInputs(events), [patchOk]);
}

module.exports = {
  testDidApplyPatchSucceedAcceptsSuccessfulOutputs,
  testDidApplyPatchSucceedRejectsVerificationFailure,
  testCollectSuccessfulApplyPatchInputsIgnoresFailedCalls,
  testCollectSuccessfulApplyPatchInputsMatchesRealRegressionShape,
  testCollectSuccessfulApplyPatchInputsHandlesInterleavedCallIds,
  testCollectSuccessfulApplyPatchInputsIgnoresOrphanAndPendingCalls
};
