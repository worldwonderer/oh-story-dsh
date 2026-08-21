<div align="center">

# oh-story-dsh

**小说与短剧创作工作台**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Oh Story](https://github.com/worldwonderer/oh-story-claudecode) · [Drama Skills](https://github.com/worldwonderer/drama-skills) · [MIT](LICENSE)

</div>

`oh-story-dsh` 是基于 DeepSeek Harness（DSH）构建的社区插件，将 Oh Story 的小说方法库与 Drama Skills 的短剧生产流程带入 DSH。DSH 管理 Agent、会话、模型、权限和 Chat；插件提供创作 Skills、专业 Roles、项目协议与三栏工作台。

> 本项目与 DeepSeek 官方无隶属、合作或背书关系；DeepSeek Harness 名称与品牌素材归其权利人所有。

## 小说工作台

![oh-story-dsh 小说工作台](docs/images/oh-story-dsh-demo.gif)

覆盖长篇、短篇、选题、扫榜、拆文、导入、审稿、去 AI 味与封面流程。13 个 Oh Story Skills 与 7 个专业 Roles 按固定上游版本随插件交付。

## 短剧工作台

![oh-story-dsh 短剧工作台](docs/images/short-drama-dsh-demo.gif)

覆盖原著分析、项目开发、剧本、资产、分镜、图像提示词、视频提示词、审查与生产交付。短剧 Tab 识别 `short-drama.json` 与标准项目目录，按集组织创作文件。

## 核心体验

- **原生三栏布局**：项目文件树、编辑器与官方 Chat 同屏，Trajectory、工具执行、Todo、审批和 Composer 保持 DSH 原生交互。
- **实时文件跟随**：Agent 调用官方文件工具时，目标文件自动定位，编辑器同步呈现生成中的内容。
- **Chat 文件导航**：点击官方 Chat 中的作品文件名，文件树会定位并在编辑器打开对应文件。
- **创作文档预览**：Markdown 支持标题、表格、任务列表、引用和代码块；JSONL 以带行号、类型和状态的结构化记录呈现。
- **安全编辑**：支持源码编辑与快捷保存；人工未保存内容不会被并发 Agent 修改覆盖。
- **稳定长对话**：消息区独立滚动，官方 Composer 固定在 Chat 栏底部。

## 能力目录

| 工作台 | 上游能力 | 主要入口 |
| --- | --- | --- |
| 小说 | [Oh Story 0.7.6](https://github.com/worldwonderer/oh-story-claudecode) · 13 Skills · 7 Roles | `/story`、`/story-long-write`、`/story-review` |
| 短剧 | [Drama Skills](https://github.com/worldwonderer/drama-skills) · 10 Skills | `/short-drama`、`/short-drama-write`、`/short-drama-storyboard` |

## 安装

需要 Node.js 24+。

**1. 安装插件并启动 DSH Web**

```bash
npx -y @deepseek-ai/dsh@0.1.1-rc.1 plugin --profile web add @oh-story/dsh@0.1.0
npx -y @deepseek-ai/dsh@0.1.1-rc.1 web
```

也可以直接安装 GitHub Release 中经过同一套测试的预构建包：

```bash
npx -y @deepseek-ai/dsh@0.1.1-rc.1 plugin --profile web add https://github.com/worldwonderer/oh-story-dsh/releases/download/v0.1.0/oh-story-dsh-0.1.0.tgz
npx -y @deepseek-ai/dsh@0.1.1-rc.1 web
```

默认在 `http://127.0.0.1:3080` 打开。

**2. 配置模型**

首次使用需要在 DSH 的「设置 → 模型」中添加 Provider 并填入 API Key；也可以在启动前设置环境变量 `DEEPSEEK_API_KEY`。模型、凭据与权限均由 DSH 管理，本插件不接触。

**3. 开始创作**

添加作品目录为 workspace，新建或打开 Session 后使用 `/story` 或 `/short-drama`。小说与短剧工作台可随时通过左栏 Tab 切换。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：提供原生插件运行时、Agent、会话、权限审批与 Web 工作台基础。
- [LINUX DO](https://linux.do/)：感谢社区的交流、反馈与开源支持。

[贡献指南](CONTRIBUTING.md) · [架构说明](docs/ARCHITECTURE.md) · [安全策略](SECURITY.md)
