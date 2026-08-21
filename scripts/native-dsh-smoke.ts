import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dshVersion = "0.1.1-rc.1";
const demoFramesDirectory = process.env.OH_STORY_DEMO_FRAMES_DIR;
const useRealDeepSeek = process.env.OH_STORY_DEMO_USE_REAL_DEEPSEEK === "1";
const storyProjectName = "让你管账号，你高燃混剪炸全网";
const dramaProjectName = "善意不结账";
const storyFixture = join(repositoryRoot, "scripts", "demo-fixtures", "story", storyProjectName);
const dramaFixture = join(repositoryRoot, "scripts", "demo-fixtures", "drama", dramaProjectName);
const storyPrompt = `请只读检查《${storyProjectName}》当前工程，简要概览正文、大纲、设定与追踪状态，不修改任何文件。`;
const dramaPrompt = `请只读检查短剧《${dramaProjectName}》当前工程，简要概览项目开发、剧本、设定集、分镜与审查状态，不修改任何文件。`;
const storyReply = `已读取《${storyProjectName}》工程。正文、大纲、设定与追踪文件已就绪。`;
const dramaReply = `已读取《${dramaProjectName}》工程。项目开发、8 集剧本、设定集、分镜与审查产物已就绪。`;
const agentMutationPrompt = "AGENT_WRITE_SMOKE：请使用 write 工具创建指定测试文件。";
const agentMutationPath = "设定/角色/_agent-write-smoke.md";
const agentMutationContent = "# Agent 写入验证\n\n这段正文由真实 DSH Agent 工具调用流式写入。\n\n- 文件树自动定位\n- 编辑器同步更新\n";
const agentMutationReply = "测试文件已通过 write 工具创建。";

async function captureDemoFrame(page: Page, workbench: "story" | "drama", index: number): Promise<void> {
  if (demoFramesDirectory === undefined) return;
  await mkdir(demoFramesDirectory, { recursive: true });
  await page.waitForTimeout(180);
  await page.screenshot({
    path: join(demoFramesDirectory, `${workbench}-${String(index).padStart(2, "0")}.png`),
    animations: "disabled"
  });
}

async function prepareDemoSurface(page: Page): Promise<void> {
  if (demoFramesDirectory === undefined) return;
  const collapse = page.getByRole("button", { name: /^(?:Collapse sidebar|收起侧边栏)$/u }).first();
  await collapse.waitFor({ state: "visible", timeout: 10_000 });
  await collapse.click();
  await page.getByRole("button", { name: /^(?:Open sidebar|打开侧边栏)$/u }).first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(350);
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd: repositoryRoot, env, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a DSH test port.");
  await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return address.port;
}

interface MockDeepSeek {
  readonly baseURL: string;
  readonly server: HttpServer;
}

async function startMockDeepSeek(): Promise<MockDeepSeek> {
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", async () => {
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end("not found");
        return;
      }
      let payload: unknown;
      try { payload = JSON.parse(body) as unknown; }
      catch {
        response.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid json"}');
        return;
      }
      const serialized = JSON.stringify(payload);
      const messages = (payload as { readonly messages?: readonly { readonly role?: string }[] }).messages ?? [];
      const mutationTurn = serialized.includes(agentMutationPrompt);
      const hasToolResult = messages.some((message) => message.role === "tool");
      let events: string[];
      if (mutationTurn && !hasToolResult) {
        const argumentsJson = JSON.stringify({ file_path: agentMutationPath, content: agentMutationContent });
        const chunks = argumentsJson.match(/.{1,14}/gu) ?? [argumentsJson];
        events = [
          JSON.stringify({ choices: [{ delta: { role: "assistant", content: null, reasoning_content: "" } }] }),
          ...chunks.map((argumentsDelta, index) => JSON.stringify({ choices: [{ delta: { tool_calls: [{
            index: 0,
            ...(index === 0 ? { id: "call_oh_story_write_smoke", type: "function" } : {}),
            function: { ...(index === 0 ? { name: "write" } : {}), arguments: argumentsDelta }
          }] } }] })),
          JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 20 } }),
          "[DONE]"
        ];
      } else {
        const content = mutationTurn ? agentMutationReply : serialized.includes(dramaProjectName) ? dramaReply : storyReply;
        events = [
          JSON.stringify({ choices: [{ delta: { role: "assistant", content: null, reasoning_content: "" } }] }),
          JSON.stringify({ choices: [{ delta: { content } }] }),
          JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 20 } }),
          "[DONE]"
        ];
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
        connection: "keep-alive"
      });
      for (const event of events) {
        response.write(`data: ${event}\n\n`);
        if (mutationTurn && !hasToolResult) await new Promise((accept) => setTimeout(accept, 180));
      }
      response.end();
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not start the local DeepSeek fixture.");
  return { baseURL: `http://127.0.0.1:${String(address.port)}`, server };
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
}

async function waitForServer(origin: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(origin)).ok) return; } catch { /* retry */ }
    await new Promise((accept) => setTimeout(accept, 150));
  }
  throw new Error("Timed out waiting for official DSH Web.");
}

async function rpc<T>(origin: string, method: string, payload: unknown): Promise<T> {
  const rpcId = `oh-story-smoke-${crypto.randomUUID()}`;
  const deadline = Date.now() + 15_000;
  while (true) {
    const response = await fetch(`${origin}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload })
    });
    const body = await response.text();
    if (response.status === 404 && body.trim() === "not found" && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 100));
      continue;
    }
    let envelope: {
      readonly rpcId: string;
      readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
    };
    try { envelope = JSON.parse(body) as typeof envelope; }
    catch { throw new Error(`DSH ${method} returned HTTP ${String(response.status)} with a non-JSON body: ${body.slice(0, 200)}`); }
    if (!response.ok || envelope.rpcId !== rpcId || !envelope.result.ok) {
      throw new Error(`DSH ${method} failed: ${JSON.stringify(envelope)}`);
    }
    return envelope.result.value;
  }
}

interface HistoryEvent { readonly type: string; readonly data: unknown }

async function waitForCompletedTurn(origin: string, sessionId: string): Promise<readonly HistoryEvent[]> {
  const timeout = useRealDeepSeek ? 600_000 : 30_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const history = await rpc<{ readonly events: readonly { readonly event: HistoryEvent }[] }>(origin, "session.history", { sessionId, maxMessages: 1_000 });
    const events = history.events.map((entry) => entry.event);
    const end = [...events].reverse().find((event) => event.type === "turn/end");
    if (end !== undefined) {
      const reason = (end.data as { readonly reason?: { readonly kind?: string } }).reason?.kind;
      if (reason !== "completed") throw new Error(`DSH Agent turn ended with ${String(reason)}.`);
      if (!events.some((event) => event.type === "assistant/message")) throw new Error("DSH Agent turn has no assistant result.");
      return events;
    }
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`DSH Agent turn did not complete within ${String(timeout / 1_000)} seconds.`);
}

async function prepareSession(origin: string, sessionId: string, prompt: string, title: string): Promise<void> {
  const models = await rpc<{
    readonly groups: readonly { readonly id: string; readonly models: readonly { readonly id: string }[] }[];
  }>(origin, "session.models", { sessionId });
  const deepseek = models.groups.find((group) => group.id === "deepseek-official");
  const model = deepseek?.models.find((candidate) => candidate.id === "deepseek-v4-flash")?.id ?? deepseek?.models[0]?.id;
  if (deepseek === undefined || model === undefined) throw new Error("DSH did not expose a DeepSeek official model.");
  await rpc(origin, "session.selectModel", { sessionId, provider: deepseek.id, model });
  await rpc(origin, "session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: prompt }]
  });
  await waitForCompletedTurn(origin, sessionId);
  await rpc(origin, "session.rename", { sessionId, title });
}

/** Send one request with headers verbatim; fetch silently drops a forged Host. */
async function rawStatus(target: string, headers: Readonly<Record<string, string>>): Promise<number> {
  const url = new URL(target);
  return new Promise<number>((accept, reject) => {
    const call = httpRequest({
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { host: url.host, ...headers }
    }, (response) => {
      response.resume();
      response.once("end", () => { accept(response.statusCode ?? 0); });
    });
    call.once("error", reject);
    call.end();
  });
}

async function ensureOpen(summary: ReturnType<Page["locator"]>): Promise<void> {
  const details = summary.locator("..");
  const open = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) await summary.click();
}

async function openGroup(page: Page, label: string): Promise<void> {
  const summary = page.locator(".oh-story-file-group > summary").filter({ hasText: new RegExp(`^${label}\\d+$`, "u") }).first();
  await summary.waitFor({ state: "visible", timeout: 10_000 });
  await ensureOpen(summary);
}

async function openFolder(page: Page, label: string): Promise<void> {
  const summary = page.locator(".oh-story-file-folder > summary").filter({ hasText: new RegExp(`^${label}\\d+$`, "u") }).first();
  await summary.waitFor({ state: "visible", timeout: 10_000 });
  await ensureOpen(summary);
}

async function selectFile(page: Page, path: string): Promise<void> {
  const button = page.locator(`button[data-file-path=${JSON.stringify(path)}]`);
  await button.waitFor({ state: "visible", timeout: 10_000 });
  await button.click();
}

async function selectSession(page: Page, workspaceTitle: string, sessionTitle: string): Promise<void> {
  const open = page.getByRole("button", { name: /^(?:Open sidebar|打开侧边栏)$/u }).first();
  if (await open.isVisible()) await open.click();
  const workspaceRow = page.getByRole("treeitem").filter({ hasText: workspaceTitle }).first();
  await workspaceRow.waitFor({ state: "visible", timeout: 10_000 });
  if (await workspaceRow.getAttribute("aria-expanded") !== "true") await workspaceRow.click();
  const sessionRow = page.getByRole("treeitem").filter({ hasText: sessionTitle }).first();
  await sessionRow.waitFor({ state: "visible", timeout: 10_000 });
  await sessionRow.click();
  await page.getByRole("treeitem", { selected: true }).filter({ hasText: sessionTitle }).first()
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise<void>((accept) => child.once("exit", () => accept())),
    new Promise<void>((accept) => setTimeout(accept, 3_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "oh-story-native-dsh-smoke-"));
  const packDirectory = join(temporaryRoot, "pack");
  const installation = join(temporaryRoot, "dsh");
  const dshHome = join(temporaryRoot, "home");
  const projectsRoot = join(temporaryRoot, "projects");
  const storyRoot = join(projectsRoot, storyProjectName);
  const dramaRoot = join(projectsRoot, dramaProjectName);
  const origin = `http://127.0.0.1:${String(await freePort())}`;
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  let mockDeepSeek: MockDeepSeek | undefined;
  try {
    await Promise.all([
      cp(storyFixture, storyRoot, { recursive: true }),
      cp(dramaFixture, dramaRoot, { recursive: true })
    ]);
    run("pnpm", ["--filter", "@oh-story/dsh", "build"]);
    run("pnpm", ["--filter", "@oh-story/dsh", "pack", "--pack-destination", packDirectory]);
    await mkdir(installation, { recursive: true });
    await writeFile(join(installation, "package.json"), `${JSON.stringify({ private: true, dependencies: { "@deepseek-ai/dsh": dshVersion } }, null, 2)}\n`);
    await writeFile(join(installation, "pnpm-workspace.yaml"), [
      "packages:", "  - .", "nodeLinker: hoisted", "allowBuilds:",
      "  '@deepseek-ai/dsh-subprocess-local': true", "  '@google/genai': false", "  koffi: true",
      "  node-addon-require-builtin: false", "  node-pty: true", "  protobufjs: false", ""
    ].join("\n"));
    try { run("pnpm", ["--dir", installation, "install", "--offline"]); }
    catch { run("pnpm", ["--dir", installation, "install"]); }
    const dshBin = join(installation, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    const tarball = (await readdir(packDirectory)).find((entry) => entry.endsWith(".tgz"));
    if (tarball === undefined) throw new Error("Plugin pack did not create a tarball.");
    const archivePath = join(packDirectory, tarball);
    const archive = spawnSync("tar", ["-tzf", archivePath], { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
    if (archive.status !== 0) throw new Error(`Could not inspect plugin tarball:\n${archive.stderr}`);
    const entries = new Set(archive.stdout.split("\n").filter((entry) => entry !== ""));
    for (const required of [
      "package/LICENSE", "package/README.md", "package/cordis.patch.yml", "package/package.json",
      "package/lib/index.js", "package/lib/client.js", "package/lib/oh-story/manifest.json", "package/lib/drama/manifest.json"
    ]) {
      if (!entries.has(required)) throw new Error(`Plugin tarball is missing ${required}.`);
    }
    for (const entry of entries) {
      if (/\/(?:src|tests)\//u.test(entry) || /dashboard_server\.py$/u.test(entry) || entry.endsWith("/.DS_Store")) {
        throw new Error(`Plugin tarball retained forbidden content: ${entry}`);
      }
    }
    const realApiKey = useRealDeepSeek ? process.env.DEEPSEEK_API_KEY : undefined;
    if (useRealDeepSeek && realApiKey === undefined) {
      throw new Error("Real demo capture requires DEEPSEEK_API_KEY.");
    }
    if (!useRealDeepSeek) mockDeepSeek = await startMockDeepSeek();
    const env = {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: "1",
      DEEPSEEK_API_KEY: realApiKey ?? "oh-story-local-fixture",
      DEEPSEEK_BASE_URL: mockDeepSeek?.baseURL ?? "https://api.deepseek.com"
    };
    run(process.execPath, [dshBin, "plugin", "--profile", "web", "add", archivePath], env);
    const port = new URL(origin).port;
    child = spawn(process.execPath, [dshBin, "web", "--no-open", "--port", port], {
      cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
    await waitForServer(origin);

    const storyWorkspace = await rpc<{ readonly workspace: { readonly workspaceId: string; readonly title: string } }>(origin, "workspace.create", { path: storyRoot });
    const dramaWorkspace = await rpc<{ readonly workspace: { readonly workspaceId: string; readonly title: string } }>(origin, "workspace.create", { path: dramaRoot });
    const storySession = await rpc<{ readonly sessionId: string }>(origin, "session.create", { workspaceId: storyWorkspace.workspace.workspaceId });
    const dramaSession = await rpc<{ readonly sessionId: string }>(origin, "session.create", { workspaceId: dramaWorkspace.workspace.workspaceId });
    const catalog = await rpc<{ readonly skills: readonly { readonly name: string }[] }>(origin, "skill.list", { sessionId: storySession.sessionId });
    const ohStorySkills = catalog.skills.filter((skill) => skill.name === "story" || skill.name.startsWith("story-") || skill.name === "browser-cdp");
    const dramaSkills = catalog.skills.filter((skill) => skill.name === "short-drama" || skill.name.startsWith("short-drama-"));
    if (ohStorySkills.length !== 13) throw new Error(`Expected 13 Oh Story Skills, found ${String(ohStorySkills.length)}.`);
    if (dramaSkills.length !== 10) throw new Error(`Expected 10 Drama Skills, found ${String(dramaSkills.length)}.`);
    const storySessionTitle = `小说 · ${storyProjectName}`;
    const dramaSessionTitle = `短剧 · ${dramaProjectName}`;
    await prepareSession(origin, storySession.sessionId, storyPrompt, storySessionTitle);
    await prepareSession(origin, dramaSession.sessionId, dramaPrompt, dramaSessionTitle);

    const storyWorkspaceResponse = await fetch(`${origin}/oh-story/workspace?sessionId=${encodeURIComponent(storySession.sessionId)}`);
    const storyWorkspacePayload = await storyWorkspaceResponse.json() as { readonly mode?: string; readonly cwd?: string; readonly files?: readonly { readonly path: string }[]; readonly shortDrama?: unknown };
    if (!storyWorkspaceResponse.ok || storyWorkspacePayload.mode !== "dsh-session" || storyWorkspacePayload.cwd !== await realpath(storyRoot)
      || !storyWorkspacePayload.files?.some((file) => file.path.startsWith("正文/")) || storyWorkspacePayload.shortDrama !== null) {
      throw new Error(`Story Session workspace route failed: ${JSON.stringify(storyWorkspacePayload)}`);
    }
    const dramaWorkspaceResponse = await fetch(`${origin}/oh-story/workspace?sessionId=${encodeURIComponent(dramaSession.sessionId)}`);
    const dramaWorkspacePayload = await dramaWorkspaceResponse.json() as { readonly mode?: string; readonly cwd?: string; readonly files?: readonly { readonly path: string }[]; readonly shortDrama?: { readonly title?: string } };
    if (!dramaWorkspaceResponse.ok || dramaWorkspacePayload.mode !== "dsh-session" || dramaWorkspacePayload.cwd !== await realpath(dramaRoot)
      || !dramaWorkspacePayload.files?.some((file) => file.path.startsWith("剧集/")) || dramaWorkspacePayload.shortDrama?.title !== dramaProjectName) {
      throw new Error(`Drama Session workspace route failed: ${JSON.stringify(dramaWorkspacePayload)}`);
    }
    const escaped = await fetch(`${origin}/oh-story/file?sessionId=${encodeURIComponent(storySession.sessionId)}&path=${encodeURIComponent("../package.json")}`);
    if (escaped.ok) throw new Error("Workspace route allowed path traversal.");
    const chapterPath = "正文/第001章_军宣新星.md";
    const chapterUrl = `${origin}/oh-story/file?sessionId=${encodeURIComponent(storySession.sessionId)}&path=${encodeURIComponent(chapterPath)}`;
    const chapterResponse = await fetch(chapterUrl);
    const chapter = await chapterResponse.json() as { readonly content?: string; readonly version?: string };
    if (!chapterResponse.ok || chapter.content === undefined || chapter.version === undefined) {
      throw new Error(`Workspace file version was unavailable: ${JSON.stringify(chapter)}`);
    }
    const staleWrite = await fetch(chapterUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: chapter.content, baseVersion: "stale-version" })
    });
    if (staleWrite.status !== 412) throw new Error(`Workspace route accepted a stale write: ${String(staleWrite.status)}.`);
    const unchangedWrite = await fetch(chapterUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: chapter.content, baseVersion: chapter.version })
    });
    const unchanged = await unchangedWrite.json() as { readonly version?: string };
    if (!unchangedWrite.ok || unchanged.version === undefined) {
      throw new Error(`Workspace optimistic save failed: ${JSON.stringify(unchanged)}`);
    }
    const candidates = Array.from({ length: 20 }, (_, index) => `${chapter.content}\n<!-- atomic-${String(index)} -->\n`);
    const concurrent = await Promise.all(candidates.map((content) => fetch(chapterUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, baseVersion: unchanged.version })
    })));
    const winnerCount = concurrent.filter((response) => response.ok).length;
    const staleCount = concurrent.filter((response) => response.status === 412).length;
    if (winnerCount !== 1 || staleCount !== candidates.length - 1) {
      throw new Error(`Workspace CAS was not atomic: ${JSON.stringify(concurrent.map((response) => response.status))}`);
    }
    const afterRaceResponse = await fetch(chapterUrl);
    const afterRace = await afterRaceResponse.json() as { readonly content?: string; readonly version?: string };
    if (!afterRaceResponse.ok || afterRace.content === undefined || afterRace.version === undefined || !candidates.includes(afterRace.content)) {
      throw new Error(`Workspace CAS winner was not authoritative: ${JSON.stringify(afterRace)}`);
    }
    const restoreChapter = await fetch(chapterUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: chapter.content, baseVersion: afterRace.version })
    });
    if (!restoreChapter.ok) throw new Error(`Workspace CAS fixture restore failed: ${String(restoreChapter.status)}.`);

    const trackingPath = "追踪/_tracking-state.json";
    const trackingUrl = `${origin}/oh-story/file?sessionId=${encodeURIComponent(storySession.sessionId)}&path=${encodeURIComponent(trackingPath)}`;
    const trackingResponse = await fetch(trackingUrl);
    const tracking = await trackingResponse.json() as { readonly content?: string; readonly version?: string };
    if (!trackingResponse.ok || tracking.content === undefined || tracking.version === undefined) throw new Error("Tracking fixture was unavailable.");
    const invalidTrackingResponse = await fetch(trackingUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "{ invalid", baseVersion: tracking.version })
    });
    const invalidTracking = await invalidTrackingResponse.json() as { readonly version?: string };
    if (!invalidTrackingResponse.ok || invalidTracking.version === undefined) throw new Error("Could not stage invalid tracking JSON.");
    const degradedWorkspaceResponse = await fetch(`${origin}/oh-story/workspace?sessionId=${encodeURIComponent(storySession.sessionId)}`);
    const degradedWorkspace = await degradedWorkspaceResponse.json() as { readonly files?: readonly unknown[]; readonly metadataErrors?: readonly string[] };
    if (!degradedWorkspaceResponse.ok || degradedWorkspace.files === undefined
      || !degradedWorkspace.metadataErrors?.some((message) => message.includes(trackingPath))) {
      throw new Error(`Invalid metadata still broke the workspace: ${JSON.stringify(degradedWorkspace)}`);
    }
    const restoreTracking = await fetch(trackingUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: tracking.content, baseVersion: invalidTracking.version })
    });
    if (!restoreTracking.ok) throw new Error(`Tracking fixture restore failed: ${String(restoreTracking.status)}.`);
    // The Host/Origin/Fetch-Metadata fence is unit-tested in isolation; assert it
    // against the mounted route so dropping it from the handler cannot pass CI.
    // These go over node:http because fetch refuses to forge a Host header.
    // The same-origin control keeps the rejections below from passing vacuously.
    const trusted = await rawStatus(chapterUrl, { "sec-fetch-site": "same-origin" });
    if (trusted !== 200) throw new Error(`Workspace route rejected a same-origin request: ${String(trusted)}.`);
    for (const [label, headers] of [
      ["rebound Host", { host: "attacker.example" }],
      ["cross-site marker", { "sec-fetch-site": "cross-site" }],
      ["foreign Origin", { origin: "http://attacker.example" }],
      ["opaque Origin", { origin: "null" }]
    ] as const) {
      const status = await rawStatus(chapterUrl, headers);
      if (status !== 403) {
        throw new Error(`Workspace route served an untrusted request (${label}): ${String(status)}.`);
      }
    }

    const index = await (await fetch(origin)).text();
    const clientPath = index.match(/\/plugins\/[^"']*oh-story[^"']*client\.js[^"']*/u)?.[0];
    if (clientPath === undefined) throw new Error("DSH did not publish the Oh Story Browser module.");
    const client = await (await fetch(new URL(clientPath, origin))).text();
    for (const slot of ["shell.overlay", "tool.call.toolview"]) {
      if (!client.includes(slot)) throw new Error(`Browser module is missing official slot ${slot}.`);
    }
    for (const forbidden of ["conversation.session.header.actions", "EventSource", "FakeRuntimeAdapter"]) {
      if (client.includes(forbidden)) throw new Error(`Browser module still contains legacy surface ${forbidden}.`);
    }

    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1_440, height: 900 } });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(origin, { waitUntil: "networkidle" });
      for (const name of [/^(?:Continue|继续)$/u, /^(?:Configure later|稍后配置)$/u]) {
        const button = page.getByRole("button", { name });
        try {
          await button.waitFor({ state: "visible", timeout: 10_000 });
          await button.click();
        } catch { /* the step may already be persisted */ }
      }
      await page.locator('[class*="onboardingOverlay"]').waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
      await selectSession(page, storyWorkspace.workspace.title, storySessionTitle);
      const blankSession = page.getByRole("button", { name: /^(?:New session|新会话)$/u }).first();
      await blankSession.waitFor({ state: "visible", timeout: 10_000 });
      await blankSession.click();
      await page.getByRole("navigation", { name: "小说项目文件" }).waitFor({ state: "visible", timeout: 20_000 });
      if (await page.locator(".oh-story-split-surface").count() !== 1) {
        throw new Error("Blank DSH Session did not mount the three-column workbench.");
      }
      await selectSession(page, storyWorkspace.workspace.title, storySessionTitle);
      const storyTree = page.getByRole("navigation", { name: "小说项目文件" });
      try { await storyTree.waitFor({ state: "visible", timeout: 20_000 }); }
      catch (error) {
        const tabs = await page.getByRole("tab").allTextContents();
        const body = (await page.locator("body").innerText()).slice(0, 4_000);
        throw new Error(`Three-column story surface was not visible; tabs=${JSON.stringify(tabs)}; pageErrors=${JSON.stringify(pageErrors)}; body=${JSON.stringify(body)}`, { cause: error });
      }
      await page.getByText(storyPrompt, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      if (!useRealDeepSeek) await page.getByText(`已读取《${storyProjectName}》工程。`, { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
      if (await page.getByText("This turn failed", { exact: false }).isVisible()) throw new Error("Story Chat contains a failed turn.");

      if (!useRealDeepSeek) {
        await rpc(origin, "session.prompt", {
          sessionId: storySession.sessionId,
          mode: "queue",
          content: [{ type: "text", text: agentMutationPrompt }]
        });
        const streamedEditor = page.getByRole("textbox", { name: agentMutationPath });
        const streamedValues = new Set<string>();
        for (let sample = 0; sample < 40; sample += 1) {
          if (await streamedEditor.isVisible()) streamedValues.add(await streamedEditor.inputValue());
          await page.waitForTimeout(75);
        }
        if (streamedValues.size === 0) {
          const history = await rpc<{ readonly events: readonly { readonly event: HistoryEvent }[] }>(origin, "session.history", { sessionId: storySession.sessionId, maxMessages: 1_000 });
          throw new Error(`Agent write never reached the editor; tailEvents=${JSON.stringify(history.events.slice(-12).map((entry) => entry.event.type))}`);
        }
        const approval = page.getByRole("button", { name: /^(?:Allow once|允许一次)$/u });
        try {
          await approval.waitFor({ state: "visible", timeout: 3_000 });
          await approval.click();
        } catch { /* workspace writes may already be allowed by the active preset */ }
        await page.getByText(agentMutationReply, { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
        await waitForCompletedTurn(origin, storySession.sessionId);
        const agentFileUrl = `${origin}/oh-story/file?sessionId=${encodeURIComponent(storySession.sessionId)}&path=${encodeURIComponent(agentMutationPath)}`;
        const agentFileResponse = await fetch(agentFileUrl);
        const agentFile = await agentFileResponse.json() as { readonly content?: string };
        if (!agentFileResponse.ok || agentFile.content !== agentMutationContent) {
          throw new Error(`Real DSH Agent write was not authoritative on disk: ${JSON.stringify(agentFile)}`);
        }
        if (streamedValues.size < 2 || ![...streamedValues].some((value) => value.length > 0 && value.length < agentMutationContent.length)) {
          throw new Error(`Editor did not expose incremental Agent write content: ${JSON.stringify([...streamedValues].map((value) => value.length))}`);
        }
        const agentTreeFile = page.locator(`button[data-file-path=${JSON.stringify(agentMutationPath)}]`);
        await agentTreeFile.waitFor({ state: "visible", timeout: 10_000 });
        if (await agentTreeFile.getAttribute("aria-current") !== "page") throw new Error("Agent write did not automatically select its file in the tree.");
        await selectFile(page, chapterPath);
        const agentFolder = page.locator(".oh-story-file-folder > summary").filter({ hasText: /^角色\d+$/u }).first();
        await agentFolder.click();
        await page.waitForFunction((path) => {
          const button = document.querySelector(`button[data-file-path=${JSON.stringify(path)}]`);
          return button === null || !button.checkVisibility();
        }, agentMutationPath);
        const officialWriteFile = page.locator('[data-slot="conversation.session"] button').filter({ hasText: new RegExp(`^${agentMutationPath}$`, "u") }).first();
        await officialWriteFile.waitFor({ state: "visible", timeout: 10_000 });
        await officialWriteFile.click();
        await agentTreeFile.waitFor({ state: "visible", timeout: 10_000 });
        if (await agentTreeFile.getAttribute("aria-current") !== "page") throw new Error("Official Chat tool file did not expand and locate the Agent-written file.");
        await rm(join(storyRoot, agentMutationPath));
        await page.getByTitle("刷新").click();
        await agentTreeFile.waitFor({ state: "detached", timeout: 10_000 });
      }
      await prepareDemoSurface(page);
      const previewTab = page.getByRole("tab", { name: "预览" });
      await previewTab.waitFor({ state: "visible", timeout: 10_000 });
      if (await page.getByRole("button", { name: "已保存", exact: true }).count() !== 0) throw new Error("Editor header still renders a redundant saved button.");
      if (await page.locator(".oh-story-meta").count() !== 0) throw new Error("Workbench still renders the redundant project meta row.");
      await selectFile(page, chapterPath);
      await page.getByRole("article", { name: `${chapterPath} 渲染预览` }).waitFor({ state: "visible", timeout: 10_000 });
      await captureDemoFrame(page, "story", 1);
      await page.getByRole("tab", { name: "源码", exact: true }).click();
      const chapterEditor = page.getByRole("textbox", { name: chapterPath });
      await chapterEditor.waitFor({ state: "visible", timeout: 10_000 });
      const draftChapter = `${chapter.content}\n<!-- session draft smoke -->\n`;
      await chapterEditor.fill(draftChapter);
      await selectSession(page, dramaWorkspace.workspace.title, dramaSessionTitle);
      await selectSession(page, storyWorkspace.workspace.title, storySessionTitle);
      const restoredDraft = page.getByRole("textbox", { name: chapterPath });
      await restoredDraft.waitFor({ state: "visible", timeout: 10_000 });
      if (await restoredDraft.inputValue() !== draftChapter) {
        throw new Error("Switching DSH Sessions discarded the unsaved editor draft.");
      }
      const editedChapter = `${chapter.content}\n<!-- native DSH editor smoke -->\n`;
      await restoredDraft.fill(editedChapter);
      const saveButton = page.getByRole("button", { name: "保存", exact: true });
      const saveRequest = page.waitForResponse((response) => (
        response.request().method() === "PUT"
        && response.url() === chapterUrl
      ));
      await saveButton.click();
      const browserSaveResponse = await saveRequest;
      if (!browserSaveResponse.ok()) {
        throw new Error(`Browser editor save returned HTTP ${String(browserSaveResponse.status())}.`);
      }
      await saveButton.waitFor({ state: "hidden", timeout: 10_000 });
      const savedResponse = await fetch(chapterUrl);
      const savedChapter = await savedResponse.json() as { readonly content?: string; readonly version?: string };
      if (!savedResponse.ok || savedChapter.content !== editedChapter || savedChapter.version === undefined) {
        throw new Error(`Browser editor did not save through the versioned route: ${JSON.stringify(savedChapter)}`);
      }
      const restoredResponse = await fetch(chapterUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: chapter.content, baseVersion: savedChapter.version })
      });
      if (!restoredResponse.ok) throw new Error(`Could not restore the editor smoke fixture: ${String(restoredResponse.status)}.`);

      await openGroup(page, "大纲");
      await selectFile(page, "大纲/细纲_第001章.md");
      await selectFile(page, chapterPath);
      await page.getByRole("tab", { name: "源码", exact: true }).click();
      const conflictEditor = page.getByRole("textbox", { name: chapterPath });
      await conflictEditor.waitFor({ state: "visible", timeout: 10_000 });
      if (await conflictEditor.inputValue() !== chapter.content) throw new Error("Editor did not reconcile the authoritative restored file.");
      await conflictEditor.fill(`${chapter.content}\n<!-- local conflict draft -->\n`);
      const conflictBaseResponse = await fetch(chapterUrl);
      const conflictBase = await conflictBaseResponse.json() as { readonly content?: string; readonly version?: string };
      if (!conflictBaseResponse.ok || conflictBase.content === undefined || conflictBase.version === undefined) throw new Error("Could not prepare browser conflict fixture.");
      const externalChapter = `${chapter.content}\n<!-- external conflict edit -->\n`;
      const externalResponse = await fetch(chapterUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: externalChapter, baseVersion: conflictBase.version })
      });
      const external = await externalResponse.json() as { readonly version?: string };
      if (!externalResponse.ok || external.version === undefined) throw new Error("Could not stage the external browser conflict.");
      await page.getByTitle("刷新").click();
      const conflictAlert = page.getByRole("alert").filter({ hasText: chapterPath });
      await conflictAlert.waitFor({ state: "visible", timeout: 10_000 });
      await selectFile(page, "大纲/细纲_第001章.md");
      if (await page.getByRole("alert").count() !== 0) throw new Error("A file conflict leaked into a different editor tab.");
      await selectFile(page, chapterPath);
      await conflictAlert.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByRole("button", { name: "载入磁盘版本", exact: true }).click();
      await page.getByRole("tab", { name: "源码", exact: true }).click();
      if (await page.getByRole("textbox", { name: chapterPath }).inputValue() !== externalChapter) {
        throw new Error("Conflict resolution did not load the authoritative disk version.");
      }
      const conflictRestore = await fetch(chapterUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: chapter.content, baseVersion: external.version })
      });
      if (!conflictRestore.ok) throw new Error("Could not restore the browser conflict fixture.");
      await previewTab.click();
      await openGroup(page, "大纲");
      await selectFile(page, "大纲/细纲_第001章.md");
      const outline = page.getByRole("article", { name: "大纲/细纲_第001章.md 渲染预览" });
      await outline.waitFor({ state: "visible", timeout: 10_000 });
      if (await outline.locator("h1, h2, h3").count() === 0 || await outline.locator("li").count() === 0) throw new Error("Markdown preview did not render the real outline structure.");
      await captureDemoFrame(page, "story", 2);
      await openGroup(page, "设定");
      await openFolder(page, "角色");
      await selectFile(page, "设定/角色/江晨.md");
      await page.getByRole("article", { name: "设定/角色/江晨.md 渲染预览" }).waitFor({ state: "visible", timeout: 10_000 });
      await captureDemoFrame(page, "story", 3);
      await openGroup(page, "追踪");
      await selectFile(page, "追踪/_tracking-state.json");
      await page.getByRole("textbox", { name: "追踪/_tracking-state.json" }).waitFor({ state: "visible", timeout: 10_000 });
      await captureDemoFrame(page, "story", 4);

      await selectSession(page, dramaWorkspace.workspace.title, dramaSessionTitle);
      const dramaTree = page.getByRole("navigation", { name: "短剧项目文件" });
      await dramaTree.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByText(dramaPrompt, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      if (!useRealDeepSeek) await page.getByText(dramaReply, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      if (await page.getByText("This turn failed", { exact: false }).isVisible()) throw new Error("Drama Chat contains a failed turn.");
      await prepareDemoSurface(page);
      await selectFile(page, "剧集/EP001/screenplay.md");
      await page.getByRole("article", { name: "剧集/EP001/screenplay.md 渲染预览" }).waitFor({ state: "visible", timeout: 10_000 });
      await captureDemoFrame(page, "drama", 1);
      await openGroup(page, "项目开发");
      await selectFile(page, "项目开发/creative-brief.md");
      await page.getByRole("article", { name: "项目开发/creative-brief.md 渲染预览" }).waitFor({ state: "visible", timeout: 10_000 });
      await captureDemoFrame(page, "drama", 2);
      await openGroup(page, "剧集");
      await openFolder(page, "EP001");
      await openFolder(page, "storyboard");
      await selectFile(page, "剧集/EP001/storyboard/shots.jsonl");
      const dramaJsonl = page.getByRole("region", { name: "剧集/EP001/storyboard/shots.jsonl 结构化预览" });
      await dramaJsonl.waitFor({ state: "visible", timeout: 10_000 });
      await dramaJsonl.getByText("6 条记录", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await captureDemoFrame(page, "drama", 3);
      await openGroup(page, "项目");
      await selectFile(page, "short-drama.json");
      await page.getByRole("textbox", { name: "short-drama.json" }).waitFor({ state: "visible", timeout: 10_000 });
      await captureDemoFrame(page, "drama", 4);
      if (await page.getByRole("complementary", { name: "Agent 工作详情" }).count() !== 0) {
        throw new Error("Novel workspace still duplicates the official Agent activity UI.");
      }
      const treeBox = await page.locator(".oh-story-tree").boundingBox();
      const editorBox = await page.locator(".oh-story-editor").boundingBox();
      const chatLocator = page.locator('[data-slot="conversation.session"] > :not(.oh-story-split-surface)');
      const chatBox = await chatLocator.boundingBox();
      const composerLocator = page.locator("[data-composer-seat]");
      const composerBox = await composerLocator.boundingBox();
      if (treeBox === null || editorBox === null || chatBox === null || composerBox === null) throw new Error("Missing three-column layout box.");
      const geometry = {
        ordered: treeBox.x + treeBox.width <= editorBox.x + 1 && editorBox.x + editorBox.width <= chatBox.x + 1,
        composerInsideChat: composerBox.x >= chatBox.x - 1 && composerBox.x + composerBox.width <= chatBox.x + chatBox.width + 1,
        widths: [treeBox.width, editorBox.width, chatBox.width]
      };
      if (!geometry.ordered || !geometry.composerInsideChat || geometry.widths.some((width) => width < 120)) {
        throw new Error(`Invalid three-column geometry: ${JSON.stringify(geometry)}`);
      }
      const scrollerLocator = page.locator("[data-conversation-scroll]");
      const scrollViewport = await scrollerLocator.boundingBox();
      if (scrollViewport === null) throw new Error("Missing conversation scroll viewport.");
      const priorMinHeight = await chatLocator.evaluate((element) => element.style.minHeight);
      const viewportHeight = await scrollerLocator.evaluate((element) => element.clientHeight);
      await chatLocator.evaluate((element, height) => { element.style.minHeight = height; }, `${String(viewportHeight * 4)}px`);
      const scrollHeight = await scrollerLocator.evaluate((element) => element.scrollHeight);
      const composerScroll: { readonly top: number; readonly visible: boolean }[] = [];
      for (const top of [0, (scrollHeight - viewportHeight) / 2, scrollHeight]) {
        await scrollerLocator.evaluate((element, nextTop) => { element.scrollTo({ top: nextTop }); }, top);
        await page.waitForTimeout(50);
        const input = await composerLocator.boundingBox();
        if (input === null) throw new Error("Official Composer disappeared while scrolling.");
        composerScroll.push({
          top: input.y,
          visible: input.y >= scrollViewport.y - 1 && input.y + input.height <= scrollViewport.y + scrollViewport.height + 1
        });
      }
      await chatLocator.evaluate((element, height) => { element.style.minHeight = height; }, priorMinHeight);
      await scrollerLocator.evaluate((element) => { element.scrollTo({ top: 0 }); });
      if (composerScroll.some((sample) => !sample.visible) || Math.max(...composerScroll.map((sample) => sample.top)) - Math.min(...composerScroll.map((sample) => sample.top)) > 1) {
        throw new Error(`Official Composer did not remain fixed while Chat scrolled: ${JSON.stringify(composerScroll)}`);
      }
      // DSH's navigation/sidebar width differs by platform and font metrics.
      // Calibrate the browser until the conversation center itself reaches
      // roughly its documented 640 px minimum instead of guessing a viewport.
      let narrowViewportWidth = 842;
      let narrowScroller = { clientWidth: 0, scrollWidth: 0 };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.setViewportSize({ width: narrowViewportWidth, height: 900 });
        await page.waitForTimeout(100);
        narrowScroller = await scrollerLocator.evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth
        }));
        if (narrowScroller.clientWidth >= 620) break;
        narrowViewportWidth += 640 - narrowScroller.clientWidth;
      }
      const narrowTree = await page.locator(".oh-story-tree").boundingBox();
      const narrowEditor = await page.locator(".oh-story-editor").boundingBox();
      const narrowChat = await chatLocator.boundingBox();
      const narrowWorkbench = await page.locator(".oh-story-split-surface").evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth
      }));
      if (narrowTree === null || narrowEditor === null || narrowChat === null
        || narrowScroller.clientWidth < 620
        || narrowWorkbench.scrollWidth > narrowWorkbench.clientWidth + 1
        || narrowTree.width < 100 || narrowEditor.width < 200 || narrowChat.width < 240) {
        throw new Error(`Workbench overflowed the minimum DSH center width: ${JSON.stringify({ narrowViewportWidth, narrowScroller, narrowWorkbench, narrowTree, narrowEditor, narrowChat })}`);
      }
      await page.setViewportSize({ width: 500, height: 900 });
      await page.waitForTimeout(100);
      const compactScroller = await scrollerLocator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      const compactBoxes = await Promise.all([
        page.locator(".oh-story-tree").boundingBox(),
        page.locator(".oh-story-editor").boundingBox(),
        chatLocator.boundingBox(),
        composerLocator.boundingBox(),
        composerLocator.getByRole("button", { name: /^(?:Send message|发送消息)$/u }).boundingBox()
      ]);
      if (compactBoxes.some((box) => box === null)) throw new Error("Compact three-column layout lost a required column.");
      const [compactTree, compactEditor, compactChat, compactComposer, compactSend] = compactBoxes as Exclude<(typeof compactBoxes)[number], null>[];
      const compactOrdered = compactTree.x + compactTree.width <= compactEditor.x + 1
        && compactEditor.x + compactEditor.width <= compactChat.x + 1;
      const compactVisible = [compactTree, compactEditor, compactChat, compactComposer, compactSend]
        .every((box) => box.x >= -1 && box.x + box.width <= 501);
      if (!compactOrdered || !compactVisible) {
        throw new Error(`500px viewport clipped the three-column workbench or Composer: ${JSON.stringify({ compactScroller, compactBoxes })}`);
      }
      if (pageErrors.length > 0) throw new Error(`Browser module raised errors: ${pageErrors.join("; ")}`);
    } finally {
      await browser.close();
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      dshVersion,
      architecture: "pure-plugin",
      sessionApi: true,
      skills: ohStorySkills.length,
      dramaSkills: dramaSkills.length,
      provider: useRealDeepSeek ? "deepseek-official" : "local-fixture",
      fixtures: [storyProjectName, dramaProjectName],
      uiSlots: ["shell.overlay", "tool.call.toolview"],
      threeColumn: true,
      agentWriteStreaming: !useRealDeepSeek,
      atomicCasWriters: candidates.length,
      compactViewport: 500
    })}\n`);
  } catch (error) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const redact = (value: string): string => apiKey === undefined ? value : value.replaceAll(apiKey, "[REDACTED]");
    throw new Error(`${redact(String(error))}\nDSH logs:\n${redact(logs.join("").slice(-16_000))}`, { cause: error });
  } finally {
    if (child !== undefined) await stop(child);
    if (mockDeepSeek !== undefined) await closeServer(mockDeepSeek.server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
