import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { build, type Plugin } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "packages/dsh-plugin");
const outputRoot = resolve(packageRoot, "lib");
const ohStoryRoot = resolve(root, "packages/knowledge/oh-story");
const dramaRoot = resolve(root, "packages/knowledge/drama");
const platformGlue = [
  "skills/story/assets/",
  "skills/story/scripts/",
  "skills/browser-cdp/scripts/setup-cdp-chrome.js",
  "skills/story-long-scan/scripts/",
  "skills/story-short-scan/scripts/",
  "skills/story-setup/references/codex/",
  "skills/story-setup/references/generic/",
  "skills/story-setup/references/openclaw/",
  "skills/story-setup/references/opencode/",
  "skills/story-setup/references/reasonix/",
  "skills/story-setup/references/templates/",
  "skills/story-setup/references/zcode/",
  "skills/story-setup/scripts/merge-claude-settings.py",
  "skills/story-setup/scripts/merge-codex-hooks.py",
  "skills/story-setup/UPGRADING.md"
] as const;

const inlineCss: Plugin = {
  name: "inline-css",
  setup(builder) {
    builder.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -"?inline".length)),
      namespace: "inline-css"
    }));
    builder.onLoad({ filter: /.*/, namespace: "inline-css" }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text"
    }));
  }
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await build({
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  outfile: resolve(outputRoot, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  treeShaking: true,
  packages: "bundle",
  external: ["@deepseek-ai/*"]
});

const hostEntry = resolve(outputRoot, "index.js");
await writeFile(hostEntry, (await readFile(hostEntry, "utf8")).replace(/[\t ]+$/gmu, ""));

await build({
  entryPoints: [resolve(packageRoot, "src/client/index.tsx")],
  outfile: resolve(outputRoot, "client.js"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["chrome120", "safari17"],
  sourcemap: true,
  treeShaking: true,
  define: { "process.env.NODE_ENV": '"production"' },
  minifySyntax: true,
  external: ["@deepseek-ai/*", "react", "react/jsx-runtime", "react-dom", "react-dom/client"],
  plugins: [inlineCss],
  banner: { js: "window.__ModuleLoader__.load({id:\"@oh-story/dsh\",factory:(require)=>{var module={exports:{}};var exports=module.exports;" },
  footer: { js: ";return module.exports;}});" }
});

await cp(ohStoryRoot, resolve(outputRoot, "oh-story"), {
  recursive: true,
  filter: (source) => {
    const normalized = source.replaceAll("\\", "/");
    const bundledPath = relative(ohStoryRoot, source).replaceAll("\\", "/");
    return !normalized.includes("/__pycache__/")
      && !normalized.endsWith("/__pycache__")
      && !normalized.endsWith(".pyc")
      && !normalized.endsWith("/.DS_Store")
      && !platformGlue.some((entry) => bundledPath === entry.replace(/\/$/u, "") || bundledPath.startsWith(entry));
  }
});

await cp(dramaRoot, resolve(outputRoot, "drama"), {
  recursive: true,
  filter: (source) => {
    return !source.includes("/__pycache__/")
      && !source.endsWith("/__pycache__")
      && !source.endsWith(".pyc")
      && !source.endsWith("/.DS_Store");
  }
});

for (const excluded of [
  "oh-story/skills/browser-cdp/scripts/setup-cdp-chrome.js",
  "oh-story/skills/story-long-scan/scripts",
  "oh-story/skills/story-short-scan/scripts"
]) {
  const present = await access(resolve(outputRoot, excluded)).then(() => true, () => false);
  if (present) throw new Error(`Release bundle retained excluded platform/scraper code: ${excluded}`);
}

const hostBundle = await readFile(hostEntry, "utf8");
for (const forbidden of ["dsh-sdk-jsonrpc", "DeepSeekHarness", "FakeRuntimeAdapter", "NativeDshRuntimeAdapter", "EventSource"]) {
  if (hostBundle.includes(forbidden)) {
    throw new Error(`Native DSH plugin bundle retained forbidden parallel runtime code: ${forbidden}`);
  }
}

const clientEntry = resolve(outputRoot, "client.js");
const clientBundle = await readFile(clientEntry, "utf8");
for (const forbidden of ["react-dom.development", "react.development", "process.env.NODE_ENV"]) {
  if (clientBundle.includes(forbidden)) {
    throw new Error(`Browser bundle retained development runtime code: ${forbidden}`);
  }
}
const clientBytes = Buffer.byteLength(clientBundle);
if (clientBytes > 400_000) {
  throw new Error(`Browser bundle exceeds the 400 KB release budget: ${String(clientBytes)} bytes`);
}
