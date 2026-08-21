# Architecture

oh-story-dsh is a Cordis plugin loaded into DeepSeek Harness. The repository ships one product package, `@oh-story/dsh`, with Host and Browser entries.

## Ownership

| Surface | Owner |
| --- | --- |
| Workspace, Session and durable history | DeepSeek Harness |
| Agent loop, provider, model and credentials | DeepSeek Harness |
| Preset, sandbox, tools, permissions and approvals | DeepSeek Harness |
| Chat, Trajectory, Todo and Composer | DeepSeek Harness conversation UI |
| Novel craft and specialist personas | Pinned Oh Story Skills and Roles |
| Short-drama workflow and project contracts | Pinned Drama Skills |
| Creative file tree, editor and file following | `@oh-story/dsh` Browser contribution |

## Host entry

The Host entry registers six contributions in the current Cordis context:

1. An `oh-story` Skill provider for 13 pinned novel Skills.
2. A `short-drama` Skill provider for 10 pinned Drama Skills.
3. The `oh_story_role` tool, backed by DSH's `spawn` provider and bounded by the caller's visible tools.
4. `tools/pre-execute` and `tools/post-execute` hooks for long-form outline and Tracking checks.
5. A Session-scoped creative file route for Markdown, text, JSON and JSONL files.
6. A small Session Projection that publishes in-progress file-tool arguments to the Browser entry.

Both providers prepend a small DSH bridge at load time. The bridge maps upstream platform integration points to the current Session, tools, approvals and UI while leaving craft instructions and references intact. The short-drama production bridge retains the upstream exact-job confirmation contract.

The file route first applies the same Host, Origin and Fetch Metadata trust boundary as DSH's native browser API. It resolves the live Agent from the supplied `sessionId`, then uses that Agent's DSH `FileSystem` and sandbox policy for resolution, containment, reads and atomic `replaceIfVersion` writes. Access remains limited to documented novel and short-drama project directories. Loopback is trusted by default; explicit non-loopback authorities must be declared through the plugin's `trustedHosts` config. Child Sessions do not receive an editor route.

## Browser entry

The Browser entry uses two official extension slots:

| Slot | Contribution |
| --- | --- |
| `shell.overlay` | Session-aware three-column creative workbench bridge |
| `tool.call.toolview` | Compact `oh_story_role` invocation view |

The bridge portals the file tree and editor into the stable `conversation.session` layout seam. The mounted official conversation view remains column three, so Chat state, streaming, tools, Todo, approvals, history and Composer continue to use DSH implementations.

The bridge follows DSH's atomic current-session provide source, so it also mounts in a blank New Session. DSH intentionally hides tool-only partial Assistants from `ConversationSnapshot`; the Host projection therefore folds committed `assistant/chunk` events into a whole current list of in-progress calls. The Browser decodes active `write`, `edit` and `str_replace_editor` arguments, restricts them to supported creative paths, and projects them over the last disk version. Once a tool settles, the workspace route is the authority again. The file tree preserves every project directory level; selection changes also switch the 小说/短剧 mode and expand the matching group plus all ancestor directories.

When the Agent is idle, a capture listener recognizes existing workspace file links inside the official conversation. Those links update the same selection state used by Agent file following. Human-dirty buffers take precedence over incoming disk or Agent state and surface a per-file conflict with explicit disk/local resolution. Drafts and editor navigation survive Session switches in process. File reads carry the opaque DSH filesystem version; saves use that version as an atomic precondition and reject stale writes instead of overwriting concurrent disk changes.

Markdown rendering is implemented as a safe React element tree with tables, task lists, quotes and fenced code. Raw HTML is treated as text and external links are limited to HTTP(S). JSONL is parsed one record per source line, keeps malformed lines visible, and summarizes stable IDs, types and statuses. Every preview shares its buffer and save path with source editing.

## Upstream assets

`packages/knowledge/oh-story/manifest.json` pins the Oh Story release, commit, 13 Skills, 7 Roles, agents version and every file hash. `packages/knowledge/drama/manifest.json` performs the same role for 10 Drama Skills.

The Drama Skills standalone dashboard server and assets are omitted during synchronization because the creator surface is supplied by the DSH workbench. Oh Story's login/CDP rank scrapers are also excluded; the two scan Skills use DSH-native, visible-tool research instructions instead. Remaining workflow, reference, validation and production-adapter resources are packaged with their upstream paths.

## Release boundary

The build produces Host and Browser bundles under `packages/dsh-plugin/lib`, copies both knowledge sets, and rejects known parallel-runtime markers. Generated `lib` and tarballs are release artifacts and are excluded from Git history.
