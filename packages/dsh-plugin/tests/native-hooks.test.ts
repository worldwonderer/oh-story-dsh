import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget } from "@deepseek-ai/dsh-fs";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideStoryMutation, detectStoryMutation, validateStoryMutation } from "../src/native-hooks.js";

const roots: string[] = [];
type StoryFileSystem = Pick<FileSystem, "resolve" | "contains" | "stat" | "listDir">;

function localDshFs(): StoryFileSystem {
  const resolveTarget = async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> => {
    const displayPath = isAbsolute(path) ? resolve(path) : resolve(options?.cwd ?? ".", path);
    return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
  };
  return {
    resolve: vi.fn(resolveTarget),
    contains: (parent, child) => child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`),
    stat: vi.fn(async (target): Promise<FsInfo | undefined> => stat(target.displayPath).then((info) => ({
      version: String(info.mtimeMs) as FsInfo["version"],
      type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
      size: info.size
    }), () => undefined)),
    listDir: vi.fn(async (target): Promise<FsDirEntry[]> => Promise.all((await readdir(target.displayPath, { withFileTypes: true })).map(async (entry) => ({
      name: entry.name,
      type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      target: await resolveTarget(entry.name, { cwd: target.displayPath })
    }))))
  } as StoryFileSystem;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oh-story-hook-"));
  roots.push(root);
  await mkdir(join(root, "大纲"));
  await mkdir(join(root, "追踪"));
  return root;
}

describe("native DSH prose guards", () => {
  it("recognizes both DSH filesystem tool families and ignores editor views", () => {
    expect(detectStoryMutation("write", { file_path: "正文/第002章.md" }, "/books/demo"))
      .toMatchObject({ path: "正文/第002章.md", chapter: 2 });
    expect(detectStoryMutation("str_replace_editor", {
      command: "str_replace",
      path: "/books/demo/正文/第003章.md"
    }, "/books/demo")).toMatchObject({ path: "正文/第003章.md", chapter: 3 });
    expect(detectStoryMutation("str_replace_editor", {
      command: "view",
      path: "/books/demo/正文/第003章.md"
    }, "/books/demo")).toBeUndefined();
    expect(detectStoryMutation("write", { file_path: "正文/第004章.md" }, "dsh://workspace/story"))
      .toMatchObject({ root: "dsh://workspace/story", path: "正文/第004章.md", chapter: 4 });
    expect(detectStoryMutation("write", { file_path: "c:/books/demo/正文/分卷/../第005章.md" }, "C:\\books\\demo"))
      .toMatchObject({ root: "C:/books/demo", path: "正文/第005章.md", chapter: 5 });
  });

  it("allows setup and import to bootstrap prose before canonical Tracking exists", async () => {
    const root = await project();
    await expect(validateStoryMutation(localDshFs(), { root, path: "正文/第002章.md", chapter: 2 }))
      .resolves.toBeUndefined();
  });

  it("requires the matching chapter outline", async () => {
    const root = await project();
    await writeFile(join(root, "追踪", "_tracking-state.json"), "{}\n");
    await expect(validateStoryMutation(localDshFs(), { root, path: "正文/第002章.md", chapter: 2 }))
      .resolves.toContain("细纲");
  });

  it("allows a mutation when Tracking and the matching outline exist", async () => {
    const root = await project();
    await writeFile(join(root, "追踪", "_tracking-state.json"), "{}\n");
    await writeFile(join(root, "大纲", "细纲_第002章_回声.md"), "# 第二章\n");
    await expect(validateStoryMutation(localDshFs(), { root, path: "正文/第002章.md", chapter: 2 }))
      .resolves.toBeUndefined();
  });

  it("preserves DSH's downstream permission decision instead of forcing ask", async () => {
    const root = await project();
    const fs = localDshFs();
    const exec = {
      name: "write",
      arguments: { file_path: "正文/第002章.md" },
      agent: { session: { header: { cwd: root } }, ctx: { get: () => fs } },
      signal: new AbortController().signal
    } as unknown as ToolExecution;
    await expect(decideStoryMutation(exec, async () => ({ kind: "allow" })))
      .resolves.toEqual({ kind: "allow" });
  });

  it("does not impose long-form guards on a plain short-story workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "oh-story-hook-short-"));
    roots.push(root);
    await expect(validateStoryMutation(localDshFs(), { root, path: "正文/短篇.md" })).resolves.toBeUndefined();
  });

  it("reads the calling Agent filesystem instead of the host filesystem", async () => {
    const calls: string[] = [];
    const entries = new Map<string, "file" | "directory">([
      ["/virtual-story/大纲", "directory"],
      ["/virtual-story/追踪", "directory"],
      ["/virtual-story/追踪/_tracking-state.json", "file"]
    ]);
    const fs = {
      resolve: vi.fn(async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> => {
        const displayPath = path.startsWith("/") ? path : `${options?.cwd ?? ""}/${path}`;
        calls.push(displayPath);
        return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
      }),
      contains: vi.fn(() => true),
      stat: vi.fn(async (target: FsTarget): Promise<FsInfo | undefined> => {
        const type = entries.get(target.displayPath);
        return type === undefined ? undefined : { type, version: "v1" as FsInfo["version"] };
      }),
      listDir: vi.fn(async (): Promise<FsDirEntry[]> => [{
        name: "细纲_第002章_虚拟.md",
        type: "file",
        target: {
          targetKey: "/virtual-story/大纲/细纲_第002章_虚拟.md" as FsTarget["targetKey"],
          displayPath: "/virtual-story/大纲/细纲_第002章_虚拟.md"
        }
      }])
    } as StoryFileSystem;
    const exec = {
      name: "write",
      arguments: { file_path: "正文/第002章.md" },
      agent: { session: { header: { cwd: "/virtual-story" } }, ctx: { get: () => fs } },
      signal: new AbortController().signal
    } as unknown as ToolExecution;

    await expect(decideStoryMutation(exec, async () => ({ kind: "allow" }))).resolves.toEqual({ kind: "allow" });
    expect(calls).toContain("/virtual-story/追踪/_tracking-state.json");
  });
});
