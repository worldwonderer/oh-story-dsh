# Contributing to oh-story-dsh

## 环境

- Node.js 24+
- pnpm 11.7+
- Chrome（仅原生 DSH Web 集成测试需要）

```bash
pnpm install --frozen-lockfile
```

## 本地验证

测试按成本和外部依赖分为三层：

```bash
pnpm verify          # 静态检查、类型、资产完整性、边界、单测与构建
pnpm test:dsh        # 打包并安装到隔离的官方 DSH Web，验证 Session、Skills 与 UI
pnpm verify:release  # 发布门禁：verify + 原生 DSH Web 集成测试
```

真实模型链路不会进入普通 Pull Request CI。需要发布前验证时，通过一次性环境变量或仅包含 Key 的临时文件运行：

```bash
DEEPSEEK_API_KEY_FILE=/path/to/key pnpm test:dsh:real
# 或：DEEPSEEK_API_KEY=... pnpm test:dsh:real
```

测试脚本会使用独立的临时 DSH home 和作品目录，错误与日志会脱敏；不要把凭据写入仓库文件。

## 上游知识资产

- Oh Story：`packages/knowledge/oh-story`
- Drama Skills：`packages/knowledge/drama`

本地同步相邻 checkout：

```bash
OH_STORY_UPSTREAM_DIR=/path/to/oh-story-claudecode pnpm assets:sync:story
DRAMA_SKILLS_UPSTREAM_DIR=/path/to/drama-skills pnpm assets:sync:drama
pnpm assets:check
```

同步提交必须连同 manifest 更新一起评审。不要手工修改固定资产后绕过哈希校验。

## CI 分层

- `CI / Quality gate`：Ubuntu 上执行完整确定性门禁 `pnpm verify`。
- `CI / Portability`：macOS 与 Windows 执行类型、资产、单测与构建，锁定跨平台路径行为。
- `CI / Packaged DSH Web integration`：构建 tarball、安装到官方 DSH Web，并用 Chrome 验证能力目录、工作区安全与三栏 UI。
- `Real Provider`：手动工作流；仅在仓库配置 `DEEPSEEK_API_KEY` Secret 时运行付费真实模型链路。
- `Release`：Tag 或手动触发发布门禁；`v*` Tag 会把同一份 `.tgz` 发布到 GitHub Release 与 npm。

## 发布检查

1. 更新版本与用户可见变更。
2. 运行 `pnpm verify:release`。
3. 运行 `pnpm test:dsh:real` 并确认项目摘要未改变、凭据未出现在日志中。
4. 运行 `DEEPSEEK_API_KEY=... pnpm demo`，通过真实 DeepSeek 会话一次性重新生成并检查两张 README 演示图。
5. 运行 `pnpm pack:release` 并检查 tarball。
6. 按 [`docs/RELEASING.md`](docs/RELEASING.md) 创建与包版本一致的 Tag，由工作流执行正式发布。

架构约束见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，验证覆盖见 [`docs/VALIDATION.md`](docs/VALIDATION.md)。
