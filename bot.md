# Mia Agent Bot 项目目标与进展档案

> 本文件是 Mia Agent Bot 的长期目标、架构决策、交付记录和待办事项的共享进度源，供 `Agent Bot`、`处理 Bot 私聊` 和 `Bot 群聊` 任务共同维护。
> 最后同步：2026-09-05（Asia/Shanghai）

## 维护规则

- 开始工作前先阅读本文件，完成关键里程碑后更新对应模块。
- 只把已经验证的结果标记为完成；正在修改但尚未验证的内容保留为进行中。
- 更新进展时记录验证方式，例如测试、构建、截图检查或生产探针。
- 不在本文件记录 Bot Token、API Key、内部服务密钥或其他敏感信息。
- 多个任务同时工作时，各自只修改负责的模块；涉及共享文件时先确认当前工作区状态。

## 产品定位与长期目标

Mia 是面向 Telegram 生态的娱乐型 AI 助手。用户应能像和真人秘书聊天一样，直接使用自然语言提出需求；命令只作为快捷入口，不应成为主要交互方式。产品不以办公自动化为主线，重点是个人创作、轻量娱乐和群聊气氛互动。

Mia 当前复用 APIMaster 的账号、API Key、模型目录、计费和模型路由能力，但保持独立代码仓库与服务边界。APIMaster 对 Mia 来说是外部能力服务，而不是需要深度耦合的业务框架。用户既可绑定已有 APIMaster 账号，也可通过 Telegram 直接创建无邮箱账号并长期登录；系统不生成虚假邮箱，后续可由用户补绑真实邮箱。

长期产品由三个可独立演进的模块组成：

1. Mini App：账号状态、聊天/图片/视觉/视频模型选择及后续个人设置。
2. 私聊助手：连续聊天、生图、改图、视频和后续 Agent 能力。
3. 群聊主持人：群聊问答、上下文、总结、群记忆、小游戏和社群互动。

聊天、图片、视频、模型目录、任务状态和用量控制属于共享能力，由私聊和群聊共同调用。模块之间通过明确的服务与存储接口连接，避免把 Telegram 接入、模型调用、Mini App 页面和业务场景堆在同一层。

### 当前阶段目标

先跑通并稳定维护以下最小闭环：

1. 所有 Telegram 用户都可以使用文字聊天；已绑定用户使用自己的 APIMaster Key，未绑定或无可用 Token 的用户使用 Mia 的受限免费文字凭证。
2. 用户可以从 Telegram 打开 Mini App，查看实际可用模型并保存聊天、图片和视频偏好。
3. Bot 在群里由 `@Mia` 或回复 Mia 显式唤醒；唤醒后短时间内智能判断后续消息是否需要继续介入，同时安静采集它实际收到的群消息，为上下文和总结能力建立数据基础。
4. 所有能力可以独立测试、部署和回滚，不在代码或进度文档中保存用户密钥。

## 当前架构

```text
Telegram
    |
    v
APIMaster new-api
    - 接收 Telegram webhook
    - 处理 Telegram/APIMaster 账号绑定
    - 按 Telegram 用户解析可用 API Key
    - 提供 Mia 可用模型目录
    - 使用内部密钥把 Update 转发给 Mia
    |
    v
Mia (Node.js / TypeScript / Fastify / Grammy)
    - Telegram 消息响应策略
    - 调用 APIMaster 模型接口
    - Mini App API 和静态页面
    - SQLite 用户设置、私聊和群聊上下文
```

主要代码目录：

- `Mia/`：Bot、Mini App、用户设置和 APIMaster 客户端。
- `newapi/new-api/`：Telegram webhook、账号绑定、Key 解析和模型目录。

## 当前生产基线

| 组件 | 当前基线 | 状态 |
| --- | --- | --- |
| Mia | `1eb153a` | Node.js 20、PM2 运行，包含消费级 Mini App、连续上下文、长期记忆、私聊用户画像引导、群聊上下文压缩、精简版专用群聊总结、结构化 Telegram 回复、群聊唤醒后智能连续跟进、媒体与贴纸能力、Responses 自动 Web Search、开发者 Debug 控制台和 Telegram Bot 深链登录确认 |
| APIMaster new-api | `9130c1d` | GHCR 镜像蓝绿部署，提供 Telegram 用户 Key 解析、规范化 Mia 模型目录、产品名和 Debug 身份解析 |
| APIMaster Web | `7768f70` | Next.js PM2 双实例运行，提供 Telegram 登录与 TG-only 账号、登录态校验、Lisa 白名单和 Mia Debug 安全代理 |
| Mini App | `/mia/` | 已由 Nginx 公开，Telegram 默认菜单按钮 `Mia` 已配置 |
| 持久化 | `/var/lib/mia/mia.sqlite` | schema v2，保存用户模型设置与分作用域的会话数据，WAL 模式 |

生产环境只保存运行所需密钥，不把 Bot Token、API Key 或内部服务密钥写入 Git、日志摘要或本文件。当前仍缺少真实 Telegram 客户端对 Mini App、连续聊天、长期记忆和媒体生成的最终人工验收。数据库已由本版迁移到 schema v2；`57ca489` 及更旧的 Mia 版本不能直接读取该数据库，今后回滚必须使用支持 schema v2 的版本或同时恢复数据库快照。`9fff043` 发布前已创建独立 SQLite 备份。

## 已交付能力

### 基础消息链路

- [x] Telegram webhook 由 `new-api` 接收并转发给 Mia。
- [x] `new-api -> Mia` 使用独立内部密钥鉴权。
- [x] Mia 使用 Grammy 处理 Telegram Update。
- [x] 私聊文字消息可以调用 APIMaster 聊天模型。
- [x] 群聊由 `@Mia` 或回复 Mia 显式唤醒，唤醒后的后续消息按需智能跟进；`/summary` 和明确总结短语可直接触发群聊总结。
- [x] 通过 Telegram 用户 ID 查找已绑定的 APIMaster 账号和可用 Key。
- [x] 未绑定或无可用 Token 的用户可在私聊和群聊使用免费 `gpt-5.4` 文字聊天；禁用账号和服务故障不兜底。
- [x] 免费凭证只用于文字回复、意图路由和上下文整理，图片理解、生图、改图和视频始终使用触发者自己的 Key。
- [x] 生产环境已经完成过基础消息链路部署和探针验证。

### 当前默认模型

| 能力 | 默认模型 ID |
| --- | --- |
| 聊天 | `grok-4.5` |
| 图片 | `gpt-image-2` |
| 视频 | `MiniMax-H3`（生产目录实际 ID；配置兼容名为 `minimax-h3`） |

## Mini App 第一阶段

负责人：`Agent Bot` 任务。

- [x] Telegram Mini App `initData` 服务端验签骨架。
- [x] SQLite 用户模型偏好存储骨架。
- [x] Mini App 设置 API 骨架。
- [x] 聊天调用开始读取用户选择的聊天模型，并保留默认模型回退。
- [x] APIMaster 内部模型目录接口已经写入工作区。
- [x] 模型目录按 `chat`、`image`、`video` 分类的服务端逻辑已经写入工作区。
- [x] React + Vite Mini App 页面骨架已经写入工作区。
- [x] 25 个静态语言包已经写入工作区，包含 RTL 语言支持计划。
- [x] 完成 Mini App 页面交互和视觉检查。
- [x] 完成接口契约测试、设置存储测试和旧测试迁移。
- [x] 完成 Mia 全量测试、类型检查、Lint 和生产构建。
- [x] 完成 `new-api` 相关 Go 测试。
- [x] 提交并推送 Mia 与 `new-api` 的当前改动。
- [x] 部署 Mini App，并配置 Telegram 菜单入口。
- [x] 将 Mini App 重做为面向用户的个人助理设置页，并从 Mia 头像提取暖色视觉元素。
- [x] 模型名放大并右对齐；模型选择使用 Bottom Sheet，选择后立即保存，不再要求点击单独的保存按钮。
- [x] 模型 ID 大小写不敏感匹配并保存目录规范写法，`minimax-h3` 可正确对应 `MiniMax-H3`。
- [x] 视觉模型只在生产目录提供显式视觉能力元数据时显示，避免展示不可用占位项。
- [ ] 完成真实 Telegram 用户端验收。

当前生产状态：`cc9f105` 的 Mini App 视觉与交互已由 `9fff043` 继续承载，模型目录规范化提交 `d88afd5` 已完成 new-api 蓝绿发布。Telegram 菜单入口指向 `https://apimaster.ai/mia/`，真实 Telegram 客户端点按、自动保存设置和发送消息仍待用户验收。

生产模型目录只展示用户现有 Key、分组和启用通道交集中实际可调用的模型。当前只读探针可见 `Nano Banana 2`、`GPT Image 2` 两个图片模型，以及推荐视频模型 `MiniMax H3`；`Nano Banana` 和 `Nano Banana Pro` 的分类与产品名映射已经实现，但生产通道/分组尚未使其实际可用，因此不会在 Mini App 中虚假展示。

当前能力边界：聊天、图片、视觉和视频模型偏好均已接入生产实现。媒体执行链路、连续上下文和长期记忆已经部署，但尚未完成真实 Telegram 媒体生成、多轮图片追问和 10 轮记忆整理验收。

### Telegram Bot 深链登录（已部署，待真实客户端验收）

- [x] APIMaster 登录/注册页的 Telegram 入口改为直接打开 `t.me/apimasterai_bot?start=login_<一次性码>`；不再加载 Telegram 网页组件、弹出手机号授权页或显示入口加载转圈。
- [x] 一次性码只在 APIMaster 保存哈希，5 分钟有效；确认、完成和已消费状态均由服务端原子更新，重复 Bot `/start` 只对同一 Telegram 用户幂等确认，浏览器完成链接只能使用一次。
- [x] Mia 仅在私聊处理 `/start login_<码>`，先通过内部服务鉴权向 APIMaster 确认 Telegram 身份，再发出原生“立即登录 / Log in now”内联按钮；该启动载荷不进入翻译、意图路由或大模型。
- [x] 最终网页回跳复用现有 TG-only 账号创建、账号冲突校验、new-api 控制台会话、Telegram 绑定、显示名同步、试用风控和 APIMaster Session Cookie 链路；不修改或重启 new-api。
- [x] 本地验证：Mia 267/267 测试、ESLint、前后端 TypeScript、生产构建；APIMaster Telegram 登录签名回归测试、ESLint、生产构建与差异检查通过。
- [x] 生产验证（2026-09-05）：APIMaster `08b95e5` 和 Mia `2499e2e` 均按精确 GitHub SHA 发布；APIMaster 登录页返回 `200`，未登录认证接口返回预期 `401`，深链入口实际生成 `t.me/...start=login_...`，内部确认接口未授权返回 `401`，Mia `/health` 返回 `200`、PM2 `online`；APIMaster 既有只读生产冒烟 21/21 通过，new-api 未修改、未重启。
- [x] 深链确认路由修复（2026-09-05）：Mia 改为调用 `/api/auth/telegram/deep-link/confirm`；APIMaster Web 路由提交 `92041e0`，Mia 客户端提交 `2b8e602`（生产 Mia release 已包含该修复）。公网带内部鉴权的空请求返回 `400`，确认请求已到达 APIMaster Web，不再被错误转发到 new-api 的 `404` 路径；Mia 健康检查 `200`、PM2 `online`，APIMaster 只读生产冒烟 `21/21` 通过，new-api 未修改、未重启。
- [x] 身份服务地址修复（2026-09-05）：发现 Mia 的 `baseUrl` 和 `internalBaseUrl` 均为 new-api `127.0.0.1:3001`；深链确认改为强制使用独立的 `APIMASTER_IDENTITY_BASE_URL=127.0.0.1:3000`，提交 `901539b` 已发布。确认失败现在区分真实过期和服务暂时不可用，并只记录 Telegram 用户 ID 与 HTTP 状态。生产生成测试码后，经运行中的身份服务确认返回成功、数据库状态为 `confirmed`；Mia 健康检查 `200`。new-api 未修改、未重启。
- [x] 已绑定账户登录修复与文案更新（2026-09-05）：Telegram 身份已绑定 APIMaster 用户时，控制台侧遗留的 Telegram 字段冲突不再拦截 APIMaster 登录；新 TG-only 账号仍保留控制台绑定失败保护。网页登录回调和 Bot 深链完成回调使用同一规则。APIMaster 修复提交 `6059b7f` 已包含在生产 Web `4c5941`，服务器生产构建、PM2 滚动 reload 与本机 HTTP `200` 已验证。Mia 确认消息更新为“马上开始 AI 之旅 / 点击按钮，马上登录”，按钮为“登录 APIMaster”；提交 `0eeb4e7` 已包含在生产 Mia `1eb153a`，原子发布健康检查通过，上一版 release 保留为回滚点。new-api 未修改、未重启。
- [x] 深链复用旧账号与误建账号清理（2026-09-05）：移除 Bot 深链对旧 Telegram 绑定查询的跳过逻辑，统一先查 APIMaster 绑定和历史 `new-api` Telegram 绑定，确认后才创建 TG-only 账号。生产提交 `7768f70` 已构建并发布，服务器 Web PM2 滚动 reload 后 HTTP `200`；验证旧邮箱账号与 `new-api` 绑定一致，删除本次误建的唯一无邮箱 TG-only APIMaster 账号及其未领取体验记录，未发现对应控制台镜像，旧账号与 `new-api` 均未删除或修改。
- [x] 解绑联动修复（2026-09-05）：`new-api` 提交 `a7a7fc8` 已按精确 SHA 构建 GHCR 镜像并完成蓝绿发布；点击控制台“解绑”时，同时清除 `new-api` 的 Telegram 入群验证和 APIMaster `user_social_bindings(provider=telegram)` 登录绑定，不删除邮箱账号、余额、API Key 或订阅。生产 `api.apimaster.ai/api/status` 与 `apimaster.ai/api/status` 均返回 `200`，版本探针为 `a7a7fc8e...`，新实例健康、旧实例已排空停止；APIMaster Web 与 Mia 未修改、未重启。
- [x] Mia 新用户绑定路径修复（2026-09-06）：Mia 的图片、视频和后台媒体任务在 Telegram 未绑定时，统一跳转 `/api/auth/telegram/deep-link/start?next=/mia/`，不再进入仅供已登录网站用户完成社群权益验证的 `/connect/telegram`。生产提交 `a58eb33` 已按精确 SHA 原子发布；实测入口 `307` 至 `t.me/apimasterai_bot?start=login_...`，Mia 健康检查正常、PM2 `online`/0 重启。`new-api` 和网站侧入群验证流程均未改动。
- [ ] 使用真实 Telegram 客户端走完“网页点击 -> Telegram 打开 Bot -> Start -> 立即登录 -> 浏览器登录完成”人工验收，并检查已绑定账户、新 TG-only 账户和重复点击的体验。

## 私聊助手

### 已有能力

- [x] 接收私聊文字。
- [x] 私聊消息使用独立 `chat_id` 空间持久化，不与用户全局记忆或群聊空间混用。
- [x] 根据 Telegram 用户解析 APIMaster Key。
- [x] 调用聊天补全并拆分过长回复。
- [x] 基础错误提示。
- [x] 通用五类意图路由：`chat`、`image_generate`、`image_edit`、`vision_qa`、`video_generate`。
- [x] 免费用户的媒体意图在付费任务创建前拦截，并按未绑定、无 Token、余额不足显示注册绑定、创建 Token 或充值入口。
- [x] Telegram 斜杠面板注册 `/image`、`/video`、`/sticker`、`/new`、`/summary`；`/image`、`/vision`、`/video`、`/sticker` 为确定性入口，自然语言优先使用触发者自己的 APIMaster Key 调用 `gpt-5.4`，仅未绑定或无可用 Token 时使用免费文字凭证。
- [x] 已绑定用户的 `chat` 和自然语言 `vision_qa` 可由同一次 `gpt-5.4` 调用返回最终文字；免费用户的所有视觉、图片和视频意图会在媒体调用前拦截。
- [x] 图片、图片文档和相册持久化；私聊当前图片保留 30 分钟。
- [x] 文生图、多图改图、看图问答和文生/图生视频执行框架。
- [x] 视频 10 分钟未扣费确认草稿，可调整时长和画幅。
- [x] 图片与视频共享每用户 3 个在途任务，使用 SQLite 原子检查和幂等键。
- [x] 图片生成和编辑遇到可重试的提交错误时由服务器立即自动重试 1 次；余额、账号、Token 和明确客户端参数错误不重试，视频仍保持确认后只提交一次。
- [x] 后台 worker 恢复未完成任务；已进入不确定提交状态的任务绝不自动重提。
- [x] Telegram photo/video/document 回传、原文件下载、图片分享到 X 和超大视频临时下载代理。

### 待开发

- [x] 连续对话上下文、自动测试和生产部署。
- [x] `/new` 和 `/forget` 清除当前会话上下文；更完整的会话管理待开发。
- [ ] 语音及非图片文件输入。
- [ ] 完整生产级 25 语言 Bot 状态/错误文案人工校对。
- [ ] 普通聊天的用户级速率限制；媒体已有每用户 3 个在途限制。

### 用户长期记忆与连续上下文（已部署，待真实 Telegram 验收）

五层上下文已经按已确认方案接入：Mia 系统规则、当前会话信息、用户长期记忆、较早对话的滚动摘要、最近原始对话与当前消息。私聊、群聊和 Topic 按原有作用域隔离；用户长期记忆只注入私聊，不向群聊暴露。

- [x] 最近原始消息按从早到晚排列，并带显式轮次、消息 ID、发送者、回复关系和“当前消息”标记。
- [x] 私聊活动图片及当前/明确回复的图片可携带实际像素；群聊近期图片先以消息 ID、发送者、类型、时间和来源作为候选，只有视觉回答或媒体执行真正需要时才下载。
- [x] 每 10 轮成功文字私聊在 Mia 完成回复后异步触发一次；媒体生成、视觉问答、失败请求和群聊不计入长期记忆轮数。
- [x] 同一次 `gpt-5.4` 后台调用接收已有完整长期记忆、已有滚动摘要和最近 10 轮对话，返回整理后的完整最新记忆与完整摘要。
- [x] 长期记忆只保留称呼/身份、长期偏好、稳定习惯和长期目标；代码层执行 JSON Schema、条数/长度、明显敏感值和完全重复校验。
- [x] 长期记忆整体替换、摘要新增和 10 轮处理水位在同一个 SQLite 事务中提交；模型失败时不标记水位，下次仍可重试。
- [x] 所有模型指令集中在 `Mia/src/prompts.ts`，包括 Mia 身份、意图路由和记忆/摘要整理 Prompt，便于逐场景 Review。

当前实现边界：单次最多提供 10 张图片候选或图片输入；时区没有可靠 Telegram 来源时明确传 `null`；首版不在群聊中自动提取个人长期记忆。

### 通用结构化回复与 Telegram 展示（已部署）

- [x] 新增 `MiaResponse v1` 严格 JSON Schema，统一承载短标题、段落、列表、事实项、通用多列表格、引用、折叠补充、代码和受控动作 ID；模型不直接生成 HTML、Markdown、URL 或 callback data。
- [x] 普通聊天、实时搜索、看图问答、群聊总结和其他长回答复用同一结构化 `reply` 与展示层；简单寒暄仍保持一段自然文本，复杂内容才按语义使用标题、列表、引用、表格或折叠内容。
- [x] Telegram Renderer 把受控结构映射为原生 Rich Message blocks，统一处理长度、安全和回复关系；投递失败时按 Rich Message → 安全 HTML → 纯文本降级，临时生成状态继续使用可编辑的普通消息。
- [x] 群聊总结复用同一 Renderer。用户可见结构改为”具体短标题、1 至 5 条重点、必要的结论/待办/未决事项、自然收束句”，不再展示”概览、主要话题、覆盖说明”等后台报表栏目。
- [x] 用户只发送图片且没有说明时，Mia 提供”看懂这张图 / 修改图片 / 做成视频”按钮；按钮跟随语言、只允许原发送者操作、重复点击幂等，并通过 Force Reply 进入现有媒体流程。
- [x] Mia 的固定自我介绍使用品牌图片和无列表圆点的精简 caption，并在回复下方附带两列功能面板；生成图片和生成视频在当前聊天或 Topic 进入现有流程，制作贴纸在私聊中处理，模型设置进入现有 Mini App，图片投递失败时降级为纯文字且仍保留按钮。
- [x] 已覆盖天气样式、长总结、HTML 注入、Markdown 清理、转义后超长分段、HTML 发送失败降级、图片按钮权限及重复点击。合并最新 GitHub 媒体修复后，185/185 测试、ESLint、前后端 TypeScript、生产构建和 `git diff --check` 通过（2026-09-03）。

#### Telegram 样式优化分析（2026-09-04）

**竞品对比观察**：
- 竞品 `@mira` 在 Telegram 回复中使用了表格样式，有完整边框、背景色块、清晰对齐，视觉层次明显
- 当前 Mia 的 `facts` 类型渲染为纯文本 `<b>标签：</b> 内容`，缺乏视觉容器

**技术调研结果（已由 Bot API 与真实客户端验证）**：

1. Mira 的表格不是图片或 Mini App，也不是 Telegram 自动识别普通 `|` 文本；实际能力来自 Bot API 10.1+ 的原生 Rich Messages。
2. `sendRichMessage` 支持标题、段落、列表、引用、折叠内容和真正的 `table` block；真实 Mia Bot 样板已返回 HTTP 200，并在用户 Telegram 客户端正确显示大标题、表格边框、背景分行、引用和留白。
3. grammY 当前版本已经包含 `sendRichMessage`、`Message.RichMessageMessage` 和完整 Rich Block 类型，无需升级依赖。
4. 普通 `|` 文本只应作为 HTML/纯文本降级时的可读形式，不能当作原生表格实现。

**通用实现结论**：

- 模型继续返回受严格 JSON Schema 约束的语义结构，不直接控制 Rich HTML、按钮、链接或 callback。
- 服务端统一把结构映射为 Telegram 原生 blocks；`facts` 映射为紧凑两列表格，`table` 支持 2 至 8 列通用对比数据，其余内容按语义映射为标题、段落、列表、引用、折叠补充或代码。
- 天气、搜索、总结、对比、视觉问答等场景不维护专用卡片，统一复用同一 Prompt 约束、Schema、Renderer 和投递降级链路。
- 接收的 `message.rich_message` 会提取成可读文本并按原会话作用域进入上下文，转发来的 Mira 富消息不再被过滤。
- Debug 保存模型原始响应、最终 Rich blocks、实际发送方式、分段数及降级原因。

## 群聊主持人

### 已确认的产品原则

- [x] Bot 应采用“全量监听、选择性存储、克制回复”的模式。
- [x] 默认由 `@Mia`、回复 Mia 或命令触发；显式唤醒后的有限窗口内可调用模型判断是否需要继续发言，明确的中英文群聊总结短语是受控例外。
- [x] Telegram 不提供 Bot 可任意读取的历史消息接口；上下文必须由 Mia 从收到 Update 后自行保存。
- [x] 关闭 Privacy Mode 或让 Bot 成为管理员，是接收普通群消息并建立上下文的前提。
- [x] 群组 Topic 应通过 `chat_id + message_thread_id` 隔离短期上下文。
- [x] 上下文计划分为最近消息、回复链、阶段摘要和长期群记忆四层。
- [x] 群管理员应能配置保留期限并清除群上下文。

### 第一阶段建议范围

- [x] 采集 Bot 实际收到的普通群文字消息，不因“不响应”而丢弃上下文。
- [x] 保存基础群资料、已见成员、文字消息、回复关系、Topic 和文字编辑记录。
- [x] 在 `@Mia` 或回复 Mia 时加载当前群或 Topic 的最近消息、回复关系和相关图片。
- [x] 群聊上下文使用独立选择策略：从最近 200 条候选中选同一群或 Topic 最近 20 条，再补触发者最近 8 条公开发言；当前消息和明确回复链优先，最终按时间排序并控制在约 16,000 tokens。
- [x] 群聊媒体候选最多 10 张，只自动考虑最近 30 分钟且已进入上述上下文的图片；选择顺序为当前消息、明确回复、触发者近期图片、同一 Topic 其他成员近期图片。明确回复可引用任何成员发送的图片且不受 30 分钟限制。
- [x] 群聊历史媒体候选只向意图路由提供元数据；当前附件和明确回复可为一次视觉回答携带像素。路由返回经过服务端白名单校验的 `media_message_ids`，图片/视频任务选定后再从 Telegram `file_id` 下载，候选不明确时继续追问。
- [x] 普通群读取群级公开长期记忆；Topic 同时读取群级公开记忆与当前 Topic 记忆；任何用户私聊长期记忆都不会注入群聊。
- [x] 群内媒体可由命令、`@Mia`、回复 Mia、回复媒体或唤醒窗口内被智能判断为明确请求的消息触发。
- [x] 媒体结果回复原消息并保留 `message_thread_id`；回复相册任意图片可恢复完整相册。
- [x] 群媒体默认开启，管理员可用 `/media_on`、`/media_off` 切换。
- [x] 群媒体费用使用触发者 APIMaster Key 和触发者模型偏好。
- [x] `/summary`、明确中文总结短语和英文 `summarize/recap` 使用独立群聊总结链路；模糊表达可由意图路由进入同一服务。
- [x] 后台滚动摘要同步提取讨论主题、结论、待办事项、负责人、未决问题和重要链接。
- [ ] 群级设置：模型、上下文长度、语言、安静时间和数据保留策略。
- [ ] `/forget` 或管理页面清除群记忆。
- [x] 未绑定用户可免费文字聊天；媒体能力由触发者自己的 APIMaster Key 和余额承担。

### 存储底座

- [x] 用户全局空间：以 `telegram_user_id` 隔离用户资料、模型设置和用户级长期记忆。
- [x] 私聊空间：以 `chat_id` 隔离私聊消息、摘要和长期记忆。
- [x] 普通群空间：以 `chat_id` 隔离群消息、摘要和长期记忆。
- [x] Topic 空间：以 `chat_id + message_thread_id` 隔离 Topic 消息、摘要和长期记忆。
- [x] 消息唯一键使用 `chat_id + message_id`，允许不同聊天中相同的 Telegram 消息 ID 共存。
- [x] 提供最近消息、回复链、最新摘要、长期记忆和按会话清除的存储 API。
- [x] 普通群文字在响应策略判断前入库；休眠状态下未 `@Mia` 的消息仍存储但不触发模型。
- [x] `edited_message:text` 更新原消息存储，不触发新的 AI 回复。

### 群聊唤醒后的智能连续跟进（已部署，待真实群聊验收）

- [x] `@Mia` 或直接回复 Mia 会立即处理并唤醒当前作用域；普通群按 `chat_id`、Topic 按 `chat_id + message_thread_id` 严格隔离。
- [x] 唤醒后，所有成员的后续文字及带 caption 图片进入选择性意图判断；成员闲聊、感谢、表情式回复、无明确请求的陈述和无法确认是对 Mia 说的话默认静默观察。
- [x] 自动消息按作用域执行 2 秒 trailing debounce，首条消息最多等待 5 秒；同一作用域串行、不同作用域可并行，新的显式唤醒会取消尚未执行的自动批次。
- [x] 只有显式唤醒或成功发送回复、澄清、错误提示、媒体任务状态后才刷新有效期；连续 10 分钟没有有效处理即静默休眠，观察、路由失败和发送失败均不续期。
- [x] 每个群或 Topic 的固定 10 分钟窗口最多执行 30 个自动判断批次；显式唤醒不受此限制。状态和限流计数保存在 SQLite，服务重启后语义不变。
- [x] 自动判断与普通文字回复复用 Mia 公共 `gpt-5.4` 凭证，不扣唤醒者或发送者额度；图片、视频和视觉生成仍解析实际请求者自己的 APIMaster Key、模型偏好、余额并沿用确认流程。
- [x] 自动跟进拆为轻量参与判断与独立文字回答两阶段链路；紧邻 Mia 回复的高置信短追问（如天气回答后的“后天呢？”）由服务端直接识别承接关系，避免公共路由超时造成漏接。参与判断关闭 Web Search，确认介入后才显示 typing；公共回答失败时对已确认追问发送可见的安全失败提示，不再伪装成“不需要回复”。
- [x] 自动判断前不发送 `typing`；只有决定介入后才显示状态。纯图片、无 caption 图片和当前不支持的文件只作为上下文保存，编辑消息只更新存储。
- [x] 路由输出必须从当前批次选择回复目标；跨批次或伪造消息 ID、无效 Schema、低置信度和模型错误在自动模式下均静默处理。

生产发布 `57772e6` 已完成精确 SHA 部署；服务器现场构建、内部 `/health`、PM2 `online`/零重启、SQLite 完整性、新状态表 schema、空错误日志、3 版本保留及 APIMaster 公共状态探针均通过（2026-09-03）。真实 Telegram 群中的分段补充、成员闲聊静默、成功处理续期、10 分钟休眠和 Topic 隔离仍需客户端人工验收。

### 私聊翻译模式（已部署，待真实 Telegram 验收）

- [x] `/tr` 进入、`/ntr` 退出；翻译模式只处理私聊文字，不进入普通意图路由或媒体流程。
- [x] 不固定语言对：用户语言取 Telegram 系统语言；`/tr 日语`、`/tr Spanish` 等可设置任意目标语言。无参数时默认目标为英语，英文用户默认中文。
- [x] 翻译 Prompt 独立存放为 `mia.translation-mode`，自动识别来源语言，在当前语言对之间互译，只输出译文。
- [x] 翻译会话保存到 SQLite，30 分钟无操作自动退出；服务重启后仍按数据库状态判断。
- [x] 翻译语言对由两个可独立编辑的语言按钮组成，左右展示位置不影响双向互译；同语言选择会交换位置而不生成重复语言对。选择器覆盖 Mia 已本地化的 25 种语言并双列分页展示；译文在 Telegram 原生复制按钮的 256 字符限制内提供复制入口。
- [x] 翻译输入和输出标记为 `translation`，不进入普通会话上下文和长期记忆整理，避免把他人内容提取为用户目标或偏好。
- [x] 本地验证通过：翻译状态过期、语言对切换、`/tr` 分流、普通路由不调用、复制按钮和 `/ntr` 退出。
- [x] 已补充验证：`translation` 消息从普通上下文查询中排除。
- [x] 生产发布 `c1e0749` 已完成精确 SHA 部署；`/health`、PM2、SQLite 完整性和 `mia_translation_sessions` 表检查通过（2026-09-05）。
- [ ] 真实 Telegram 私聊中验证中英、中俄互译、复制按钮和 30 分钟自动退出。

存储底座提交：`f69dd98`；Telegram 消息采集接入提交：`57ca489`。两者与 Mini App 共用同一个 `DATABASE_PATH` SQLite 文件，但通过表、联合主键和作用域约束逻辑隔离。`9fff043` 已把历史上下文、回复关系和相关图片接入生产模型请求。

### 群共享上下文（已部署）

- [x] 普通群和每个 Topic 使用独立摘要水位；General 与 Topic、不同 Topic 之间不会串用讨论内容。
- [x] 摘要水位后累计 50 条有效存储消息，或估算达到 12,000 tokens 时，在下一次绑定用户成功呼叫 Mia 后异步整理；未达到阈值只查询 SQLite，不调用模型。
- [x] 一次 `gpt-5.4` 调用同时返回完整最新滚动摘要和完整最新群/Topic 长期记忆，不再为长期记忆单独调用模型。
- [x] 群长期记忆只允许群规则、公开角色、长期项目、稳定群偏好、长期决定和流程；必须引用当前作用域内真实 `source_message_id`，并过滤明显敏感值和重复项。
- [x] 摘要、完整记忆替换和处理水位在同一个 SQLite immediate transaction 中提交；模型或事务失败时不推进水位。
- [x] 后台整理优先使用本次呼叫 Mia 的触发者 APIMaster Key；未绑定或无可用 Token 时使用仅限 `gpt-5.4` 的免费文字凭证。
- [x] Debug 请求新增“群聊整理”类型，并展示作用域、旧摘要、公开记忆、新增消息区间和整理结果。

### 专用群聊总结（已部署，待真实群聊验收）

- [x] 用户可见总结使用独立 `mia.group-summary` / `mia.group-summary-input` Prompt 和严格 JSON Schema，不复用普通聊天 Prompt 或后台群压缩 Prompt。
- [x] 普通群和 Topic 严格隔离原始消息与滚动摘要；Topic 只读继承群级公开记忆，任何用户私聊记忆都不会进入总结。
- [x] 默认读取摘要水位后的最近最多 300 条、约 24,000 tokens 原始消息，并排除当前总结请求；消息范围保留在 Debug 审计中，不再占用用户可见总结正文。
- [x] 每个用户可见条目必须引用真实消息；服务端丢弃伪造或跨作用域来源，并校验参与者 ID 与引用消息发送者一致。
- [x] 一次 `gpt-5.4` 调用同时生成用户可见总结、完整滚动摘要和当前作用域完整公开长期记忆；回复全部成功发送并落库后才原子推进水位。
- [x] 消息或 token 窗口截断、发送失败、模型失败、水位竞争或模型运行期间出现并发新消息时不推进旧水位，也不立即追加后台压缩调用。
- [x] Telegram 展示由服务端通过通用 `MiaResponse v1` Renderer 生成安全 HTML；以重点和自然收束组织内容，空栏目隐藏，所有分段独立闭合且不超过 4096 字符，并保留原群、原 Topic 和回复关系。
- [x] Debug 新增“群聊总结”类型，记录 Prompt、作用域、选中范围、截断、证据过滤、凭证来源和持久化结果，不记录 Key。

### 后续能力

- [x] 阶段摘要和长期群记忆（本地实现，待提交部署和真实群聊验收）。
- [ ] 新成员欢迎、群规则和 FAQ。
- [ ] 群日报或周报。
- [x] 群内图片可通过当前附件、明确回复或同一 Topic 近期上下文进入视觉、改图和图生视频链路。
- [ ] 群内非图片文件、链接和语音理解。
- [ ] 投票、提醒、小游戏和主动主持。
- [ ] 管理员可控的内容安全、广告和刷屏治理。

### 尚待产品确认

- [ ] 当前已使用触发者 Key；后续是否增加群主 Key、群级专用 Key 或群级预算。
- [ ] 普通群消息的默认保留期限，以及是否只保留摘要、不保留原文。
- [ ] Bot 是否必须成为管理员，还是仅要求关闭 Privacy Mode。
- [ ] 第一版是否支持 Telegram Topic。
- [ ] 第一版是否只处理文字，还是同时处理图片、文件和语音。
- [ ] 自动总结和主动提醒由谁开启，以及每日频率上限。

## 数据与隐私边界

- Bot 只能处理加入群后实际收到的消息，不能拉取进群前的完整历史。
- Telegram 通常不会把其他 Bot 的消息发送给 Bot。
- Telegram 不提供完整群成员列表；只能获取管理员、成员数量和指定用户状态等信息。
- Bot 拿不到用户手机号、邮箱或真实身份。
- 删除消息事件并不完整可靠，因此需要明确本地数据保留和删除策略。
- 任何群上下文存储都应向管理员和成员提供可理解的说明。
- 普通聊天与自然语言意图输入按五层结构携带上下文；原始消息按时间和轮次标记，最多携带 10 张经过校验和预处理的相关图片像素。
- 意图代理费用由触发者自己的 APIMaster Key 承担；Mia 不配置或持有独立的 `MIA_ROUTER_API_KEY`。
- APIMaster 用户 Key 仅发送给配置的 APIMaster origin，不会随外部媒体结果 URL 转发。
- 媒体日志禁止记录 Key、Bot Token 下载 URL、媒体正文和完整敏感提示词。

## 通用媒体框架（已部署，待真实 Telegram 验收）

- [x] `new-api` 模型目录向后兼容增加 `supports_vision`、`vision_recommended` 和规范化 `video_capabilities`。
- [x] 视觉能力只读取精确元数据标签，不按模型名猜测；只有能力元数据完整的视频模型可被 Mia 选择。
- [x] `minimax-h3` 在 Mia 暴露文生/图生视频、4–15 秒、`768P`、三种画幅及最多 10 张参考图。
- [x] 文生图调用 `POST /v1/images/generations/async` 并轮询 `/v1/tasks/:task_id`；参考图改图与 APIMaster 网页保持一致，调用同步 `POST /v1/images/edits`，单图使用 multipart `image`、多图使用 `image[]`，兼容 URL 与 base64 结果；同步改图使用独立 180 秒超时，避免通用 60 秒超时提前取消上游。
- [x] 视频调用 `POST /v1/videos`，轮询 `/v1/videos/:task_id`，成品读取 `/v1/videos/:task_id/content`。
- [x] 图片输入限制为最多 10 张、单张 10 MB、原始和预处理后各 30 MB；使用 Sharp 解码、方向修正、缩放，并按透明度输出 PNG/JPEG。
- [x] 通用 `mia_media_jobs`、输入表、待补充意图、视频草稿、当前私聊图片、群开关、媒体引用和分享/下载令牌已实现。
- [x] 草稿、任务、结果引用和令牌使用 10 分钟/15 分钟/60 分钟/7 天对应生命周期；清理保留任务审计行但移除过期媒体引用。
- [x] Telegram Inline 分享已取消；图片改为通过 7 天分享页直接唤起 X 发帖。
- [ ] 部署前给至少一个生产用户可用模型增加 `vision` 与 `vision-recommended` 标签。
- [x] 生产部署完成；端到端人工验收尚未执行。

## 交付里程碑

| 提交 | 仓库 | 已交付内容 |
| --- | --- | --- |
| `5eb8c92` | `lisaluoyf/Mia` | 最小 Telegram 文字聊天 Bot |
| `cdc2637` | `lisaluoyf/Mia` | 接收 new-api 转发的 Telegram Update |
| `f69dd98` | `lisaluoyf/Mia` | 用户、私聊、群聊和 Topic 独立作用域存储底座 |
| `35928f5` | `lisaluoyf/Mia` | Telegram Mini App、动态模型设置和多语言前端 |
| `57ca489` | `lisaluoyf/Mia` | 群聊普通文字与编辑消息静默采集接入 |
| `9b435e4` | `lisaluoyf/new-api` | Mia 内部模型目录和按模型解析用户可用 Key |
| `cc9f105` | `lisaluoyf/Mia` | Mini App 产品化视觉、模型选择自动保存、视觉偏好和模型 ID 规范化 |
| `d88afd5` | `lisaluoyf/new-api` | 模型目录大小写兼容、图片/视频能力元数据和面向用户的模型产品名 |
| `9fff043` | `lisaluoyf/Mia` | 五层连续上下文、10 轮长期记忆整理、集中 Prompt、自然语言媒体 Agent 和生产媒体执行链路 |
| `e2c48f7` | `lisaluoyf/Mia` | GitHub SHA 驱动的服务器构建、依赖缓存、健康回滚和 3 版本保留 |
| `24d938b` | `lisaluoyf/Mia` | 强制保留刚下线版本作为首选回滚目标 |
| `033e5e9` | `lisaluoyf/Mia` | 开发者 Debug 控制台、五层上下文快照、长期记忆审计和只读 Prompt Registry |
| `9130c1d` | `lisaluoyf/new-api` | 通过内部接口按服务端邮箱白名单解析 Debug 开发者与绑定 Telegram ID |
| `7d62618` | `RomaCredit/apimaster-workspace` | 登录态鉴权、Lisa 白名单、Mia Debug API 代理和页面入口保护 |
| `a298ac4` | `lisaluoyf/Mia` | 修正生产 Debug API 路由并完成可追溯发布 |
| `762c7bd` | `lisaluoyf/Mia` | 参考图改图切换到 APIMaster 网页同款 `/v1/images/edits` 同步链路 |
| `a124a56` | `lisaluoyf/Mia` | 私聊前 100 轮用户画像引导、25 种语言角色按钮、画像长期记忆和 Debug 审计 |
| `70c6774` | `lisaluoyf/Mia` | 群聊与 Topic 上下文压缩、公开群记忆、原子水位和管理员清除保护 |
| `2a684df` | `lisaluoyf/Mia` | 核心意图与文字回复迁移到 Responses、自动 Web Search 和 Debug 搜索审计 |
| `72acb20` | `lisaluoyf/Mia` | 未绑定媒体请求统一跳转 APIMaster 一键 Telegram 连接入口 |
| `588a5a8` | `RomaCredit/apimaster-workspace` | APIMaster Telegram 登录、TG-only 无邮箱账号、统一用户资料、邮箱补绑与体验卡身份兼容 |
| `b1d5573` | `RomaCredit/apimaster-workspace` | 修复 Telegram 公网回跳并加固验签、旧账号解析、IP 信任、错误反馈和邮箱验证码限制 |

## 当前验证状态

- Mia 测试：66/66 通过（2026-09-02），覆盖 Mini App、模型目录、媒体输入/任务、Telegram Update 幂等、四种上下文作用域隔离、Topic、回复链、消息编辑、五层上下文、图片轮次归属、10 轮长期记忆整理、事务提交、普通群消息静默采集和多语言键一致性。
- Mia 类型检查与 Lint：通过（2026-09-02），同时检查服务端和 Mini App 前端。
- Mini App 生产构建：通过（2026-09-02），Vite 成功生成 `dist/web` 静态包。
- Mini App 视觉检查：通过（2026-09-02），覆盖 390×844 简体中文、阿拉伯语 RTL 深色界面和 1024×768 英文；模型自动保存交互通过，未发现横向溢出。
- Mini App 生产部署：通过（2026-09-02），PM2 运行提交 `cc9f105`；内部健康检查、页面、新 JS/CSS、头像资源、安全响应头、伪造 `initData` 401 和 390px 线上宽度无溢出探针通过，主站冒烟检查 19/19 通过。
- Mini App 生产集成：通过（2026-09-02），模型目录原始能力可加载 40 个聊天、2 个图片和 7 个视频模型；`9fff043` 进一步只允许选择带完整生成参数元数据的视频模型，当前可选择 1 个视频模型。探针只读，未修改用户设置。
- Telegram 菜单入口：通过 Bot API 写入并回读确认，默认 `Mia` 按钮指向 `https://apimaster.ai/mia/`（2026-09-02）。
- `new-api`：`go test ./... -count=1` 全量通过；提交 `d88afd5` 已通过 GHCR 镜像和蓝绿流程部署，API 与 worker 均运行该提交对应镜像，新实例健康检查与公网冒烟通过，旧实例连接排空后停止（2026-09-02）。
- Mia 通用媒体与连续上下文：提交 `9fff043` 已部署到 `/srv/mia/releases/9fff043-context-media-20260902231500`。66/66 全量测试、ESLint、服务端与 Mini App TypeScript 检查、Sharp 冻结依赖安装、生产构建及 `git diff --check` 通过（2026-09-02）。
- Mia 生产探针：内部 `/health` 返回 200，PM2 在线且 0 次重启；合法 Telegram Mini App 签名可加载 40 个聊天、2 个图片和 1 个具备完整能力元数据的视频模型，当前无显式视觉模型；公开页面、JS/CSS 和头像均返回 200；SQLite 完整性为 `ok`，`mia_completed_turns` 和 `mia_media_jobs` 已创建；新进程无 warning/error（2026-09-02）。
- Mia GitHub 发版流程：提交 `24d938b` 已由生产服务器从 GitHub 拉取、并行构建并部署，两次完整发布均耗时 15 秒；健康检查和公网 Mini App 冒烟通过，刚下线版本保留为回滚目标，服务器已清理到 3 个 release，磁盘可用空间由约 285 MB 恢复到约 11 GB（2026-09-02）。
- `new-api` 媒体目录：`go test ./... -count=1` 全量通过，包含显式视觉标签与 `minimax-h3` 能力目录测试（2026-09-02）；目录部分已随 `d88afd5` 提交并部署，Mia 媒体执行链路已随 `9fff043` 部署。
- Developer Debug Console：Mia 69/69 测试、ESLint、服务端与前端 TypeScript、生产构建和 `git diff --check` 通过；new-api `go test ./controller ./router` 通过。桌面端 Requests/Memory/Prompts、五层展开、Prompt 跳转和 390×844 移动端无横向溢出已完成浏览器验收（2026-09-03）。
- Debug 三端一致性：Mia 本地、GitHub `main` 和生产 release 均为 `a298ac4`；new-api 均为 `9130c1d`，生产 API 与 worker 运行同一不可变镜像；APIMaster Web 均为 `7d62618`，PM2 两个实例在线。未登录访问 `/mia/debug` 会跳转到 `/login?next=/mia/debug`，未登录 Debug API 返回 401（2026-09-03）。
- Mia 参考图改图：`762c7bd` 已从 GitHub `main` 由生产服务器构建并发布；73/73 测试、服务端与 Mini App 类型检查、Lint、生产构建、内部健康检查和公网 `/mia/` 200 探针通过，PM2 在线且 0 次重启，服务器保留 3 个 release（2026-09-03）。
- Mia 私聊用户画像引导：提交 `a124a56` 已实现并随生产 `70c6774` 发布；只在私聊前 100 个成功轮次内寻找闲聊机会，最多主动询问两次且第二次至少间隔 20 轮。角色、称呼和主要目标写入用户长期记忆；群聊和 Topic 不读取或更新 onboarding 状态。隔离提交通过 93/93 测试、ESLint、前后端 TypeScript、生产构建和 `git diff --check`（2026-09-03）。
- Mia 群共享上下文：提交 `70c6774` 已独立提交、推送并部署；100/100 全量测试、ESLint、服务端与前端 TypeScript、生产构建和 `git diff --check` 通过；覆盖 50 条消息/12,000 tokens 双阈值、摘要与记忆单次模型调用、原子水位、跨 Topic 来源拦截、群记忆继承、触发者公开发言优先、个人记忆隔离和群清除管理员权限（2026-09-03）。
- Mia 免费文字聊天：提交 `74dca62` 已从 GitHub 精确 SHA 由生产服务器构建并发布，耗时 8 秒；未绑定或无可用 Token 的用户使用仅限 `gpt-5.4` 的部署凭证完成私聊、群聊、意图路由和上下文整理，媒体任务保持用户 Key 严格门控并提供三类激活入口。118/118 全量测试、Lint、前后端 TypeScript、生产构建和 `git diff --check` 通过；生产 `/health` 正常，PM2 `online` 且 0 次重启，访客 `gpt-5.4` 实际调用 HTTP 200，错误日志为空，服务器保留 3 个 release（2026-09-03）。
- Mia Responses 与 Web Search：提交 `2a684df` 已从 GitHub 精确 SHA 由生产服务器构建并发布；核心意图判断和最终文字回复改用 `/v1/responses`，由 `gpt-5.4` 通过 `tool_choice: auto` 自主决定是否调用 `web_search`。119/119 全量测试、ESLint、前后端 TypeScript、生产构建和 `git diff --check` 通过；真实 APIMaster strict JSON Schema 请求 HTTP 200 并执行 1 次搜索，完整生产 `IntentRouter` 实测返回北京次日天气。Telegram 回复默认不展示引用来源，查询词、调用次数和隐藏来源保留在 Debug；生产 `/health` 正常，PM2 `online` 且 0 次重启，错误日志为空，APIMaster 只读生产冒烟 19/19 通过，未修改或重启 APIMaster Web 与 new-api（2026-09-03）。
- Mia 专用群聊总结：提交 `52918a6` 已从 GitHub 精确 SHA 构建并发布到 `/srv/mia/releases/mia-git-52918a6efcb1-20260903T105633Z`；136/136 全量测试、ESLint、服务端与前端 TypeScript、生产构建和 `git diff --check` 通过。生产 Node.js 20.20.2、PM2 `online` 且 0 次重启，内部 `/health` 正常，SQLite 完整性为 `ok`，错误日志为空，Prompt Registry 已展示 `mia.group-summary@v1` 和 `mia.group-summary-input@v1`，APIMaster 只读冒烟 19/19 通过，服务器保留 3 个 release。尚待在 `Bot玩家` 群使用同一组问题完成真实对比验收（2026-09-03）。
- Mia 精简群聊总结：提交 `f99cb8a` 已从最新 `main` 精确 SHA 发布到 `/srv/mia/releases/mia-git-f99cb8af579e-20260903T111437Z`；Prompt Registry 已升级为 `mia.group-summary@v2`。用户可见总结默认控制在一屏内，中文目标不超过约 500 字，核心话题最多 3 个，结论、待办和未决问题各最多 3 条，限制参与者与历史关联，并禁止跨栏目重复同一事实；滚动摘要和长期记忆仍保持完整。145/145 测试、ESLint、前后端 TypeScript、生产构建、`git diff --check` 和 APIMaster 只读冒烟 19/19 均通过；生产 PM2 `online`、0 次重启、健康检查正常且错误日志为空（2026-09-03）。
- Mia `70c6774` 生产验收：服务器从 GitHub 精确 SHA 构建，内部 `/health` 返回 200，PM2 在线且 0 次重启，运行目录与 release 元数据均指向 `70c67745c9ff19d8fe6ea81ce4db3c3a1dbd8e22`；SQLite 完整性为 `ok`，`mia_user_onboarding`、`mia_summaries` 和 `mia_memories` 均存在，新进程错误日志为空。APIMaster Web、new-api、Flask 和静态资源只读冒烟为 19/19 通过，未修改或重启 APIMaster 主服务（2026-09-03）。
- Mia 通用 Rich Message：功能提交 `845758f` 已从 GitHub 精确 SHA 发布到 `/srv/mia/releases/mia-git-845758f10123-20260904T061408Z`；216/216 测试、ESLint、前后端 TypeScript、生产构建和 `git diff --check` 通过。生产 `gpt-5.4` 严格 Schema 实测返回 `table + quote`，Mia Bot 原生 `sendRichMessage` 投递成功（消息 ID 1554）；内部 `/health` 正常、PM2 `online` 且 0 次重启、SQLite 完整性为 `ok`、错误日志为空并保留 3 个 release。APIMaster Web、new-api、Flask 与静态资源只读冒烟 20/20 通过，未修改或重启 APIMaster 主服务（2026-09-04）。
- Mia 通用回复展示风格：提交 `b8f1386` 已从 GitHub 精确 SHA 发布到 `/srv/mia/releases/mia-git-b8f13867b548-20260904T070124Z`；新增可在 Debug 单独审阅的 `mia.presentation-style@v1`，并组合进 `mia.intent-router@v10` 与 `mia.follow-up-chat@v4`。短回答不强制格式，较长回复允许标题、区块和并列重点使用语义 Emoji；对比内容优先一张核心表格、重点观察和一句建议。216/216 测试、ESLint、前后端 TypeScript、生产构建和 `git diff --check` 通过；生产内部 `/health` 正常、PM2 `online` 且 0 次重启、SQLite 完整性为 `ok`、错误日志为空、保留 3 个 release，APIMaster 只读冒烟 19/19 通过；未修改或重启 APIMaster Web、new-api 或 Flask（2026-09-04）。
- Mia 交流风格精简：提交 `eab43e8` 已从 GitHub 精确 SHA 发布到 `/srv/mia/releases/mia-git-eab43e83c88a-20260904T071131Z`；`mia.system@v2` 要求根据用户语言回答，保持自然幽默、主动积极、开门见山，并在 Telegram 中避免大段连续文字；多项信息优先使用简短列表。组合 Prompt 同步升级为 `mia.intent-router@v11` 与 `mia.follow-up-chat@v5`。216/216 测试、ESLint、前后端 TypeScript、生产构建和 `git diff --check` 通过；生产内部 `/health` 正常、PM2 `online` 且 0 次重启、SQLite 完整性为 `ok`、错误日志为空、保留 3 个 release，APIMaster 只读冒烟 19/19 通过；未修改或重启 APIMaster Web、new-api 或 Flask（2026-09-04）。
- Mia Telegram 一键连接：Mia 功能提交 `72acb20` 与 APIMaster Web `7bcad73` 已推送并发布。未绑定用户的图片/视频入口统一指向 `/connect/telegram`；APIMaster 登录或注册后自动恢复该路径，创建一次性 Telegram 绑定凭证并跳回 Bot，已绑定用户直接回 Bot，不再进入 Profile。Mia 244/244 测试、ESLint、前后端 TypeScript、生产构建和健康检查通过；APIMaster 新路由 ESLint、生产构建和公开未登录链路通过，登录地址正确保留 `next=/connect/telegram`，生产只读冒烟 21/21 通过。发布过程未修改、构建或重启 new-api（2026-09-04）。
- Mia Prompt 翻译清理：提交 `0000bad` 已从 GitHub 精确 SHA 发布到 `/srv/mia/releases/mia-git-0000badae2cc-20260904T154046Z`；修复英文/俄语 prompt 中的中文空占位泄漏，清理俄语 prompt 与产品 facts 中的中文残留和中英混杂术语，并补上对应回归测试；同时修正 `test/apimaster.test.ts` 的类型安全断言以满足当前 ESLint 规则。251/251 测试、ESLint、前后端 TypeScript、生产构建和 `git diff --check` 通过。因本机直连生产机 `188.245.245.213:22` 被远端关闭，本次按标准 GitHub 精确 SHA 发版流程经 `roma-prod` 跳板执行服务器构建；生产 release 元数据指向 `0000badae2cc7b1a76e7eb3af598ed38da7dd3d6`，Node.js `v20.20.2`、PM2 `online`、健康检查 `ok`，耗时 8 秒，回滚目标保留为 `mia-git-d3b908584556-20260904T153304Z`；未修改或重启 APIMaster Web、new-api 或 Flask（2026-09-04）。

- APIMaster Telegram 登录与 TG-only 账号：功能提交 `588a5a8` 已随精确 GitHub SHA `6e258b5` 发布到 APIMaster Web。登录/注册页均已提供 Telegram，验签用户可创建 `email = NULL` 的 APIMaster 账号并同步 new-api 镜像账号；已有账号必须先登录后绑定，不按昵称或手机号自动合并；账号页支持补绑真实邮箱，体验卡继续保留 IP、设备、领取记录、社交身份和入群条件风控。数据库迁移前已备份 `users`、`user_social_bindings` 和 `trial_claims`，迁移后确认邮箱可空、Telegram 唯一索引和体验卡验证字段存在。12/12 可执行测试、定向 ESLint、15 个 locale JSON、生产构建和提交检查通过；生产正常回跳保留 `/connect/telegram`，危险外链回跳被清空，nonce Cookie 为 HttpOnly，官方 Widget 成功渲染。APIMaster 两个 PM2 worker 在线、生产代码为 `6e258b5`，只读生产冒烟 21/21 通过；发布未修改、构建或重启 new-api。尚待真实 Telegram 账号完成一次登录/创建/回跳人工验收（2026-09-05）。
- APIMaster Telegram 登录加固：提交 `b1d5573` 已发布到 APIMaster Web。TG 登录初始化不再从 Next.js 内部请求推导 origin；生产实测即使内部 Host 为 `0.0.0.0:3000`，也会返回 `https://apimaster.ai/auth/telegram`，注册来源同步保持公网地址，`next=/connect/telegram` 与受保护 nonce Cookie 均保留。补充 `allows_write_to_pm` 验签兼容、旧绑定查询的 `found/not_found/unavailable/conflict` 区分、new-api 不可用时停止创建潜在重复用户、可信代理 IP 解析、三类可恢复错误提示，以及邮箱补绑验证码五次失败限制；移除 TG 登录请求中的专用运行时 DDL。19/19 Node 测试、定向 ESLint、15 个 locale JSON、两次生产构建、路由回归和 19/19 线上只读冒烟通过；全仓 ESLint 仍被既有无关页面的 27 个错误阻断。生产 SHA 为 `b1d5573`，两个 PM2 worker 在线，相关错误日志为 0，TG 用户与绑定均为 0；本次发布未触发 new-api 构建或重启。尚待真实 Telegram 账号完成授权、TG-only 创建、镜像账号同步和返回 Mia 的最终人工验收（2026-09-05）。

## 下一阶段优先级

以下顺序是当前工程建议，不代表“尚待产品确认”中的事项已经拍板：

1. P0：完成真实 Telegram Mini App、连续聊天、长期记忆、多轮图片追问和媒体生成验收，并轮换曾经暴露在对话中的 Bot Token 和 API Key。
2. P1：为生产用户开放至少一个显式视觉模型，验收看图问答。
3. P1：增加普通聊天的用户级速率限制，并完善媒体失败重试观测。
4. P2：完善新会话和历史会话管理。
5. P2：提交部署群共享上下文并完成真实群聊验收，随后确定原始消息保留期与群级预算方案。
6. P2：在真实群聊验收专用群聊总结；继续实现管理员查看、编辑、清除群记忆。
7. P2：统一 Tools 支持：建立 Tool Registry，集中管理 Web Search、邮件、日历等工具的能力声明、模型兼容性检测、自动 fallback、失败反馈、权限/付费确认、Debug 审计和计费统计；先解决正式 `web_search` 的计费漏记，再逐项开放其他工具。
8. P3：在群聊基础能力稳定后增加投票、小游戏、破冰、欢迎和主动气氛调节。

## 下一次交接检查清单

1. 先阅读本文件，再检查 `Mia`、`newapi/new-api` 和生产基线是否一致。
2. 检查共享文件和 Git 状态，避免覆盖其他任务或用户尚未提交的改动。
3. 只把经过测试、构建、截图或生产探针验证的事实标记为完成。
4. 涉及群聊产品决策时先处理“尚待产品确认”事项，不用工程实现替产品做决定。
5. 每完成一次可部署里程碑，同步更新提交号、生产状态、验证结果和下一步。
6. 用户确认实施计划后，按下方发版规则自主完成后续交付；除非出现明确阻塞，不在开发完成后再次等待用户重复确认上线。

## Mia 发版约束

- 用户说“推上线”时，必须先验证并提交到 `lisaluoyf/Mia` 的 GitHub `main`，再由生产服务器拉取并构建该精确 Git SHA；禁止默认直传本地 `dist`。
- 标准入口为 `pnpm deploy:production`：复用依赖缓存、健康失败自动回滚，成功后服务器只保留最近 3 个可运行版本。
- 只有用户明确要求“紧急直传”时才允许跳过标准流程，且随后必须补齐 GitHub 提交。
- 对已经由用户确认实施计划的较大任务，完成实现和规定验证后，默认直接提交、推送、部署生产、执行生产健康与关键路径验收，并同步更新本文件；不再等待用户另外说“上线”。较大任务包括用户可见的新能力、跨模块改动，以及涉及 API 契约、数据结构、权限、安全、计费或核心消息行为的变更。
- 小而独立、低风险且不影响 API、数据、权限、安全、计费或核心用户流程的改动，可以与后续同类改动合并成一个发布批次；是否合并由执行任务根据风险和交付完整性判断，并在进展中明确记录尚未发布。
- 用户明确要求“只做本地”“暂不上线”或指定发布时间时，以用户要求为准。测试或构建失败、产品决策未确认、需要破坏性数据迁移、缺少生产权限或密钥、发现相互冲突的并行改动时，必须暂停发布并报告阻塞，不得为了遵循自动上线规则绕过安全检查。

## Developer Debug Console (2026-09-03)

- [x] 已实现独立开发者控制台页面：`/mia/debug`；生产数据通过 API Master 登录会话服务端鉴权后代理，不信任浏览器传入邮箱。
- [x] 仅 `MIA_DEBUG_ALLOWED_EMAILS` 中的 API Master 账号可访问；默认值为已确认的 Lisa 账号。未登录返回登录要求，其他账号返回 404。
- [x] API Master 服务端解析真实用户和已绑定 Telegram ID，Mia 只按该 Telegram ID 返回请求数据，避免跨用户读取。
- [x] 已实现请求快照 SQLite 存储：聊天、意图路由、视觉问答、图片/视频任务和每 10 轮记忆整理均记录状态、模型、耗时、Prompt 引用及可审计输入/输出摘要。
- [x] 已实现脱敏：API Key、Bot Token、授权头、Telegram 文件下载 URL、Base64 和二进制正文不写入日志；日志默认保留 7 天、每个开发者最多 100 条，可手动清空。
- [x] 已实现五层上下文展示：Mia 规则、会话元数据、长期记忆、滚动摘要、按时间顺序的消息/回复关系/当前消息/图片角色。
- [x] 已增加只读 `Prompts` Tab，展示 Prompt 稳定 ID、版本、用途和完整当前文本；请求详情可跳转到实际使用的 Prompt 版本。生产 Prompt 不可在控制台编辑。
- [x] 已增加 `Memory` Tab，展示当前长期记忆、滚动摘要、10 轮进度和压缩历史；暂无压缩历史时明确显示空状态。
- [x] 已完成本地浏览器验收：桌面 Requests/Memory/Prompts 可用，五层上下文可展开；390×844 移动视口无横向溢出，长文本可换行。
- [x] 已完成代码校验：Mia 69/69 测试、ESLint、服务端与前端 TypeScript 检查、生产构建和 `git diff --check` 通过；new-api `go test ./controller ./router` 通过。
- [x] Mia、new-api 和 APIMaster Web 的变更均已提交并推送到各自 GitHub `main`，生产运行版本与对应 Git SHA 一致。
- [x] 生产 Nginx 已通过 `auth_request` 保护 `/mia/debug`，Debug API 明确路由到 APIMaster Web；`nginx -t`、服务重载、健康检查和未登录访问行为验证通过。
- [x] 生产 Mia 启动时已加载 1 个开发者身份，内部只读 Prompt 接口返回全部 4 个 Prompt；开发者 Telegram ID 当前尚无请求快照属于正常空状态。
- [ ] 使用 `lisa.luoyf@gmail.com` 的真实 APIMaster 登录会话完成最终页面验收；随后发送一条 Telegram 消息，确认 Requests 出现真实五层上下文快照，并检查 Memory 与 Prompts Tab。
- [ ] 使用已登录的非 Lisa 账号验证 `/mia/debug` 对外表现为 404；当前服务端白名单与 Nginx 映射已经实现，尚缺真实会话人工验收。
