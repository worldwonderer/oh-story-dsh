import { defineStore, type ClientContext, type PartialAssistant, type RunningToolCall } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { PropsRenderSlots, PropsRuntime, PropsStore } from "@deepseek-ai/dsh-client-ui-slots";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  creativeRelativePath,
  fileMutations,
  latestSettledMutation,
  mutatingCallIds,
  previewMutation,
  streamingAssistant,
  workbenchModeForPath,
  type WorkbenchMode
} from "./file-activity.js";
import { buildFileTree, type FileTreeNode } from "./file-tree.js";
import { JsonlPreview } from "./jsonl-preview.js";
import { MarkdownPreview } from "./markdown-preview.js";
import styles from "./plugin.css?inline";

export const name = "oh-story";
export const inject = ["slots"];

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "oh-story.workspace": { kind: "single"; scope: "session" };
  }
}

interface WorkspaceFile { readonly path: string; readonly bytes: number; readonly version: string }
interface WorkspacePayload {
  readonly cwd: string;
  readonly files: readonly WorkspaceFile[];
  readonly shortDrama: Record<string, unknown> | null;
  readonly metadataErrors: readonly string[];
  readonly mode: "dsh-session";
}
interface FilePayload {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly version: string;
}
interface FileBuffer {
  readonly content: string;
  readonly saved: string;
  readonly source: "disk" | "human" | "agent";
  readonly version: string;
  readonly saving?: boolean | undefined;
  readonly error?: string | undefined;
  readonly missing?: boolean | undefined;
  readonly conflict?: {
    readonly message: string;
    readonly theirs?: string | undefined;
    readonly theirsVersion?: string | undefined;
  } | undefined;
}

interface WorkbenchMemory {
  buffers: Record<string, FileBuffer>;
  editorMode: "preview" | "source";
  expanded: Record<string, boolean>;
  selected: string | undefined;
  workbench: WorkbenchMode;
}

type Update<T> = T | ((current: T) => T);

function applyUpdate<T>(current: T, update: Update<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

function createWorkbenchStore() {
  return defineStore({
    init: (): WorkbenchMemory => ({
      buffers: {},
      editorMode: "preview",
      expanded: {},
      selected: undefined,
      workbench: "story"
    }),
    actions: {
      setBuffers: (draft, update: Update<Record<string, FileBuffer>>) => {
        draft.buffers = applyUpdate(draft.buffers, update);
      },
      setEditorMode: (draft, update: Update<WorkbenchMemory["editorMode"]>) => {
        draft.editorMode = applyUpdate(draft.editorMode, update);
      },
      setExpanded: (draft, update: Update<Record<string, boolean>>) => {
        draft.expanded = applyUpdate(draft.expanded, update);
      },
      setSelected: (draft, update: Update<string | undefined>) => {
        draft.selected = applyUpdate(draft.selected, update);
      },
      setWorkbench: (draft, update: Update<WorkbenchMode>) => {
        draft.workbench = applyUpdate(draft.workbench, update);
      }
    }
  });
}

class WorkspaceRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const GROUP_ORDER: Readonly<Record<WorkbenchMode, readonly string[]>> = {
  story: ["正文", "大纲", "设定", "追踪", "对标", "参考资料"],
  drama: ["项目", "输入", "项目开发", "设定集", "剧集", "审查", "创作者决策", "交付"]
};

const WORKBENCH_MODES = ["story", "drama"] as const;
const EDITOR_MODES = ["preview", "source"] as const;

function handleTabKey<T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  values: readonly T[],
  current: T,
  select: (value: T) => void
): void {
  let index: number | undefined;
  if (event.key === "Home") index = 0;
  else if (event.key === "End") index = values.length - 1;
  else if (event.key === "ArrowRight") index = (values.indexOf(current) + 1) % values.length;
  else if (event.key === "ArrowLeft") index = (values.indexOf(current) - 1 + values.length) % values.length;
  if (index === undefined) return;
  event.preventDefault();
  const value = values[index];
  if (value === undefined) return;
  select(value);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[index]?.focus();
}

function groupForPath(path: string): string {
  return path === "short-drama.json" ? "项目" : path.split("/", 1)[0] ?? "其他";
}

function preferredFile(files: readonly WorkspaceFile[], mode: WorkbenchMode): string | undefined {
  const matching = files.filter((file) => workbenchModeForPath(file.path) === mode);
  const preferences = mode === "story"
    ? [/^正文\/.*\.md$/u, /^大纲\/.*\.md$/u, /\.md$/u]
    : [/^剧集\/EP0*1\/screenplay\.md$/iu, /^剧集\/.*\/screenplay\.md$/iu, /^项目开发\/creative-brief\.md$/u, /^输入\/.*\.md$/u, /\.md$/u, /^short-drama\.json$/u];
  for (const pattern of preferences) {
    const match = matching.find((file) => pattern.test(file.path));
    if (match !== undefined) return match.path;
  }
  return matching[0]?.path;
}

function endpoint(path: string, sessionId: string, file?: string): string {
  const url = new URL(`/oh-story/${path}`, globalThis.location.origin);
  url.searchParams.set("sessionId", sessionId);
  if (file !== undefined) url.searchParams.set("path", file);
  return url.toString();
}

async function json<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { readonly error?: string };
  if (!response.ok) throw new WorkspaceRequestError(response.status, value.error ?? `HTTP ${String(response.status)}`);
  return value;
}

function FileTreeNodes({
  nodes,
  depth,
  expanded,
  selected,
  activityPath,
  onToggle,
  onSelect
}: {
  readonly nodes: readonly FileTreeNode[];
  readonly depth: number;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly selected: string | undefined;
  readonly activityPath: string | undefined;
  readonly onToggle: (path: string, open: boolean) => void;
  readonly onSelect: (path: string) => void;
}) {
  return <>{nodes.map((node) => {
    if (node.kind === "file") return <button
      type="button"
      key={node.path}
      style={{ "--oh-story-indent": `${String(depth * 14)}px` } as CSSProperties}
      title={node.path}
      aria-label={node.path}
      data-file-path={node.path}
      data-agent-target={node.path === activityPath || undefined}
      aria-current={node.path === selected ? "page" : undefined}
      onClick={() => { onSelect(node.path); }}
    >{node.name}</button>;
    const open = selected?.startsWith(`${node.path}/`) === true || expanded[node.path] === true;
    return <details className="oh-story-file-folder" key={node.path} open={open} onToggle={(event) => { onToggle(node.path, event.currentTarget.open); }}>
      <summary style={{ "--oh-story-indent": `${String(depth * 14)}px` } as CSSProperties} title={node.path}>{node.name}<span>{node.fileCount}</span></summary>
      <FileTreeNodes
        nodes={node.children}
        depth={depth + 1}
        expanded={expanded}
        selected={selected}
        activityPath={activityPath}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    </details>;
  })}</>;
}

function useWorkspace(sessionId: string): {
  readonly workspace: WorkspacePayload | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly reload: () => void;
} {
  const [version, setVersion] = useState(0);
  const [workspace, setWorkspace] = useState<WorkspacePayload>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void fetch(endpoint("workspace", sessionId), { signal: controller.signal })
      .then((response) => json<WorkspacePayload>(response))
      .then(setWorkspace)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [sessionId, version]);
  return { workspace, error, loading, reload };
}

function CreativeWorkbench({
  sessionId,
  runningCalls,
  partial,
  settledMutation,
  useStore,
  actions
}: {
  readonly sessionId: string;
  readonly runningCalls: readonly RunningToolCall[];
  readonly partial: PartialAssistant | null;
  readonly settledMutation: string | undefined;
} & Pick<WorkbenchSlotProps, "useStore" | "actions">) {
  const { workspace, error, loading: workspaceLoading, reload } = useWorkspace(sessionId);
  const activities = useMemo(
    () => fileMutations(runningCalls, partial),
    [partial, runningCalls]
  );
  const normalizedActivities = useMemo(() => activities.flatMap((activity) => {
    const path = creativeRelativePath(activity.path, workspace?.cwd);
    return path === undefined ? [] : [{ activity, path }];
  }), [activities, workspace?.cwd]);
  const primaryActivity = normalizedActivities.at(-1);
  const activityPaths = useMemo(() => new Set(normalizedActivities.map((value) => value.path)), [normalizedActivities]);
  const activity = primaryActivity?.activity;
  const activityPath = primaryActivity?.path;
  const workbench = useStore((memory) => memory.workbench);
  const setWorkbench = actions.setWorkbench;
  const initializedWorkbench = useRef(false);
  const selected = useStore((memory) => memory.selected);
  const setSelected = actions.setSelected;
  const buffers = useStore((memory) => memory.buffers);
  const setBuffers = actions.setBuffers;
  const buffersRef = useRef<Record<string, FileBuffer>>({});
  const expanded = useStore((memory) => memory.expanded);
  const setExpanded = actions.setExpanded;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const activityBases = useRef(new Map<string, { readonly path: string; readonly base: string }>());
  const previousSignals = useRef<ReadonlySet<string>>(new Set());
  const previousSettledMutation = useRef(settledMutation);
  const saveLocks = useRef(new Set<string>());
  const buffer = selected === undefined ? undefined : buffers[selected];
  const dirty = buffer?.source === "human" && buffer.content !== buffer.saved;
  const saving = buffer?.saving === true;
  const fileError = buffer?.error;
  const conflict = buffer?.conflict;
  const selectedLower = selected?.toLocaleLowerCase();
  const markdown = selectedLower?.endsWith(".md") === true;
  const jsonl = selectedLower?.endsWith(".jsonl") === true;
  const structured = jsonl || selectedLower?.endsWith(".json") === true;
  const previewable = markdown || jsonl;
  const editorMode = useStore((memory) => memory.editorMode);
  const setEditorMode = actions.setEditorMode;
  const modeSelection = useRef(selected);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorPositions = useRef(new Map<string, { readonly scrollTop: number; readonly selectionStart: number; readonly selectionEnd: number }>());
  const editorReady = buffer !== undefined && buffer.missing !== true;
  const availableModes = useMemo(() => {
    const value = new Set<WorkbenchMode>();
    for (const file of workspace?.files ?? []) {
      const mode = workbenchModeForPath(file.path);
      if (mode !== undefined) value.add(mode);
    }
    return WORKBENCH_MODES.filter((mode) => value.has(mode));
  }, [workspace?.files]);
  const showModeTabs = workspace !== undefined && availableModes.length !== 1;
  const workspaceKind = availableModes.length === 1 ? availableModes[0] : undefined;

  useEffect(() => { buffersRef.current = buffers; }, [buffers]);

  const rememberEditorPosition = useCallback((): void => {
    const element = textareaRef.current;
    if (element === null || selected === undefined || element.getAttribute("aria-label") !== selected) return;
    editorPositions.current.set(selected, {
      scrollTop: element.scrollTop,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd
    });
  }, [selected]);

  useLayoutEffect(() => {
    if (editorMode !== "source" || selected === undefined || !editorReady) return;
    const element = textareaRef.current;
    const position = editorPositions.current.get(selected);
    if (element === null || position === undefined) return;
    const end = Math.min(position.selectionEnd, element.value.length);
    element.setSelectionRange(Math.min(position.selectionStart, end), end);
    element.scrollTop = position.scrollTop;
  }, [editorMode, editorReady, selected]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (!Object.values(buffersRef.current).some((value) => value.source === "human" && value.content !== value.saved)) return;
      event.preventDefault();
    };
    globalThis.addEventListener("beforeunload", warn);
    return () => { globalThis.removeEventListener("beforeunload", warn); };
  }, []);

  const expandPath = useCallback((path: string): void => {
    const segments = path.split("/");
    const ancestors = [groupForPath(path)];
    for (let index = 1; index < segments.length - 1; index += 1) ancestors.push(segments.slice(0, index + 1).join("/"));
    setExpanded((current) => {
      const next = { ...current };
      for (const ancestor of ancestors) next[ancestor] = true;
      return next;
    });
  }, []);

  const revealPath = useCallback((path: string): void => {
    rememberEditorPosition();
    setWorkbench(workbenchModeForPath(path) ?? "story");
    setSelected(path);
    expandPath(path);
  }, [expandPath, rememberEditorPosition]);

  const followAgentPath = useCallback((path: string): void => {
    expandPath(path);
    const current = selected === undefined ? undefined : buffersRef.current[selected];
    const preserveFocusedDraft = path !== selected
      && current?.source === "human"
      && current.content !== current.saved
      && surfaceRef.current?.ownerDocument.activeElement === textareaRef.current;
    if (preserveFocusedDraft) return;
    revealPath(path);
  }, [expandPath, revealPath, selected]);

  useEffect(() => {
    if (workspace === undefined || initializedWorkbench.current) return;
    if (availableModes.length === 1) setWorkbench(availableModes[0] ?? "story");
    initializedWorkbench.current = true;
  }, [availableModes, workspace]);

  useEffect(() => {
    if (activityPath !== undefined && activityPath === selected) setEditorMode("source");
  }, [activityPath, selected]);

  useEffect(() => {
    if (modeSelection.current === selected) return;
    modeSelection.current = selected;
    setEditorMode(activityPath === selected ? "source" : previewable ? "preview" : "source");
  }, [activityPath, previewable, selected]);

  useEffect(() => {
    if (workspaceLoading) return;
    if (activityPath !== undefined) return;
    if (selected !== undefined && (
      (workspace?.files.some((file) => file.path === selected) ?? false)
      || buffers[selected] !== undefined
    ) && workbenchModeForPath(selected) === workbench) return;
    setSelected(workspace === undefined ? undefined : preferredFile(workspace.files, workbench));
  }, [activityPath, buffers, selected, workbench, workspace, workspaceLoading]);

  useEffect(() => {
    if (workspace === undefined || workspaceLoading) return;
    const paths = new Set(workspace.files.map((file) => file.path));
    setBuffers((current) => {
      let changed = false;
      const next = { ...current };
      for (const [path, value] of Object.entries(current)) {
        if (paths.has(path) || activityPaths.has(path)) continue;
        if (value.source === "human" && value.content !== value.saved) {
          if (value.missing !== true) {
            next[path] = { ...value, missing: true, error: "文件已从 workspace 移除。本地草稿仍保留，可复制后放弃草稿。" };
            changed = true;
          }
        } else {
          delete next[path];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activityPaths, workspace, workspaceLoading]);

  useEffect(() => {
    if (selected === undefined || activityPaths.has(selected)) return;
    if (!(workspace?.files.some((file) => file.path === selected) ?? false)) return;
    const controller = new AbortController();
    setBuffers((current) => {
      const existing = current[selected];
      return existing === undefined ? current : { ...current, [selected]: { ...existing, error: undefined } };
    });
    void fetch(endpoint("file", sessionId, selected), { signal: controller.signal })
      .then((response) => json<FilePayload>(response))
      .then((file) => {
        setBuffers((current) => {
          const existing = current[file.path];
          if (existing?.source === "human" && existing.content !== existing.saved) {
            if (existing.version === file.version) return { ...current, [file.path]: { ...existing, missing: false, error: undefined } };
            return {
              ...current,
              [file.path]: {
                ...existing,
                missing: false,
                error: undefined,
                conflict: {
                  message: `${file.path} 已在磁盘上更新；你的本地草稿没有被覆盖。`,
                  theirs: file.content,
                  theirsVersion: file.version
                }
              }
            };
          }
          return {
            ...current,
            [file.path]: { content: file.content, saved: file.content, source: "disk", version: file.version }
          };
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setBuffers((current) => {
          const existing = current[selected];
          return existing === undefined ? current : {
            ...current,
            [selected]: { ...existing, error: reason instanceof Error ? reason.message : String(reason) }
          };
        });
      });
    return () => { controller.abort(); };
  }, [activityPaths, selected, sessionId, workspace?.files]);

  useEffect(() => {
    if (normalizedActivities.length === 0) return;
    for (const { path } of normalizedActivities) expandPath(path);
    if (activityPath !== undefined) followAgentPath(activityPath);
    setBuffers((current) => {
      let next = current;
      for (const { activity: currentActivity, path } of normalizedActivities) {
        const existing = next[path];
        if (existing?.source === "human" && existing.content !== existing.saved) {
          next = {
            ...next,
            [path]: {
              ...existing,
              conflict: { message: `${path} 正由 Agent 修改；你的本地草稿已锁定，不会被覆盖。` }
            }
          };
          continue;
        }
        let basis = activityBases.current.get(currentActivity.callId);
        if (basis === undefined || basis.path !== path) {
          basis = { path, base: existing?.content ?? "" };
          activityBases.current.set(currentActivity.callId, basis);
        }
        const preview = previewMutation(currentActivity, basis.base);
        if (preview === undefined || (existing?.source === "agent" && existing.content === preview)) continue;
        next = {
          ...next,
          [path]: {
            content: preview,
            saved: existing?.saved ?? "",
            source: "agent",
            version: existing?.version ?? ""
          }
        };
      }
      return next;
    });
  }, [activityPath, expandPath, followAgentPath, normalizedActivities]);

  useEffect(() => {
    const signals = new Set(mutatingCallIds(runningCalls));
    for (const { activity: currentActivity } of normalizedActivities) signals.add(currentActivity.callId.split(":", 1)[0] ?? currentActivity.callId);
    const settled = [...previousSignals.current].some((callId) => !signals.has(callId));
    for (const callId of activityBases.current.keys()) {
      if (!signals.has(callId.split(":", 1)[0] ?? callId)) activityBases.current.delete(callId);
    }
    previousSignals.current = signals;
    if (!settled) return;
    reload();
  }, [normalizedActivities, reload, runningCalls]);

  useEffect(() => {
    if (settledMutation === undefined || settledMutation === previousSettledMutation.current) return;
    previousSettledMutation.current = settledMutation;
    const path = creativeRelativePath(settledMutation.slice(settledMutation.indexOf("\0") + 1), workspace?.cwd);
    if (path !== undefined) followAgentPath(path);
    reload();
  }, [followAgentPath, reload, settledMutation, workspace?.cwd]);

  useEffect(() => {
    if (selected === undefined) return;
    for (const button of navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-file-path]") ?? []) {
      if (button.dataset.filePath === selected) {
        button.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }, [selected]);

  useEffect(() => {
    if (normalizedActivities.length > 0 || workspace === undefined) return;
    const sessionSurface = surfaceRef.current?.parentElement;
    if (sessionSurface === undefined || sessionSurface === null) return;
    const knownPaths = new Set(workspace.files.map((file) => file.path));
    const followOfficialFileLink = (event: MouseEvent): void => {
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const control = origin.closest<HTMLElement>("button, a");
      if (control === null || control.closest(".oh-story-split-surface") !== null) return;
      const candidates = [control.title, control.getAttribute("aria-label"), control.textContent];
      for (const candidate of candidates) {
        const path = creativeRelativePath(candidate?.trim().replace(/^(?:Open|打开)\s+/u, ""), workspace.cwd);
        if (path === undefined || !knownPaths.has(path)) continue;
        event.preventDefault();
        event.stopPropagation();
        revealPath(path);
        break;
      }
    };
    sessionSurface.addEventListener("click", followOfficialFileLink, true);
    return () => { sessionSurface.removeEventListener("click", followOfficialFileLink, true); };
  }, [normalizedActivities.length, revealPath, workspace]);

  const savePath = useCallback(async (path: string) => {
    if (saveLocks.current.has(path)) return;
    const submitted = buffersRef.current[path];
    if (submitted === undefined || submitted.missing === true || submitted.content === submitted.saved) return;
    saveLocks.current.add(path);
    setBuffers((current) => {
      const existing = current[path];
      return existing === undefined ? current : { ...current, [path]: { ...existing, saving: true, error: undefined } };
    });
    try {
      const file = await json<FilePayload>(await fetch(endpoint("file", sessionId, path), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: submitted.content, baseVersion: submitted.version })
      }));
      setBuffers((current) => {
        const latest = current[path];
        if (latest === undefined) return current;
        const unchanged = latest.content === submitted.content;
        return {
          ...current,
          [path]: {
            content: unchanged ? file.content : latest.content,
            saved: file.content,
            source: unchanged ? "disk" : "human",
            version: file.version,
            saving: false
          }
        };
      });
      reload();
    } catch (reason) {
      if (reason instanceof WorkspaceRequestError && reason.status === 412) {
        try {
          const theirs = await json<FilePayload>(await fetch(endpoint("file", sessionId, path)));
          setBuffers((current) => {
            const latest = current[path];
            if (latest === undefined) return current;
            return {
              ...current,
              [path]: {
                ...latest,
                saving: false,
                conflict: {
                  message: `${path} 已在磁盘上更新；请选择保留哪一版。`,
                  theirs: theirs.content,
                  theirsVersion: theirs.version
                }
              }
            };
          });
        } catch (refreshError) {
          setBuffers((current) => {
            const existing = current[path];
            return existing === undefined ? current : {
              ...current,
              [path]: { ...existing, saving: false, error: refreshError instanceof Error ? refreshError.message : String(refreshError) }
            };
          });
        }
      } else {
        setBuffers((current) => {
          const existing = current[path];
          return existing === undefined ? current : {
            ...current,
            [path]: { ...existing, saving: false, error: reason instanceof Error ? reason.message : String(reason) }
          };
        });
      }
    } finally {
      saveLocks.current.delete(path);
    }
  }, [reload, sessionId]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault();
      if (selected !== undefined) void savePath(selected);
    };
    globalThis.addEventListener("keydown", saveShortcut);
    return () => { globalThis.removeEventListener("keydown", saveShortcut); };
  }, [savePath, selected]);

  const groups = useMemo(() => {
    const value = new Map<string, WorkspaceFile[]>();
    const all = [...(workspace?.files ?? [])].filter((file) => workbenchModeForPath(file.path) === workbench);
    if (activityPath !== undefined && !all.some((file) => file.path === activityPath)) all.push({ path: activityPath, bytes: 0, version: "" });
    all.sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
    for (const file of all) {
      const directory = groupForPath(file.path);
      const files = value.get(directory) ?? [];
      files.push(file);
      value.set(directory, files);
    }
    const order = GROUP_ORDER[workbench];
    return [...value.entries()].sort(([left], [right]) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex)
        || left.localeCompare(right, "zh-Hans-CN");
    });
  }, [activityPath, workbench, workspace]);

  const selectWorkbench = (next: WorkbenchMode): void => {
    setWorkbench(next);
    const target = workspace === undefined ? undefined : preferredFile(workspace.files, next);
    if (target === undefined) setSelected(undefined);
    else revealPath(target);
  };
  const selectEditorMode = (next: WorkbenchMemory["editorMode"]): void => {
    if (next === "preview") rememberEditorPosition();
    setEditorMode(next);
  };
  const selectedLabel = selected ?? `在当前 DSH workspace 中选择${workbench === "story" ? "小说" : "短剧"}文件`;
  const selectedBasename = selected?.split("/").at(-1) ?? selectedLabel;
  const selectedGroup = selected === undefined ? undefined : groupForPath(selected);
  const toggleGroup = (key: string, open: boolean): void => {
    setExpanded((current) => ({ ...current, [key]: open }));
  };
  const resolveConflict = (keepLocal: boolean): void => {
    if (selected === undefined || conflict?.theirs === undefined || conflict.theirsVersion === undefined) return;
    const theirs = conflict.theirs;
    const theirsVersion = conflict.theirsVersion;
    setBuffers((current) => {
      const existing = current[selected];
      if (existing === undefined) return current;
      return {
        ...current,
        [selected]: keepLocal
          ? { ...existing, saved: theirs, version: theirsVersion, source: "human", conflict: undefined }
          : { content: theirs, saved: theirs, source: "disk", version: theirsVersion }
      };
    });
  };

  return <div ref={surfaceRef} className="oh-story-split-surface">
    <style>{styles}</style>
    <aside className="oh-story-tree">
      <div className="oh-story-brand">
        <span className="oh-story-brand-cluster"><strong>✦ <span>Oh Story</span></strong>{workspaceKind !== undefined && <span className="oh-story-kind">{workspaceKind === "story" ? "小说" : "短剧"}</span>}</span>
        <button type="button" onClick={reload} title="刷新" aria-label="刷新项目文件">↻</button>
      </div>
      {showModeTabs && <div className="oh-story-mode-tabs" role="tablist" aria-label="创作工作台">
        {WORKBENCH_MODES.map((mode) => <button
          type="button"
          role="tab"
          key={mode}
          tabIndex={workbench === mode ? 0 : -1}
          aria-selected={workbench === mode}
          onKeyDown={(event) => { handleTabKey(event, WORKBENCH_MODES, workbench, selectWorkbench); }}
          onClick={() => { selectWorkbench(mode); }}
        >{mode === "story" ? "小说" : "短剧"}</button>)}
      </div>}
      {error !== undefined && <div className="oh-story-error">{error}</div>}
      {workspace?.metadataErrors.map((message) => <div className="oh-story-warning" key={message}>{message}</div>)}
      <nav ref={navRef} aria-label={workbench === "story" ? "小说项目文件" : "短剧项目文件"}>
        {groups.map(([directory, files]) => {
          const groupOpen = selectedGroup === directory || expanded[directory] === true;
          return <details className="oh-story-file-group" key={directory} open={groupOpen} onToggle={(event) => { toggleGroup(directory, event.currentTarget.open); }}>
            <summary>{directory}<span>{files.length}</span></summary>
            <FileTreeNodes
              nodes={buildFileTree(files, directory)}
              depth={1}
              expanded={expanded}
              selected={selected}
              activityPath={activityPath}
              onToggle={toggleGroup}
              onSelect={revealPath}
            />
          </details>;
        })}
      </nav>
    </aside>
    <main className="oh-story-editor">
      <header>
        <span className="oh-story-editor-path" title={selected}><span>{selectedLabel}</span><strong>{selectedBasename}</strong></span>
        <div className="oh-story-editor-actions">
          {previewable && <div className="oh-story-editor-tabs" role="tablist" aria-label={markdown ? "Markdown 查看方式" : "JSONL 查看方式"}>
            {EDITOR_MODES.map((mode) => <button
              type="button"
              role="tab"
              key={mode}
              tabIndex={editorMode === mode ? 0 : -1}
              aria-selected={editorMode === mode}
              onKeyDown={(event) => { handleTabKey(event, EDITOR_MODES, editorMode, selectEditorMode); }}
              onClick={() => { selectEditorMode(mode); }}
            >{mode === "preview" ? "预览" : "源码"}</button>)}
          </div>}
          {(dirty || saving) && selected !== undefined && <button className="oh-story-save" type="button" disabled={saving || buffer?.missing === true} onClick={() => { void savePath(selected); }}>
            {saving ? "保存中…" : "保存"}
          </button>}
        </div>
      </header>
      {activity !== undefined && activityPath !== undefined && activityPath === selected && <div className="oh-story-stream" data-stage={activity.stage} role="status" aria-live="polite">● {activity.stage === "running" ? "Agent 正在应用修改" : "Agent 正在生成文件内容"}</div>}
      {conflict !== undefined && <div className="oh-story-conflict" role="alert">
        <span>{conflict.message}</span>
        {conflict.theirs !== undefined && conflict.theirsVersion !== undefined && selected !== undefined && <div>
          <button type="button" onClick={() => { resolveConflict(false); }}>载入磁盘版本</button>
          <button type="button" onClick={() => { resolveConflict(true); }}>保留本地草稿</button>
        </div>}
      </div>}
      {fileError !== undefined && <div className="oh-story-error">{fileError}</div>}
      {selected === undefined
        ? <div className="oh-story-empty">{workbench === "story"
            ? <>当前 workspace 还没有小说文件。可在右侧 Chat 中运行 <code>/story-setup</code>。</>
            : <>当前 workspace 还没有短剧项目。可在右侧 Chat 中运行 <code>/short-drama</code>。</>}</div>
        : buffer === undefined
          ? <div className="oh-story-empty">正在加载 {selected}…</div>
        : buffer.missing === true
          ? <div className="oh-story-empty">文件已从 workspace 移除，本地草稿仍保留。请先复制需要的内容，再放弃草稿。<button type="button" onClick={() => {
            setBuffers((current) => {
              const next = { ...current };
              delete next[selected];
              return next;
            });
            setSelected(workspace === undefined ? undefined : preferredFile(workspace.files, workbench));
          }}>放弃本地草稿</button></div>
        : previewable && editorMode === "preview"
          ? markdown
            ? <MarkdownPreview content={buffer.content} label={selected} />
            : <JsonlPreview content={buffer.content} label={selected} />
          : <textarea
            ref={textareaRef}
            value={buffer.content}
            data-format={structured ? "structured" : "prose"}
            onBlur={rememberEditorPosition}
            onScroll={rememberEditorPosition}
            onSelect={rememberEditorPosition}
            onChange={(event) => {
              const content = event.target.value;
              setBuffers((current) => ({
                ...current,
                [selected]: {
                  content,
                  saved: current[selected]?.saved ?? "",
                  source: "human",
                  version: current[selected]?.version ?? "",
                  conflict: current[selected]?.conflict,
                  saving: current[selected]?.saving
                }
              }));
            }}
            spellCheck={!structured}
            aria-label={selected}
          />}
    </main>
  </div>;
}

type WorkbenchSlotProps = PropsRuntime<"oh-story.workspace"> & PropsStore<ReturnType<typeof createWorkbenchStore>>;

/** Mount beside the official conversation without replacing Chat or Composer. */
function CreativeSplitBridge({ sessionId, useSession, useStore, actions }: WorkbenchSlotProps) {
  const marker = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement>();
  const runningCalls = useSession((snapshot) => snapshot.runningCalls);
  const partial = useSession((snapshot) => streamingAssistant(snapshot.chat.timeline));
  const settledMutation = useSession((snapshot) => latestSettledMutation(snapshot.chat));
  useLayoutEffect(() => {
    const document = marker.current?.ownerDocument;
    if (document === undefined) return;
    const locate = (): void => {
      const anchor = document.querySelector<HTMLElement>("[data-conversation-scroll] > [data-slot='conversation.session']");
      setTarget((current) => current === anchor ? current : anchor ?? undefined);
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); };
  }, [sessionId]);
  useLayoutEffect(() => {
    const scroller = target?.parentElement;
    if (scroller === undefined || scroller === null) return;
    const publishLayout = (): void => {
      scroller.style.setProperty("--oh-story-scroll-height", `${String(scroller.clientHeight)}px`);
      const layout = scroller.clientWidth < 620 ? "compact" : scroller.clientWidth < 900 ? "medium" : "wide";
      if (scroller.dataset.ohStoryLayout !== layout) scroller.dataset.ohStoryLayout = layout;
    };
    publishLayout();
    const observer = new ResizeObserver(publishLayout);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      scroller.style.removeProperty("--oh-story-scroll-height");
      delete scroller.dataset.ohStoryLayout;
    };
  }, [target]);
  return <>
    <span ref={marker} className="oh-story-bridge-marker" aria-hidden />
    {target === undefined ? null : createPortal(<CreativeWorkbench
      sessionId={sessionId}
      runningCalls={runningCalls}
      partial={partial}
      settledMutation={settledMutation}
      useStore={useStore}
      actions={actions}
    />, target)}
  </>;
}

type WorkbenchSeatProps = PropsRuntime<"shell.overlay"> & PropsRenderSlots<"oh-story.workspace">;

function WorkbenchSeat({ SessionProvider, renderSlot }: WorkbenchSeatProps) {
  return <SessionProvider>{() => renderSlot("oh-story.workspace", {})}</SessionProvider>;
}

function argsOf(block: ToolCallViewProps["block"]): Record<string, unknown> {
  const raw = ("kind" in block ? block.call?.argsRaw : block.argsRaw) ?? "{}";
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function resultOf(block: ToolCallViewProps["block"]): string | undefined {
  if (!("kind" in block)) return undefined;
  return block.content.map((item) => item.type === "text" ? item.text : JSON.stringify(item, null, 2)).join("\n");
}

function RoleToolView({ block, inspect }: ToolCallViewProps) {
  const args = argsOf(block);
  const role = typeof args.role === "string" ? args.role : "story-role";
  const output = resultOf(block);
  const state = !("kind" in block) ? "running" : block.isError ? "error" : "done";
  return <details className="oh-story-role" data-state={state}>
    <style>{styles}</style>
    <summary><span>✦ Role</span><strong>{role}</strong><em>{state === "running" ? "运行中" : state === "error" ? "失败" : "完成"}</em></summary>
    {output !== undefined && <pre>{output}</pre>}
    {inspect !== undefined && <button type="button" onClick={inspect}>在轨迹中检查</button>}
  </details>;
}

/** Register only official DSH surfaces; the split bridge never replaces Chat. */
export function apply(context: ClientContext): void {
  context.slots.inject("shell.overlay", () => {
    const disposeSeat = context.slots.register({
      name: "shell.overlay",
      id: "oh-story-workspace",
      order: -100,
      children: { "oh-story.workspace": { kind: "single", scope: "session" } }
    }, WorkbenchSeat);
    const disposeWorkbench = context.slots.register({
      name: "oh-story.workspace",
      store: createWorkbenchStore
    }, CreativeSplitBridge);
    return [disposeSeat, disposeWorkbench];
  });
  context.slots.inject("tool.call.toolview", () => context.slots.register({
    name: "tool.call.toolview",
    key: "oh_story_role"
  }, RoleToolView));
}

export default { name, inject, apply };
