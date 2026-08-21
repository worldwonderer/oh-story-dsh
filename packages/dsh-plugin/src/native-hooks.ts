import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { PostToolDecision, PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";

const MUTATION_TOOLS = new Set(["write", "edit", "str_replace_editor"]);

export interface StoryMutation {
  readonly root: string;
  readonly path: string;
  readonly chapter?: number;
}

function mutationPath(name: string, args: unknown): string | undefined {
  if (!MUTATION_TOOLS.has(name) || typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (name === "str_replace_editor") {
    if (!new Set(["create", "str_replace", "insert"]).has(String(record.command))) return undefined;
    return typeof record.path === "string" && record.path.trim() !== "" ? record.path : undefined;
  }
  return typeof record.file_path === "string" && record.file_path.trim() !== "" ? record.file_path : undefined;
}

function normalizedRelativePath(path: string): string | undefined {
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else segments.push(part);
  }
  return segments.join("/");
}

export function detectStoryMutation(name: string, args: unknown, cwd: string | undefined): StoryMutation | undefined {
  const rawPath = mutationPath(name, args);
  if (cwd === undefined || rawPath === undefined) return undefined;
  const root = cwd.replaceAll("\\", "/").replace(/\/$/u, "");
  const candidate = rawPath.replaceAll("\\", "/");
  const absolute = candidate.startsWith("/") || /^[a-z]:\//iu.test(candidate) || /^[a-z][a-z\d+.-]*:\/\//iu.test(candidate);
  const insideRoot = /^[a-z]:\//iu.test(root)
    ? candidate.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : candidate.startsWith(`${root}/`);
  if (absolute && !insideRoot) return undefined;
  const normalized = normalizedRelativePath(absolute ? candidate.slice(root.length + 1) : candidate);
  if (normalized === undefined) return undefined;
  if (!normalized.startsWith("正文/")) return undefined;
  const chapterText = /第0*(\d+)章/u.exec(normalized)?.[1];
  return { root, path: normalized, ...(chapterText === undefined ? {} : { chapter: Number(chapterText) }) };
}

type StoryFileSystem = Pick<FileSystem, "resolve" | "contains" | "stat" | "listDir">;

async function storyMutation(exec: ToolExecution, fs: StoryFileSystem): Promise<StoryMutation | undefined> {
  const cwd = exec.agent?.session.header.cwd;
  const path = mutationPath(exec.name, exec.arguments);
  if (cwd === undefined || path === undefined) return undefined;
  try {
    const [rootTarget, mutationTarget] = await Promise.all([
      fs.resolve(cwd, { signal: exec.signal }),
      fs.resolve(path, { cwd, signal: exec.signal })
    ]);
    if (!fs.contains(rootTarget, mutationTarget)) return undefined;
  } catch { return undefined; }
  return detectStoryMutation(exec.name, exec.arguments, cwd);
}

async function target(fs: StoryFileSystem, root: string, path: string, signal?: AbortSignal): Promise<FsTarget> {
  return fs.resolve(path, { cwd: root, ...(signal === undefined ? {} : { signal }) });
}

async function exists(fs: StoryFileSystem, root: string, path: string, signal?: AbortSignal): Promise<boolean> {
  return target(fs, root, path, signal)
    .then((value) => fs.stat(value, signal))
    .then((info) => info !== undefined, () => false);
}

async function hasChapterOutline(fs: StoryFileSystem, root: string, chapter: number, signal?: AbortSignal): Promise<boolean> {
  const entries = await target(fs, root, "大纲", signal)
    .then((directory) => fs.listDir(directory, signal))
    .catch(() => []);
  return entries.some((entry) => entry.type === "file"
    && Number(/^细纲_第0*(\d+)章.*\.md$/u.exec(entry.name)?.[1]) === chapter);
}

export async function validateStoryMutation(
  fs: StoryFileSystem,
  mutation: StoryMutation,
  signal?: AbortSignal
): Promise<string | undefined> {
  const hasLongFormLayout = await exists(fs, mutation.root, "大纲", signal)
    || await exists(fs, mutation.root, "追踪", signal);
  if (!hasLongFormLayout) return undefined;
  if (!(await exists(fs, mutation.root, "追踪/_tracking-state.json", signal))) {
    // Setup/import must be able to bootstrap an existing manuscript before the
    // canonical Tracking file exists. The Skill remains responsible for
    // creating it; hard guards begin once the project has committed Tracking.
    return undefined;
  }
  if (mutation.chapter !== undefined && !(await hasChapterOutline(fs, mutation.root, mutation.chapter, signal))) {
    return `Oh Story 阻止写入第 ${String(mutation.chapter)} 章：未找到对应的 大纲/细纲_第XXX章*.md。请先完成细纲。`;
  }
  return undefined;
}

export async function decideStoryMutation(
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>
): Promise<PreToolDecision> {
  const fs = exec.agent?.ctx.get("fs");
  if (fs === undefined) return next();
  const mutation = await storyMutation(exec, fs);
  if (mutation === undefined) return next();
  const reason = await validateStoryMutation(fs, mutation, exec.signal);
  if (reason !== undefined) return { kind: "deny", reason };
  return next();
}

/**
 * Native DSH equivalents of the upstream prose guards. They join DSH's typed
 * tool waterfall, so decisions remain visible in the official approval/tool UI.
 */
export function registerOhStoryHooks(context: Context): void {
  context.on("tools/pre-execute", decideStoryMutation);

  context.on("tools/post-execute", async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next();
    if (result.isError || downstream.kind !== "accept") return downstream;
    const fs = exec.agent?.ctx.get("fs");
    const mutation = fs === undefined ? undefined : await storyMutation(exec, fs);
    if (mutation === undefined) return downstream;
    const reminder = createUserMessage({
      source: { kind: "plugin", plugin: "oh-story" },
      content: [{
        type: "text",
        text: `<oh-story-post-write>正文 ${mutation.path} 已变更。继续当前步骤前核对并更新 _tracking-state.json 及对应派生 Tracking 视图；不要把这条提醒当作用户的新写作要求。</oh-story-post-write>`
      }]
    });
    return {
      ...downstream,
      additionalContexts: [...downstream.additionalContexts ?? [], reminder]
    };
  });
}
