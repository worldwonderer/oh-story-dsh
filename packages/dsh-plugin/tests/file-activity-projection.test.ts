import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { fileActivityProjectionDefinition } from "../src/file-activity-projection.js";
import type { FileActivityProjection } from "../src/file-activity-projection-types.js";

function fold(state: FileActivityProjection, type: string, data: unknown): FileActivityProjection {
  return fileActivityProjectionDefinition.apply(state, { type, seq: 1, time: 1, data } as unknown as SessionEvent);
}

describe("file activity projection", () => {
  it("publishes incremental tool arguments and clears them when dispatch starts", () => {
    let state = fileActivityProjectionDefinition.init();
    state = fold(state, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "block-start", index: 0, blockType: "tool-call" }
    });
    state = fold(state, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "tool-call-delta", index: 0, id: "write-1", name: "write", argumentsDelta: '{"file_path":"正文/A.md",' }
    });
    state = fold(state, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "tool-call-delta", index: 0, id: "write-1", argumentsDelta: '"content":"逐字"}' }
    });

    expect(state.calls).toEqual([{
      slot: "2:1:0",
      callId: "write-1",
      name: "write",
      argsRaw: '{"file_path":"正文/A.md","content":"逐字"}'
    }]);

    state = fold(state, "tool/call", { turn: 2, step: 1, callId: "write-1", name: "write", arguments: state.calls[0]?.argsRaw });
    expect(state.calls).toEqual([]);
  });

  it("preserves parallel tool-call slots", () => {
    let state = fileActivityProjectionDefinition.init();
    for (const index of [0, 1]) {
      state = fold(state, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "tool-call-delta", index, id: `call-${String(index)}`, name: "write", argumentsDelta: `{"file_path":"正文/${String(index)}.md"` }
      });
    }
    expect(state.calls.map((call) => call.callId)).toEqual(["call-0", "call-1"]);
  });
});
