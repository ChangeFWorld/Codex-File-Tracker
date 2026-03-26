"use strict";

function registerApplyPatchCall(activeTurn, payload) {
  if (!activeTurn || !payload) {
    return;
  }
  const callId = payload.call_id || `patch_${activeTurn.pendingPatchCalls.size}`;
  activeTurn.pendingPatchCalls.set(callId, payload.input || "");
}

function recordApplyPatchOutput(activeTurn, payload) {
  if (!activeTurn || !payload) {
    return;
  }
  const callId = payload.call_id;
  if (!callId || !activeTurn.pendingPatchCalls.has(callId)) {
    return;
  }

  const patchInput = activeTurn.pendingPatchCalls.get(callId);
  activeTurn.pendingPatchCalls.delete(callId);
  if (didApplyPatchSucceed(payload.output) && patchInput) {
    activeTurn.patches.push(patchInput);
  }
}

function didApplyPatchSucceed(output) {
  if (output == null) {
    return false;
  }

  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return didApplyPatchSucceed(JSON.parse(trimmed));
      } catch (_error) {
        return trimmed.startsWith("Success. Updated the following files:");
      }
    }
    return trimmed.startsWith("Success. Updated the following files:");
  }

  if (typeof output === "object") {
    if (output.metadata && output.metadata.exit_code === 0) {
      return true;
    }
    if (typeof output.output === "string") {
      return didApplyPatchSucceed(output.output);
    }
  }

  return false;
}

function collectSuccessfulApplyPatchInputs(events) {
  const activeTurn = {
    patches: [],
    pendingPatchCalls: new Map()
  };

  for (const event of events) {
    if (
      event &&
      event.type === "response_item" &&
      event.payload &&
      event.payload.type === "custom_tool_call" &&
      event.payload.name === "apply_patch" &&
      event.payload.status === "completed"
    ) {
      registerApplyPatchCall(activeTurn, event.payload);
      continue;
    }

    if (
      event &&
      event.type === "response_item" &&
      event.payload &&
      event.payload.type === "custom_tool_call_output"
    ) {
      recordApplyPatchOutput(activeTurn, event.payload);
    }
  }

  return activeTurn.patches;
}

module.exports = {
  collectSuccessfulApplyPatchInputs,
  didApplyPatchSucceed,
  recordApplyPatchOutput,
  registerApplyPatchCall
};
