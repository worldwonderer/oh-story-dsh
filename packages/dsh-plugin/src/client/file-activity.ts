import type {
  ChatSnapshot,
  ConversationTimelineSnapshot,
  PartialAssistant,
  RunningToolCall,
  ToolCallBlock
} from "@deepseek-ai/dsh-client-runtime/client";
import type { AssistantChatData } from "@deepseek-ai/dsh-client-ui-conversation/client";

export type MutationToolName = "write" | "edit" | "str_replace_editor";

export interface FileMutationActivity {
  readonly callId: string;
  readonly name: MutationToolName;
  readonly argsRaw: string;
  readonly stage: "streaming" | "running";
  readonly path: string | undefined;
  readonly operation: "replace-file" | "replace-text" | "insert-text" | undefined;
  readonly oldText: string | undefined;
  readonly newText: string | undefined;
  readonly replaceAll: boolean;
}

interface JsonStringPrefix {
  readonly value: string;
  readonly complete: boolean;
}

export type WorkbenchMode = "story" | "drama";

const STORY_DIRECTORIES = new Set(["正文", "大纲", "设定", "追踪", "对标", "参考资料"]);
const DRAMA_DIRECTORIES = new Set(["输入", "项目开发", "设定集", "剧集", "交付", "创作者决策", "审查"]);
const EDITABLE_EXTENSION = /\.(?:md|txt|json|jsonl)$/iu;
const MUTATING_CALLS = new Set(["write", "edit", "str_replace_editor", "bash", "run_code", "oh_story_role"]);

/** Read the latest running Assistant step, including tool-only steps hidden from the Chat list. */
export function streamingAssistant(timeline: ConversationTimelineSnapshot): PartialAssistant | null {
  for (const turnNumber of timeline.turnOrder.toReversed()) {
    const turn = timeline.turns.get(turnNumber);
    if (turn === undefined) continue;
    for (const step of turn.steps.toReversed()) {
      const assistant: AssistantChatData | undefined = step.data.get("assistant-step");
      if (assistant?.status === "running") return assistant;
    }
  }
  return null;
}

function decodeEscape(character: string): string | undefined {
  switch (character) {
    case "\"": return "\"";
    case "\\": return "\\";
    case "/": return "/";
    case "b": return "\b";
    case "f": return "\f";
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    default: return undefined;
  }
}

/** Read a JSON string even while the model is still streaming its closing quote. */
export function jsonStringPrefix(raw: string, key: string): JsonStringPrefix | undefined {
  const match = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"\\s*:\\s*"`, "u").exec(raw);
  if (match === null) return undefined;
  let value = "";
  for (let index = match.index + match[0].length; index < raw.length; index += 1) {
    const character = raw[index] ?? "";
    if (character === "\"") return { value, complete: true };
    if (character !== "\\") { value += character; continue; }
    const escape = raw[index + 1];
    if (escape === undefined) return { value, complete: false };
    if (escape === "u") {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[\da-f]{4}$/iu.test(hex)) return { value, complete: false };
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    const decoded = decodeEscape(escape);
    if (decoded === undefined) return { value, complete: false };
    value += decoded;
    index += 1;
  }
  return { value, complete: false };
}

function completedString(raw: string, key: string): string | undefined {
  const value = jsonStringPrefix(raw, key);
  return value?.complete === true ? value.value : undefined;
}

function parsedArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function mutationFromArgs(name: string, callId: string, argsRaw: string, stage: FileMutationActivity["stage"]): FileMutationActivity | undefined {
  const complete = parsedArgs(argsRaw);
  if (name === "write") {
    return {
      callId, name, argsRaw, stage,
      path: jsonStringPrefix(argsRaw, "file_path")?.value,
      operation: "replace-file",
      oldText: undefined,
      newText: jsonStringPrefix(argsRaw, "content")?.value,
      replaceAll: false
    };
  }
  if (name === "edit") {
    return {
      callId, name, argsRaw, stage,
      path: jsonStringPrefix(argsRaw, "file_path")?.value,
      operation: "replace-text",
      oldText: completedString(argsRaw, "old_string"),
      newText: jsonStringPrefix(argsRaw, "new_string")?.value,
      replaceAll: complete?.replace_all === true
    };
  }
  if (name !== "str_replace_editor") return undefined;
  const command = completedString(argsRaw, "command");
  if (command === "view") return undefined;
  const path = jsonStringPrefix(argsRaw, "path")?.value;
  if (command === "create") {
    return {
      callId, name, argsRaw, stage, path,
      operation: "replace-file",
      oldText: undefined,
      newText: jsonStringPrefix(argsRaw, "file_text")?.value,
      replaceAll: false
    };
  }
  if (command === "str_replace") {
    return {
      callId, name, argsRaw, stage, path,
      operation: "replace-text",
      oldText: completedString(argsRaw, "old_str"),
      newText: jsonStringPrefix(argsRaw, "new_str")?.value ?? (complete !== undefined ? "" : undefined),
      replaceAll: complete?.replace_all === true
    };
  }
  if (command === "insert") {
    return {
      callId, name, argsRaw, stage, path,
      operation: "insert-text",
      oldText: undefined,
      newText: jsonStringPrefix(argsRaw, "new_str")?.value,
      replaceAll: false
    };
  }
  return { callId, name, argsRaw, stage, path, operation: undefined, oldText: undefined, newText: undefined, replaceAll: false };
}

function mutationsFromRunning(call: RunningToolCall): FileMutationActivity[] {
  const direct = mutationFromArgs(call.name, call.callId, call.argsRaw, "running");
  if (direct === undefined) return [];
  const view = call.callView;
  if (view?.card !== "diff" || view.diffs.length === 0) return [direct];
  return view.diffs.map((diff, index) => ({
    ...direct,
    callId: view.diffs.length === 1 ? call.callId : `${call.callId}:${String(index)}`,
    path: diff.path,
    operation: diff.oldText === null ? "replace-file" : "replace-text",
    oldText: diff.oldText ?? undefined,
    newText: diff.newText
  }));
}

function visitRunning(blocks: readonly ToolCallBlock[], visit: (call: RunningToolCall) => void): void {
  for (const block of blocks) {
    if (!("kind" in block)) visit(block);
    visitRunning(block.subCalls, visit);
  }
}

/** Return every active file mutation in official DSH dispatch order, including nested Code Mode calls. */
export function fileMutations(
  runningCalls: readonly RunningToolCall[],
  partial: PartialAssistant | null = null
): FileMutationActivity[] {
  const values: FileMutationActivity[] = [];
  visitRunning(runningCalls, (call) => { values.push(...mutationsFromRunning(call)); });
  for (const block of partial?.blocks ?? []) {
    if (block.kind !== "tool-call") continue;
    const value = mutationFromArgs(block.name, block.callId, block.argsRaw, "streaming");
    if (value !== undefined && !values.some((candidate) => candidate.callId === value.callId)) values.push(value);
  }
  return values;
}

/** Running calls whose settlement may have changed creative files. */
export function mutatingCallIds(runningCalls: readonly RunningToolCall[]): ReadonlySet<string> {
  const ids = new Set<string>();
  visitRunning(runningCalls, (call) => { if (MUTATING_CALLS.has(call.name)) ids.add(call.callId); });
  return ids;
}

function settledMutationSignals(block: ToolCallBlock): string[] {
  const nested = block.subCalls.flatMap(settledMutationSignals);
  if (!("kind" in block) || block.isError) return nested;
  const diffs = block.resultView?.card === "diff"
    ? block.resultView.diffs
    : block.callView?.card === "diff" ? block.callView.diffs : undefined;
  if (diffs !== undefined) return [
    ...diffs.map((diff, index) => `${block.callId}:${String(index)}\0${diff.path}`),
    ...nested
  ];
  if (block.call === null) return nested;
  const mutation = mutationFromArgs(block.call.name, block.callId, block.call.argsRaw, "running");
  return mutation?.path === undefined ? nested : [`${block.callId}\0${mutation.path}`, ...nested];
}

/** Latest durable successful mutation, used when a fast call skips the live render window. */
export function latestSettledMutation(chat: ChatSnapshot): string | undefined {
  for (const key of chat.order.toReversed()) {
    const node = chat.nodes.get(key);
    if (node?.kind !== "tool-call") continue;
    const root = (node.data as { readonly root?: ToolCallBlock }).root;
    const signal = root === undefined ? undefined : settledMutationSignals(root).at(-1);
    if (signal !== undefined) return signal;
  }
  return undefined;
}

/** Convert a DSH tool path to the creative-relative path accepted by the narrow route. */
export function creativeRelativePath(path: string | undefined, cwd: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  const normalized = path.replaceAll("\\", "/");
  const root = cwd?.replaceAll("\\", "/").replace(/\/$/u, "");
  const insideRoot = root !== undefined && normalized.startsWith(`${root}/`);
  if ((normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized) || normalized.startsWith("file:")) && !insideRoot) return undefined;
  const relative = insideRoot ? normalized.slice(root.length + 1) : normalized.replace(/^\.\//u, "");
  const [directory] = relative.split("/", 1);
  const creative = directory !== undefined && (STORY_DIRECTORIES.has(directory) || DRAMA_DIRECTORIES.has(directory));
  if ((!creative && relative !== "short-drama.json") || !EDITABLE_EXTENSION.test(relative)) return undefined;
  if (relative.split("/").some((part) => part === ".." || part === "." || part === "")) return undefined;
  return relative;
}

export function workbenchModeForPath(path: string | undefined): WorkbenchMode | undefined {
  if (path === "short-drama.json") return "drama";
  const directory = path?.split("/", 1)[0];
  if (directory !== undefined && STORY_DIRECTORIES.has(directory)) return "story";
  if (directory !== undefined && DRAMA_DIRECTORIES.has(directory)) return "drama";
  return undefined;
}

/** Project one streamed mutation over its immediate predecessor. */
export function previewMutation(activity: FileMutationActivity, base: string): string | undefined {
  if (activity.operation === "replace-file") return activity.newText;
  if (activity.operation === "replace-text") {
    if (activity.oldText === undefined || activity.newText === undefined || activity.oldText === "") return undefined;
    if (activity.replaceAll) return base.includes(activity.oldText) ? base.split(activity.oldText).join(activity.newText) : undefined;
    const at = base.indexOf(activity.oldText);
    return at < 0 ? undefined : `${base.slice(0, at)}${activity.newText}${base.slice(at + activity.oldText.length)}`;
  }
  if (activity.operation === "insert-text") {
    if (activity.newText === undefined) return undefined;
    const rawLine = /"insert_line"\s*:\s*(\d+)/u.exec(activity.argsRaw)?.[1];
    if (rawLine === undefined) return undefined;
    const line = Number.parseInt(rawLine, 10);
    const parts = base.split("\n");
    const at = Math.max(0, Math.min(parts.length, line));
    parts.splice(at, 0, activity.newText);
    return parts.join("\n");
  }
  return undefined;
}
