import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { createOhStoryRoleTool, OH_STORY_ROLE_TOOL_NAME, roleToolFilter } from "../src/role-tool.js";

describe("native Oh Story Role tool", () => {
  it("exposes all seven upstream personas through one DSH tool schema", async () => {
    const tool = await createOhStoryRoleTool();
    expect(tool.name).toBe(OH_STORY_ROLE_TOOL_NAME);
    expect(tool.parameters).toMatchObject({
      properties: { role: { enum: expect.arrayContaining(["chapter-extractor", "story-researcher"]) } }
    });
    expect(roleToolFilter("story-explorer")).toEqual({ allow: ["read", "glob", "grep"] });
    expect(roleToolFilter("narrative-writer")).toEqual({ allow: ["read", "glob", "grep", "write", "edit", "bash"] });
    expect(roleToolFilter("story-researcher")).toEqual({
      allow: ["read", "glob", "grep", "bash", "write", "web_search", "web_fetch"]
    });
  });

  it("runs the selected exact persona with least-privilege tools and disposes it", async () => {
    const dispose = vi.fn(async () => {});
    const start = vi.fn(async () => ({
      id: "role-run-1",
      result: Promise.resolve({
        output: [{ type: "text", text: "研究结果" }],
        stopReason: "completed" as const
      }),
      dispose
    }));
    const agent = {
      ctx: {
        subagents: { start },
        tools: { get: vi.fn(() => ({})) }
      }
    } as unknown as Agent;
    const signal = new AbortController().signal;
    const callId = "call-1" as ToolRunContext["callId"];
    const tool = await createOhStoryRoleTool();
    const execute = tool.execute as (args: { readonly role: "narrative-writer"; readonly prompt: string }, exec: ToolRunContext) => Promise<unknown>;
    const result = await execute({ role: "narrative-writer", prompt: "根据给定材料起草一段正文" }, {
      agent,
      signal,
      callId,
      rootCallId: callId,
      name: OH_STORY_ROLE_TOOL_NAME,
      arguments: {},
      token: Symbol("tool") as ToolRunContext["token"],
      deferContext: vi.fn(),
      concludeTurn: vi.fn()
    });
    expect(start).toHaveBeenCalledWith("spawn", expect.objectContaining({
      label: "oh-story:narrative-writer",
      parent: agent,
      persona: expect.stringContaining("OH_STORY_DSH_ROLE:narrative-writer"),
      toolFilter: { allow: ["read", "glob", "grep", "write", "edit", "bash"] },
      maxDepth: 1,
      signal
    }));
    expect(result).toMatchObject({ role: "narrative-writer", runId: "role-run-1" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails closed and still disposes an incomplete role run", async () => {
    const dispose = vi.fn(async () => {});
    const start = vi.fn(async () => ({
      id: "role-run-2",
      result: Promise.resolve({ output: [], stopReason: "max-tokens" as const, diagnostic: "truncated" }),
      dispose
    }));
    const agent = {
      ctx: {
        subagents: { start },
        tools: { get: vi.fn(() => undefined) }
      }
    } as unknown as Agent;
    const callId = "call-2" as ToolRunContext["callId"];
    const tool = await createOhStoryRoleTool();
    const execute = tool.execute as (args: { readonly role: "story-explorer"; readonly prompt: string }, exec: ToolRunContext) => Promise<unknown>;
    await expect(execute({ role: "story-explorer", prompt: "查询伏笔" }, {
      agent,
      signal: new AbortController().signal,
      callId,
      rootCallId: callId,
      name: OH_STORY_ROLE_TOOL_NAME,
      arguments: {},
      token: Symbol("tool") as ToolRunContext["token"],
      deferContext: vi.fn(),
      concludeTurn: vi.fn()
    })).rejects.toThrow(/max-tokens.*truncated/u);
    expect(start).toHaveBeenCalledWith("spawn", expect.objectContaining({ toolFilter: { allow: [] } }));
    expect(dispose).toHaveBeenCalledOnce();
  });
});
