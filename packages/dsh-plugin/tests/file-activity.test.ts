import type { ChatSnapshot, ConversationTimelineSnapshot, RunningToolCall } from "@deepseek-ai/dsh-client-runtime/client";
import { describe, expect, it } from "vitest";
import {
  creativeRelativePath,
  fileMutations,
  jsonStringPrefix,
  latestSettledMutation,
  mutatingCallIds,
  previewMutation,
  streamingAssistant,
  workbenchModeForPath
} from "../src/client/file-activity.js";

describe("official DSH file activity", () => {
  it("reads a tool-only Assistant from official Step location data", () => {
    const assistant = {
      status: "running" as const,
      turn: 2,
      step: 1,
      time: 1,
      blocks: [{ kind: "tool-call" as const, callId: "write-hidden", name: "write", argsRaw: "{}" }]
    };
    const timeline = {
      turnOrder: [2],
      turns: new Map([[2, {
        turn: 2,
        status: "open",
        start: undefined,
        end: undefined,
        data: { get: () => undefined },
        steps: [{
          turn: 2,
          step: 1,
          status: "open",
          start: undefined,
          end: undefined,
          data: { get: () => assistant }
        }]
      }]])
    } as unknown as ConversationTimelineSnapshot;

    expect(streamingAssistant(timeline)).toBe(assistant);
  });

  it("decodes a still-streaming JSON string prefix", () => {
    expect(jsonStringPrefix('{"file_path":"正文/第011章.md","content":"雨声\\n越来', "content"))
      .toEqual({ value: "雨声\n越来", complete: false });
    expect(jsonStringPrefix('{"content":"雨声\\n越来。"}', "content"))
      .toEqual({ value: "雨声\n越来。", complete: true });
  });

  it("projects a streaming write call before tool execution starts", () => {
    const activity = fileMutations([], {
      turn: 1,
      step: 1,
      blocks: [{
        kind: "tool-call",
        callId: "write-1",
        name: "write",
        argsRaw: '{"file_path":"正文/第011章.md","content":"第一行\\n第二'
      }]
    }).at(-1);
    expect(activity).toMatchObject({
      callId: "write-1",
      stage: "streaming",
      path: "正文/第011章.md",
      operation: "replace-file",
      newText: "第一行\n第二"
    });
    expect(previewMutation(activity!, "旧正文")).toBe("第一行\n第二");
  });

  it("uses the executing DSH call and previews targeted edits", () => {
    const running = [{
      callId: "edit-1",
      name: "edit",
      argsRaw: '{"file_path":"正文/第002章.md","old_string":"旧句","new_string":"新句正在生成',
      turn: 1,
      step: 1,
      time: 1,
      callView: null,
      subCalls: []
    }] as RunningToolCall[];
    const activity = fileMutations(running).at(-1);
    expect(activity).toMatchObject({ stage: "running", oldText: "旧句", newText: "新句正在生成" });
    expect(previewMutation(activity!, "开头。旧句。结尾。")).toBe("开头。新句正在生成。结尾。");
  });

  it("walks nested calls and preserves concurrent mutations", () => {
    const child = (callId: string, path: string): RunningToolCall => ({
      callId,
      name: "write",
      argsRaw: JSON.stringify({ file_path: path, content: callId }),
      turn: 1,
      step: 1,
      time: 1,
      callView: null,
      subCalls: []
    });
    const running: RunningToolCall[] = [{
      callId: "code-1",
      name: "run_code",
      argsRaw: "{}",
      turn: 1,
      step: 1,
      time: 1,
      callView: null,
      subCalls: [child("write-a", "正文/A.md"), child("write-b", "正文/B.md")]
    }];
    expect(fileMutations(running).map((value) => value.path)).toEqual(["正文/A.md", "正文/B.md"]);
    expect([...mutatingCallIds(running)]).toEqual(["code-1", "write-a", "write-b"]);
  });

  it("uses the latest durable DSH diff when a fast call leaves the live window", () => {
    const node = {
      key: "tool:write-1",
      kind: "tool-call",
      data: {
        root: {
          kind: "tool-result",
          callId: "write-1",
          isError: false,
          call: { name: "write", argsRaw: '{"file_path":"正文/新章.md","content":"完成"}' },
          callView: { card: "diff", title: "Write", diffs: [{ path: "正文/新章.md", oldText: null, newText: "完成" }] },
          resultView: null,
          subCalls: []
        }
      }
    };
    const chat = {
      order: [node.key],
      nodes: { get: (key: string) => key === node.key ? node : undefined }
    } as unknown as ChatSnapshot;
    expect(latestSettledMutation(chat)).toBe("write-1:0\0正文/新章.md");
  });

  it("uses official diff views and supports replace-all and deletion", () => {
    const replaceAll = fileMutations([{
      callId: "edit-all",
      name: "edit",
      argsRaw: '{"file_path":"正文/A.md","old_string":"旧","new_string":"新","replace_all":true}',
      turn: 1,
      step: 1,
      time: 1,
      callView: { card: "diff", title: "Edit", diffs: [{ path: "正文/A.md", oldText: "旧", newText: "新" }] },
      subCalls: []
    }]).at(-1);
    expect(previewMutation(replaceAll!, "旧/旧")).toBe("新/新");

    const deletion = fileMutations([{
      callId: "delete-text",
      name: "str_replace_editor",
      argsRaw: '{"command":"str_replace","path":"正文/A.md","old_str":"删掉"}',
      turn: 1,
      step: 1,
      time: 1,
      callView: null,
      subCalls: []
    }]).at(-1);
    expect(previewMutation(deletion!, "保留删掉结尾")).toBe("保留结尾");
  });

  it("accepts only editable story paths inside the current DSH workspace", () => {
    const cwd = "/books/demo";
    expect(creativeRelativePath("/books/demo/正文/第003章.md", cwd)).toBe("正文/第003章.md");
    expect(creativeRelativePath("设定/人物.json", cwd)).toBe("设定/人物.json");
    expect(creativeRelativePath("/books/demo/src/app.ts", cwd)).toBeUndefined();
    expect(creativeRelativePath("/正文/越界.md", cwd)).toBeUndefined();
    expect(creativeRelativePath("../正文/逃逸.md", cwd)).toBeUndefined();
  });

  it("recognizes short-drama files and chooses the matching workbench", () => {
    const cwd = "/shows/demo";
    expect(creativeRelativePath("/shows/demo/剧集/第01集.md", cwd)).toBe("剧集/第01集.md");
    expect(creativeRelativePath("short-drama.json", cwd)).toBe("short-drama.json");
    expect(creativeRelativePath(".short-drama/private.json", cwd)).toBeUndefined();
    expect(workbenchModeForPath("剧集/第01集.md")).toBe("drama");
    expect(workbenchModeForPath("正文/第001章.md")).toBe("story");
  });
});
