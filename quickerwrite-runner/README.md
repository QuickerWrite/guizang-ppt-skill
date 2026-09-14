# QuickerWrite Guizang 隔离 Runner

## Template selection and presentation chrome

`theme` accepts `swiss`, `classic`, `indigo`, `forest`, `kraft`, and `dune`.
Explicit choices take precedence over title-based automatic selection. Classic
palettes are loaded from this repository's `references/themes.md`. Optional
`theme_color` and `font_name` customize accent and typography. Choices are fixed
for a generation session; explicit slide backgrounds/content remain authoritative.
Generated slides do not include runner branding or automatic page-number stamps.
Source offers and license notices remain available outside presentation content.

## Incremental page protocol (runner v3)

POST /v1/jobs accepts protocol_version=1.0, incremental=true, a stable task_id,
planned_slides and the current ordered slides. The first request fixes the session
theme. Each page has a content revision; unchanged pages reuse engine-owned cached
render output. Requests for the same task are serialized. Cache files survive runner
restart. A changed page invalidates only that page; finalization reuses the last
published file when no content changed.

GET /v1/jobs/{id} exposes ordered pages entries with type=page_ready, page,
revision, reused, sequence and download_url. GET /v1/jobs/{id}/pages/{page} serves
an immutable cumulative snapshot ending at that page. Cached Dashi pages have no
new snapshot URL; their output is included in the job's assembled PPTX. Page events
are emitted only after native page rendering/persistence succeeds.

The health response advertises capabilities.incremental_pages and page_cache.
The implementation remains in this AGPL fork. No Django models, user records,
storage credentials or QuickerWrite source modules are imported. The public JSON
protocol and returned artifacts are the only integration boundary. Modified source
is included in the existing /source/archive offer.

Runner 始终保留在 Guizang 的 AGPL-3.0 仓库中，对外提供 QuickerWrite 中立 JSON
v1 协议。QuickerWrite 将本仓库克隆到 `api/ppt_engines`，由 Django API 启动链
自动托管；部署者无需单独启动，也不填写 Runner URL。商业核心只通过固定内部
HTTP 端点调用，不导入 Guizang 模板、提示词或运行时代码。

## 本 fork 的修改

- 增加异步中立 v1 作业提交、轮询和带鉴权的产物下载。
- 增加可选 HMAC-SHA256 请求认证和五分钟防重放窗口。
- 生产镜像只保留两套 HTML 模板、本地 Motion 运行时、预览、许可、源码文件和
  Runner；Agent 安装器、开发验证器、示例及截图专用资源不进入镜像。
- 将 Motion 内联进每份 HTML 产物，离线文件不依赖旁路资源或 GitHub CDN。
- 预览只开放 QuickerWrite 实际声明的三个 ID。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `POST` | `/v1/jobs` | 提交中立 v1 演示文稿任务 |
| `GET` | `/v1/jobs/{id}` | 查询任务状态 |
| `GET` | `/v1/jobs/{id}/artifacts/presentation` | 下载 HTML 演示文稿 |
| `GET` | `/v1/previews/{showcase,editorial,swiss}` | 读取仓库本地预览 |
| `GET` | `/source`、`/source/archive` | 提供 AGPL 对应源码 |

以下独立容器只用于此 AGPL 仓库的开发调试，不是 QuickerWrite Compose 中的独立
服务：

```bash
docker build -f quickerwrite-runner/Dockerfile -t guizang-ppt-runner:local .
docker run --rm -p 127.0.0.1:5801:8080 \
  -e QW_RUNNER_SHARED_SECRET=change-me \
  guizang-ppt-runner:local
```

本地预览来自仓库资源，不依赖 GitHub 图片；对应源码通过 `/source` 和
`/source/archive` 在本机提供。当前 Runner 只输出 HTML。QuickerWrite 通过中立
DTO 发送标题、页面角色、要点和演讲备注，Guizang 专属模板与提示词不会进入
QuickerWrite 进程。
