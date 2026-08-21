# Validation

Target: DeepSeek Harness `0.1.1-rc.1` · validated 2026-08-21.

## Test architecture

| Layer | Command | Coverage |
| --- | --- | --- |
| Deterministic quality gate | `pnpm verify` | ESLint, TypeScript, pinned asset hashes/catalogs, DSH boundary audit, unit/component tests, Host/Browser build |
| Cross-platform gate | `pnpm verify:portable` | Type, asset, unit and build behavior on macOS and Windows |
| Packaged DSH integration | `pnpm test:dsh` | Build, npm tarball, profile installation, official DSH Web startup, Session APIs, skill catalog, workspace routes and Chrome UI |
| Real provider | `pnpm test:dsh:real` | Official DeepSeek model, durable Agent completion, Oh Story Role calls, fiction review, short-drama review, read-only project digest and credential redaction |
| Release candidate | `pnpm verify:release` | Deterministic gate plus packaged DSH integration before tarball creation |

The paid real-provider layer is intentionally excluded from Pull Request CI. It is available as a manual GitHub Actions workflow and requires the repository Secret `DEEPSEEK_API_KEY`.

## Automated coverage

| Area | Evidence |
| --- | --- |
| Capability catalog | Native DSH Session exposes 13 Oh Story Skills and 10 Drama Skills |
| Upstream integrity | Both knowledge manifests verify pinned commits, catalogs and every bundled file hash |
| Plugin boundary | Host bundle and source audit keep all DSH imports inside `@oh-story/dsh` |
| Workspace safety | Tests cover same-origin/Host trust, canonical paths, traversal, absolute paths and symbolic-link escape |
| Editor concurrency | Versioned GET/PUT rejects stale saves; Chrome edits, saves, rereads and restores a real workspace file |
| File following | Tests cover partial tool JSON, streamed write/edit projection, creative path classification and workbench switching |
| Markdown rendering | Component tests cover tables, task lists, fenced code, inline formatting, safe links and inert raw HTML |
| JSONL rendering | Component tests cover typed record summaries, source line numbers, scalar records and per-line parse failures |
| Three-column layout | Native DSH Chrome smoke checks ordered tree/editor/Chat geometry and minimum usable widths |
| Composer stability | Scroll regression confirms the official Composer remains fixed inside the Chat column |
| Dual workbench | Native smoke switches 小说/短剧 and opens Markdown and JSONL preview/source modes |
| Roles and hooks | Tests cover Role catalog, DSH child-Agent invocation and novel mutation guards |
| Package contents | Build and pack include both pinned knowledge sets, package metadata and license while omitting source tests and the standalone Drama Dashboard |

Current deterministic result: 10 test files and 33 tests passing.

## Native DSH Web audit

`pnpm test:dsh` creates an isolated DSH installation and profile, packs `@oh-story/dsh`, installs the tarball through `dsh plugin --profile web add`, and starts the official Web UI. It copies the pinned public demo projects from Oh Story (`让你管账号，你高燃混剪炸全网`) and Drama Skills (`善意不结账`) into temporary workspaces; their source repositories, commits and paths are recorded in `scripts/demo-fixtures/sources.json`. The Chrome pass verifies:

- 13 Oh Story Skills and 10 Drama Skills in the Session catalog;
- Session-scoped workspace reads, a 20-writer atomic CAS race, stale-write rejection and path-traversal rejection;
- invalid project metadata isolation without taking down the workspace;
- published Browser module and official UI slot registrations;
- a real DSH Agent `write` tool call, incremental editor content, authoritative disk reconciliation and official tool-file navigation;
- 小说/短剧 navigation, recursive project directories, Markdown structure and JSONL structured rendering;
- blank-session mounting, Session-switch draft recovery, source editing, conflict isolation and saved-state behavior;
- ordered tree/editor/Chat geometry at desktop and 500 px widths, plus a Composer that remains fixed during long-message scrolling.

The same audited surface generates the README demos through `pnpm demo` (both), `pnpm demo:story`, or `pnpm demo:drama`. Demo commands require `DEEPSEEK_API_KEY`, use the real `deepseek-official` provider, wait for successful assistant turns, collapse the DSH navigation rail, and record the complete tree/editor/Chat surface. The API key is process-only and is redacted from captured failure logs.

## Real DeepSeek observation

The release test used `deepseek-official/deepseek-v4-flash` against the packed plugin:

- `story-review` completed with 3 `oh_story_role` calls and 18,901 durable Session events;
- `short-drama-review` completed with 7,499 durable Session events;
- both sessions produced durable assistant output;
- the combined fiction/short-drama project digest remained unchanged;
- the API credential did not appear in captured DSH logs.

Event totals are observations, not fixed assertions.

## CI workflows

- `.github/workflows/ci.yml`: Ubuntu quality gate, macOS/Windows portability, then packaged DSH Web integration.
- `.github/workflows/real-provider.yml`: manual paid real-provider test; cleanly skips when the Secret is absent.
- `.github/workflows/release.yml`: tag/manual release candidate gate and `.tgz` artifact upload; npm publication remains an explicit external action.

## Commands

```bash
pnpm verify
pnpm test:dsh
pnpm verify:release
DEEPSEEK_API_KEY_FILE=/path/to/key pnpm test:dsh:real
DEEPSEEK_API_KEY=... pnpm demo
pnpm pack:release
```
