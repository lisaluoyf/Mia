# Mia Agent Bot 项目目标与进展档案

> 本文件是 Mia Agent Bot 的长期目标、架构决策、交付记录和待办事项的共享进度源，供 `Agent Bot`、`处理 Bot 私聊` 和 `Bot 群聊` 任务共同维护。
> 最后同步：2026-09-03（Asia/Shanghai）

## 维护规则

- 开始工作前先阅读本文件，完成关键里程碑后更新对应模块。
- 只把已经验证的结果标记为完成；正在修改但尚未验证的内容保留为进行中。
- 更新进展时记录验证方式，例如测试、构建、截图检查或生产探针。
- 不在本文件记录 Bot Token、API Key、内部服务密钥或其他敏感信息。
- 多个任务同时工作时，各自只修改负责的模块；涉及共享文件时先确认当前工作区状态。

## 产品定位与长期目标

Mia 是面向 Telegram 生态的娱乐型 AI 助手。用户应能像和真人秘书聊天一样，直接使用自然语言提出需求；命令只作为快捷入口，不应成为主要交互方式。产品不以办公自动化为主线，重点是个人创作、轻量娱乐和群聊气氛互动。

Mia 当前复用 APIMaster 的账号、API Key、模型目录、计费和模型路由能力，但保持独立代码仓库与服务边界。APIMaster 对 Mia 来说是外部能力服务，而不是需要深度耦合的业务框架。第一阶段用户通过已绑定的 APIMaster 账号使用；后续可增加 Telegram 直接登录和独立开户，但不属于当前交付范围。

长期产品由三个可独立演进的模块组成：

1. Mini App：账号状态、聊天/图片/视觉/视频模型选择及后续个人设置。
2. 私聊助手：连续聊天、生图、改图、视频和后续 Agent 能力。
3. 群聊主持人：群聊问答、上下文、总结、群记忆、小游戏和社群互动。

聊天、图片、视频、模型目录、任务状态和用量控制属于共享能力，由私聊和群聊共同调用。模块之间通过明确的服务与存储接口连接，避免把 Telegram 接入、模型调用、Mini App 页面和业务场景堆在同一层。

### 当前阶段目标

先跑通并稳定维护以下最小闭环：

1. 所有 Telegram 用户都可以使用文字聊天；已绑定用户使用自己的 APIMaster Key，未绑定或无可用 Token 的用户使用 Mia 的受限免费文字凭证。
2. 用户可以从 Telegram 打开 Mini App，查看实际可用模型并保存聊天、图片和视频偏好。
3. Bot 在群里除明确的总结命令/短语外只在被点名时发言，同时安静采集它实际收到的群消息，为上下文和总结能力建立数据基础。
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
| Mia | `52918a6` | Node.js 20、PM2 运行，包含消费级 Mini App、连续上下文、长期记忆、私聊用户画像引导、群聊上下文压缩、专用群聊总结、媒体能力、Responses 自动 Web Search 和开发者 Debug 控制台 |
| APIMaster new-api | `9130c1d` | GHCR 镜像蓝绿部署，提供 Telegram 用户 Key 解析、规范化 Mia 模型目录、产品名和 Debug 身份解析 |
| APIMaster Web | `7d62618` | Next.js PM2 双实例运行，提供登录态校验、Lisa 白名单和 Mia Debug 安全代理 |
| Mini App | `/mia/` | 已由 Nginx 公开，Telegram 默认菜单按钮 `Mia` 已配置 |
| 持久化 | `/var/lib/mia/mia.sqlite` | schema v2，保存用户模型设置与分作用域的会话数据，WAL 模式 |

生产环境只保存运行所需密钥，不把 Bot Token、API Key 或内部服务密钥写入 Git、日志摘要或本文件。当前仍缺少真实 Telegram 客户端对 Mini App、连续聊天、长期记忆和媒体生成的最终人工验收。数据库已由本版迁移到 schema v2；`57ca489` 及更旧的 Mia 版本不能直接读取该数据库，今后回滚必须使用支持 schema v2 的版本或同时恢复数据库快照。`9fff043` 发布前已创建独立 SQLite 备份。

## 已交付能力

### 基础消息链路

- [x] Telegram webhook 由 `new-api` 接收并转发给 Mia。
- [x] `new-api -> Mia` 使用独立内部密钥鉴权。
- [x] Mia 使用 Grammy 处理 Telegram Update。
- [x] 私聊文字消息可以调用 APIMaster 聊天模型。
- [x] 群聊普通请求仅在 `@Mia` 或回复 Mia 时响应；`/summary` 和明确总结短语可直接触发群聊总结。
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

## 私聊助手

### 已有能力

- [x] 接收私聊文字。
- [x] 私聊消息使用独立 `chat_id` 空间持久化，不与用户全局记忆或群聊空间混用。
- [x] 根据 Telegram 用户解析 APIMaster Key。
- [x] 调用聊天补全并拆分过长回复。
- [x] 基础错误提示。
- [x] 通用五类意图路由：`chat`、`image_generate`、`image_edit`、`vision_qa`、`video_generate`。
- [x] 免费用户的媒体意图在付费任务创建前拦截，并按未绑定、无 Token、余额不足显示注册绑定、创建 Token 或充值入口。
- [x] `/image`、`/vision`、`/video` 确定性入口；自然语言优先使用触发者自己的 APIMaster Key 调用 `gpt-5.4`，仅未绑定或无可用 Token 时使用免费文字凭证。
- [x] 已绑定用户的 `chat` 和自然语言 `vision_qa` 可由同一次 `gpt-5.4` 调用返回最终文字；免费用户的所有视觉、图片和视频意图会在媒体调用前拦截。
- [x] 图片、图片文档和相册持久化；私聊当前图片保留 30 分钟。
- [x] 文生图、多图改图、看图问答和文生/图生视频执行框架。
- [x] 视频 10 分钟未扣费确认草稿，可调整时长和画幅。
- [x] 图片与视频共享每用户 3 个在途任务，使用 SQLite 原子检查和幂等键。
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
- [x] 最近图片携带实际像素及固定引用，区分 `current`、`replied`、`active` 和 `historical`；仍在讨论的活动图片即使早于摘要水位也继续注入。
- [x] 每 10 轮成功文字私聊在 Mia 完成回复后异步触发一次；媒体生成、视觉问答、失败请求和群聊不计入长期记忆轮数。
- [x] 同一次 `gpt-5.4` 后台调用接收已有完整长期记忆、已有滚动摘要和最近 10 轮对话，返回整理后的完整最新记忆与完整摘要。
- [x] 长期记忆只保留称呼/身份、长期偏好、稳定习惯和长期目标；代码层执行 JSON Schema、条数/长度、明显敏感值和完全重复校验。
- [x] 长期记忆整体替换、摘要新增和 10 轮处理水位在同一个 SQLite 事务中提交；模型失败时不标记水位，下次仍可重试。
- [x] 所有模型指令集中在 `Mia/src/prompts.ts`，包括 Mia 身份、意图路由和记忆/摘要整理 Prompt，便于逐场景 Review。

当前实现边界：最多向一次聊天请求携带 10 张上下文图片；时区没有可靠 Telegram 来源时明确传 `null`；首版不在群聊中自动提取个人长期记忆。

## 群聊主持人

### 已确认的产品原则

- [x] Bot 应采用“全量监听、选择性存储、克制回复”的模式。
- [x] 默认只在 `@Mia`、回复 Mia 或执行命令时调用模型并发言；明确的中英文群聊总结短语是受控例外。
- [x] Telegram 不提供 Bot 可任意读取的历史消息接口；上下文必须由 Mia 从收到 Update 后自行保存。
- [x] 关闭 Privacy Mode 或让 Bot 成为管理员，是接收普通群消息并建立上下文的前提。
- [x] 群组 Topic 应通过 `chat_id + message_thread_id` 隔离短期上下文。
- [x] 上下文计划分为最近消息、回复链、阶段摘要和长期群记忆四层。
- [x] 群管理员应能配置保留期限并清除群上下文。

### 第一阶段建议范围

- [x] 采集 Bot 实际收到的普通群文字消息，不因“不响应”而丢弃上下文。
- [x] 保存基础群资料、已见成员、文字消息、回复关系、Topic 和文字编辑记录。
- [x] 在 `@Mia` 或回复 Mia 时加载当前群或 Topic 的最近消息、回复关系和相关图片。
- [x] 群聊上下文使用独立选择策略：候选最近 200 条，优先当前消息和回复链，再选触发者在当前 Topic 最近 24 小时内的最多 12 条公开发言、最近 60 分钟讨论和至少最近 30 条尾部消息，最终按时间排序并控制在约 16,000 tokens。
- [x] 普通群读取群级公开长期记忆；Topic 同时读取群级公开记忆与当前 Topic 记忆；任何用户私聊长期记忆都不会注入群聊。
- [x] 群内媒体只在命令、`@Mia`、回复 Mia 或回复媒体时明确呼叫 Mia 的场景触发。
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
- [x] 普通群文字在响应策略判断前入库；未 `@Mia` 的消息仍存储但不触发模型。
- [x] `edited_message:text` 更新原消息存储，不触发新的 AI 回复。

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
- [x] 默认读取摘要水位后的最近最多 300 条、约 24,000 tokens 原始消息，排除当前总结请求，并明确显示 Mia 实际收到的消息数量。
- [x] 每个用户可见条目必须引用真实消息；服务端丢弃伪造或跨作用域来源，并校验参与者 ID 与引用消息发送者一致。
- [x] 一次 `gpt-5.4` 调用同时生成用户可见总结、完整滚动摘要和当前作用域完整公开长期记忆；回复全部成功发送并落库后才原子推进水位。
- [x] 消息或 token 窗口截断、发送失败、模型失败、水位竞争或模型运行期间出现并发新消息时不推进旧水位，也不立即追加后台压缩调用。
- [x] Telegram 展示由服务端渲染转义后的 HTML，按固定栏目输出，空栏目隐藏，所有分段独立闭合且不超过 4096 字符，并保留原群、原 Topic 和回复关系。
- [x] Debug 新增“群聊总结”类型，记录 Prompt、作用域、选中范围、截断、证据过滤、凭证来源和持久化结果，不记录 Key。

### 后续能力

- [x] 阶段摘要和长期群记忆（本地实现，待提交部署和真实群聊验收）。
- [ ] 新成员欢迎、群规则和 FAQ。
- [ ] 群日报或周报。
- [ ] 群内图片、文件、链接和语音理解。
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
- Mia `70c6774` 生产验收：服务器从 GitHub 精确 SHA 构建，内部 `/health` 返回 200，PM2 在线且 0 次重启，运行目录与 release 元数据均指向 `70c67745c9ff19d8fe6ea81ce4db3c3a1dbd8e22`；SQLite 完整性为 `ok`，`mia_user_onboarding`、`mia_summaries` 和 `mia_memories` 均存在，新进程错误日志为空。APIMaster Web、new-api、Flask 和静态资源只读冒烟为 19/19 通过，未修改或重启 APIMaster 主服务（2026-09-03）。

## 下一阶段优先级

以下顺序是当前工程建议，不代表“尚待产品确认”中的事项已经拍板：

1. P0：完成真实 Telegram Mini App、连续聊天、长期记忆、多轮图片追问和媒体生成验收，并轮换曾经暴露在对话中的 Bot Token 和 API Key。
2. P1：为生产用户开放至少一个显式视觉模型，验收看图问答。
3. P1：增加普通聊天的用户级速率限制，并完善媒体失败重试观测。
4. P2：完善新会话和历史会话管理。
5. P2：提交部署群共享上下文并完成真实群聊验收，随后确定原始消息保留期与群级预算方案。
6. P2：在真实群聊验收专用群聊总结；继续实现管理员查看、编辑、清除群记忆。
7. P3：在群聊基础能力稳定后增加投票、小游戏、破冰、欢迎和主动气氛调节。

## 下一次交接检查清单

1. 先阅读本文件，再检查 `Mia`、`newapi/new-api` 和生产基线是否一致。
2. 修改代码前先向用户提交计划并获得确认。
3. 检查共享文件和 Git 状态，避免覆盖其他任务或用户尚未提交的改动。
4. 只把经过测试、构建、截图或生产探针验证的事实标记为完成。
5. 涉及群聊产品决策时先处理“尚待产品确认”事项，不用工程实现替产品做决定。
6. 每完成一次可部署里程碑，同步更新提交号、生产状态、验证结果和下一步。

## Mia 发版约束

- 用户说“推上线”时，必须先验证并提交到 `lisaluoyf/Mia` 的 GitHub `main`，再由生产服务器拉取并构建该精确 Git SHA；禁止默认直传本地 `dist`。
- 标准入口为 `pnpm deploy:production`：复用依赖缓存、健康失败自动回滚，成功后服务器只保留最近 3 个可运行版本。
- 只有用户明确要求“紧急直传”时才允许跳过标准流程，且随后必须补齐 GitHub 提交。

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
