import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonValue } from "@deepseek-ai/dsh-session";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { OH_STORY_ROLE_NAMES, loadBundledRole, type OhStoryRoleName } from "./role-provider.js";

export const OH_STORY_ROLE_TOOL_NAME = "oh_story_role";

const roleTools: Readonly<Record<OhStoryRoleName, readonly string[]>> = {
  "chapter-extractor": ["read", "glob", "grep"],
  "character-designer": ["read", "glob", "grep", "write", "edit"],
  "consistency-checker": ["read", "glob", "grep"],
  "narrative-writer": ["read", "glob", "grep", "write", "edit", "bash"],
  "story-architect": ["read", "glob", "grep", "write", "edit"],
  "story-explorer": ["read", "glob", "grep"],
  "story-researcher": ["read", "glob", "grep", "bash", "write", "web_search", "web_fetch"]
};

export function roleToolFilter(role: OhStoryRoleName): { readonly allow: readonly string[] } {
  return { allow: roleTools[role] };
}

function resultText(output: readonly ContentBlock[]): string {
  return output.map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
}

export async function createOhStoryRoleTool(): Promise<ToolDefinition> {
  const personas = new Map<OhStoryRoleName, string>();
  await Promise.all(OH_STORY_ROLE_NAMES.map(async (role) => {
    personas.set(role, await loadBundledRole(role, undefined, "native-tools"));
  }));
  return defineTool({
    name: OH_STORY_ROLE_TOOL_NAME,
    description: "Run one focused Oh Story specialist as a child of the current DSH Agent. The child inherits DSH model, workspace, permissions, lifecycle, and UI.",
    parameters: {
      role: {
        type: "string",
        required: true,
        enum: OH_STORY_ROLE_NAMES,
        description: "The exact Oh Story Role to run."
      },
      prompt: {
        type: "string",
        required: true,
        description: "A self-contained task. The child inherits the current DSH workspace but not the current in-flight turn."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", required: true, enum: OH_STORY_ROLE_NAMES },
          runId: { type: "string", required: true },
          content: { type: "array", required: true, items: { type: "json" } }
        }
      },
      render: (_args, value) => [{ type: "text", text: resultText(value.content as unknown as ContentBlock[]) }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error("oh_story_role requires a calling DSH Agent.");
      const persona = personas.get(args.role);
      if (persona === undefined) throw new Error(`Oh Story Role ${args.role} is not bundled.`);
      const allowed = roleToolFilter(args.role).allow.filter((name) =>
        exec.agent?.ctx.tools.get(name, exec.agent) !== undefined);
      const run = await exec.agent.ctx.subagents.start("spawn", {
        label: `oh-story:${args.role}`,
        prompt: [{ type: "text", text: args.prompt }],
        parent: exec.agent,
        persona,
        toolFilter: { allow: allowed },
        maxDepth: 1,
        signal: exec.signal
      });
      try {
        const result = await run.result;
        if (result.stopReason !== "completed") {
          throw new Error(`Oh Story Role ${args.role} ended with ${result.stopReason}${result.diagnostic === undefined ? "" : `: ${result.diagnostic}`}`);
        }
        return {
          role: args.role,
          runId: run.id,
          content: result.output as unknown as JsonValue[]
        };
      } finally {
        await run.dispose();
      }
    }
  });
}

export async function registerOhStoryRoleTool(context: Context): Promise<void> {
  const definition = await createOhStoryRoleTool();
  let dispose: (() => void) | undefined;
  const mount = (): void => { dispose ??= context.tools.register(definition); };
  const unmount = (): void => { dispose?.(); dispose = undefined; };
  context.on("subagent/provider-added", (provider) => { if (provider.name === "spawn") mount(); });
  context.on("subagent/provider-removed", (name) => { if (name === "spawn") unmount(); });
  if (context.subagents.getProvider("spawn") !== undefined) mount();
}
