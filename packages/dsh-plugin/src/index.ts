import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { createDramaSkillProvider, createOhStorySkillProvider } from "./skill-provider.js";
import { registerOhStoryHooks } from "./native-hooks.js";
import { registerOhStoryRoleTool } from "./role-tool.js";
import { registerWorkspaceRoute } from "./workspace-route.js";
import { assertTrustedWorkspaceAuthority } from "./workspace-request-trust.js";

export { createDramaSkillProvider, createOhStorySkillProvider, parseBundledSkill } from "./skill-provider.js";
export { OH_STORY_ROLE_NAMES, loadBundledRole } from "./role-provider.js";
export { createOhStoryRoleTool, OH_STORY_ROLE_TOOL_NAME, registerOhStoryRoleTool, roleToolFilter } from "./role-tool.js";
export { registerWorkspaceRoute } from "./workspace-route.js";
export { registerOhStoryHooks } from "./native-hooks.js";

export const name = "oh-story";
export const inject = ["skills", "subagents", "tools", "typert", "webServer"];

/** DSH owns models, providers, presets, permissions, roots, runs, and sessions. */
export interface Config {
  readonly editorMaxBytes?: number;
  readonly trustedHosts?: string[];
}

export const Config = z.object({
  editorMaxBytes: z.natural().min(65_536).max(8_388_608).default(2_097_152),
  trustedHosts: z.array(String).default([])
}) as z<Config>;

/** Mount only domain contributions into the current DSH process. */
export async function apply(context: Context, config: Config = {}): Promise<void> {
  const trustedHosts = config.trustedHosts ?? [];
  for (const entry of trustedHosts) assertTrustedWorkspaceAuthority(entry);
  context.skills.registerProvider(() => createOhStorySkillProvider());
  context.skills.registerProvider(() => createDramaSkillProvider());
  registerOhStoryHooks(context);
  await registerOhStoryRoleTool(context);
  registerWorkspaceRoute(context, { maxBytes: config.editorMaxBytes ?? 2_097_152, trustedHosts });
}

export default { name, inject, Config, apply };
