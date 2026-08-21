import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { FsError, type FileSystem, type FsInfo, type FsTarget, type FsVersion } from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { isTrustedWorkspaceRequest } from "./workspace-request-trust.js";

const STORY_DIRECTORIES = ["正文", "大纲", "设定", "追踪", "对标", "参考资料"] as const;
const DRAMA_DIRECTORIES = ["输入", "项目开发", "设定集", "剧集", "交付", "创作者决策", "审查"] as const;
const CREATIVE_DIRECTORIES = [...STORY_DIRECTORIES, ...DRAMA_DIRECTORIES] as const;
const ROOT_FILES = new Set(["short-drama.json"]);
const EDITABLE_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);
const FILE_LIMIT = 1_000;

interface WorkspaceRouteOptions {
  readonly maxBytes: number;
  readonly trustedHosts?: readonly string[];
}

interface WorkspaceFile {
  readonly path: string;
  readonly bytes: number;
  readonly version: string;
}

interface WorkspaceRealm {
  readonly agent: Agent;
  readonly fs: FileSystem;
  readonly sandboxPolicy: SandboxPolicyService;
  readonly cwd: string;
  readonly root: FsTarget;
}

interface ReadFileResult {
  readonly content: string;
  readonly bytes: number;
  readonly version: FsVersion;
}

class WorkspaceHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

async function jsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > maxBytes) throw new WorkspaceHttpError(413, "请求内容过大。");
    chunks.push(value);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new WorkspaceHttpError(400, "请求必须是 JSON 对象。");
  }
}

function assertCreativePath(path: string): void {
  if (!EDITABLE_EXTENSIONS.has(extname(path).toLocaleLowerCase())) {
    throw new WorkspaceHttpError(415, "工作台只编辑 Markdown、文本、JSON 和 JSONL 文件。");
  }
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WorkspaceHttpError(403, "文件路径不在创作工作台中。");
  }
  const root = path.split("/", 1)[0];
  if (!CREATIVE_DIRECTORIES.some((directory) => directory === root) && !ROOT_FILES.has(path)) {
    throw new WorkspaceHttpError(403, "文件路径不在创作工作台中。");
  }
}

async function workspaceRealm(context: Context, url: URL): Promise<WorkspaceRealm> {
  const rawId = url.searchParams.get("sessionId");
  if (rawId === null || rawId === "") throw new WorkspaceHttpError(400, "缺少 DSH sessionId。");
  const lookup = context.typert.lookups.get("agent");
  if (lookup === undefined) throw new WorkspaceHttpError(503, "DSH Agent lookup 当前不可用。");
  let agent: Agent | undefined;
  try {
    agent = await lookup.resolve(SessionId(rawId)) as Agent | undefined;
  } catch {
    throw new WorkspaceHttpError(404, "DSH 会话不可用。");
  }
  if (agent === undefined) throw new WorkspaceHttpError(404, "DSH 会话不可用。");
  if (agent.session.header.parentSession !== undefined || agent.session.header.origin === "subagent") {
    throw new WorkspaceHttpError(403, "子 Agent 会话不开放创作编辑器。");
  }
  const cwd = agent.session.header.cwd;
  if (cwd === undefined) throw new WorkspaceHttpError(409, "当前 DSH 会话没有工作目录。");
  const fs = agent.ctx.get("fs");
  const sandboxPolicy = agent.ctx.get("sandboxPolicy");
  if (fs === undefined || sandboxPolicy === undefined) throw new WorkspaceHttpError(503, "DSH 文件系统当前不可用。");
  return { agent, fs, sandboxPolicy, cwd, root: await fs.resolve(cwd) };
}

async function creativeTarget(realm: WorkspaceRealm, path: string): Promise<FsTarget> {
  assertCreativePath(path);
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "文件路径离开了 DSH 工作目录。");
  return target;
}

function requireRegularFile(info: FsInfo | undefined): FsInfo {
  if (info === undefined) throw new WorkspaceHttpError(404, "文件不存在。");
  if (info.type !== "file") throw new WorkspaceHttpError(415, "目标不是可编辑的普通文件。");
  return info;
}

/** Read bytes and a matching opaque version, retrying if a writer wins the read window. */
async function readVersionedFile(fs: FileSystem, target: FsTarget, maxBytes: number): Promise<ReadFileResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = requireRegularFile(await fs.stat(target));
    if (before.size !== undefined && before.size > maxBytes) throw new WorkspaceHttpError(413, "文件超过工作台大小限制。");
    const bytes = await fs.readBytes(target, undefined, maxBytes);
    const after = requireRegularFile(await fs.stat(target));
    if (before.version !== after.version) continue;
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new WorkspaceHttpError(415, "文件不是有效的 UTF-8 文本。");
    }
    return { content, bytes: bytes.byteLength, version: after.version };
  }
  throw new WorkspaceHttpError(409, "文件正在被修改，请重试。");
}

async function listFiles(realm: WorkspaceRealm): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  const walk = async (path: string, directory: FsTarget): Promise<void> => {
    for (const entry of await realm.fs.listDir(directory)) {
      if (entry.name.startsWith(".") || !realm.fs.contains(realm.root, entry.target)) continue;
      const childPath = `${path}/${entry.name}`;
      if (entry.type === "directory") await walk(childPath, entry.target);
      else if (entry.type === "file" && EDITABLE_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) {
        const info = entry.version === undefined || entry.size === undefined ? await realm.fs.stat(entry.target) : undefined;
        const version = entry.version ?? info?.version;
        if (version !== undefined) files.push({ path: childPath, bytes: entry.size ?? info?.size ?? 0, version });
      }
      if (files.length >= FILE_LIMIT) return;
    }
  };
  for (const directory of CREATIVE_DIRECTORIES) {
    const target = await realm.fs.resolve(directory, { cwd: realm.cwd });
    if (!realm.fs.contains(realm.root, target)) continue;
    const info = await realm.fs.stat(target);
    if (info?.type === "directory") await walk(directory, target);
    if (files.length >= FILE_LIMIT) break;
  }
  for (const path of ROOT_FILES) {
    const target = await creativeTarget(realm, path);
    const info = await realm.fs.stat(target);
    if (info?.type === "file") files.push({ path, bytes: info.size ?? 0, version: info.version });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
}

async function metadata(realm: WorkspaceRealm, files: readonly WorkspaceFile[], path: string, maxBytes: number): Promise<{ readonly value: unknown; readonly error?: string }> {
  if (!files.some((file) => file.path === path)) return { value: null };
  try {
    const target = await creativeTarget(realm, path);
    return { value: JSON.parse((await readVersionedFile(realm.fs, target, maxBytes)).content) as unknown };
  } catch (error) {
    return { value: null, error: error instanceof SyntaxError ? `${path} 不是有效的 JSON。` : `${path} 暂时无法读取。` };
  }
}

function mapFsError(error: unknown): WorkspaceHttpError | undefined {
  if (!(error instanceof FsError)) return undefined;
  switch (error.code) {
    case "FS_NOT_FOUND": return new WorkspaceHttpError(404, "文件不存在。");
    case "FS_TOO_LARGE": return new WorkspaceHttpError(413, "文件超过工作台大小限制。");
    case "FS_NOT_TEXT":
    case "FS_NOT_REGULAR_FILE": return new WorkspaceHttpError(415, "目标不是可编辑的文本文件。");
    case "FS_PERMISSION_DENIED":
    case "FS_SANDBOX_DENIED": return new WorkspaceHttpError(403, "当前 DSH 权限不允许修改该文件。");
    case "FS_STALE_VERSION":
    case "FS_NOT_OBSERVED": return new WorkspaceHttpError(412, "文件已在磁盘上更新。请处理冲突后再保存。");
    case "FS_ABORTED": return new WorkspaceHttpError(409, "文件操作已取消。");
    default: return new WorkspaceHttpError(500, "DSH 文件系统操作失败。");
  }
}

async function handle(context: Context, request: IncomingMessage, response: ServerResponse, options: WorkspaceRouteOptions): Promise<void> {
  try {
    if (!isTrustedWorkspaceRequest(request, options.trustedHosts ?? [])) throw new WorkspaceHttpError(403, "请求来源不受信任。");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/oh-story/workspace" && request.method === "GET") {
      const realm = await workspaceRealm(context, url);
      const files = await listFiles(realm);
      const tracking = await metadata(realm, files, "追踪/_tracking-state.json", options.maxBytes);
      const shortDrama = await metadata(realm, files, "short-drama.json", options.maxBytes);
      const metadataErrors = [tracking.error, shortDrama.error].filter((value): value is string => value !== undefined);
      send(response, 200, { cwd: realm.cwd, files, tracking: tracking.value, shortDrama: shortDrama.value, metadataErrors, mode: "dsh-session" });
      return;
    }
    if (url.pathname === "/oh-story/file" && request.method === "GET") {
      const realm = await workspaceRealm(context, url);
      const path = url.searchParams.get("path");
      if (path === null) throw new WorkspaceHttpError(400, "缺少文件路径。");
      const file = await readVersionedFile(realm.fs, await creativeTarget(realm, path), options.maxBytes);
      send(response, 200, { path, ...file });
      return;
    }
    if (url.pathname === "/oh-story/file" && request.method === "PUT") {
      const realm = await workspaceRealm(context, url);
      const path = url.searchParams.get("path");
      if (path === null) throw new WorkspaceHttpError(400, "缺少文件路径。");
      const input = await jsonBody(request, options.maxBytes * 6 + 1_024);
      if (typeof input.content !== "string") throw new WorkspaceHttpError(400, "content 必须是字符串。");
      if (typeof input.baseVersion !== "string" || input.baseVersion === "") throw new WorkspaceHttpError(400, "baseVersion 必须是有效版本。");
      if (Buffer.byteLength(input.content) > options.maxBytes) throw new WorkspaceHttpError(413, "文件超过工作台大小限制。");
      const outcome = await realm.fs.writeText(
        await creativeTarget(realm, path),
        input.content,
        { kind: "replaceIfVersion", version: input.baseVersion as FsVersion },
        undefined,
        realm.sandboxPolicy.resolve({ session: realm.agent.session })
      );
      send(response, 200, { path, content: outcome.after, bytes: Buffer.byteLength(outcome.after), version: outcome.version });
      return;
    }
    send(response, 404, { error: "Oh Story route not found." });
  } catch (error) {
    const mapped = error instanceof WorkspaceHttpError ? error : mapFsError(error);
    if (mapped === undefined) context.logger("oh-story").error("workspace route failed", error);
    send(response, mapped?.status ?? 500, { error: mapped?.message ?? "Oh Story workspace operation failed." });
  }
}

/** Mount the narrow editor API on DSH's official web-server extension seam. */
export function registerWorkspaceRoute(context: Context, options: WorkspaceRouteOptions): void {
  context.effect(() => context.webServer.register({
    kind: "prefix",
    path: "/oh-story",
    handler: (request, response) => handle(context, request, response, options)
  }), "oh-story: DSH-session workspace API");
}
