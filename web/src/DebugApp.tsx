import { useEffect, useMemo, useState } from "react";
import { Activity, Braces, ChevronRight, Clock3, Database, FileText, RefreshCw, Search, Trash2 } from "lucide-react";

import { clearDebugRequests, DebugApiError, loadDebugConsole, type DebugMemory, type DebugPrompt, type DebugRequest } from "./debug-api";
import "./debug.css";

type Tab = "requests" | "memory" | "prompts";
const layerNames: Record<string, string> = {
  systemRules: "1 · 系统规则",
  conversation: "2 · 当前会话",
  longTermMemory: "3 · 长期记忆",
  rollingSummary: "4 · 滚动摘要",
  recentMessages: "5 · 最近消息",
};

const statusNames: Record<DebugRequest["status"], string> = {
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  submitted: "已提交",
};

const requestKindNames: Record<DebugRequest["kind"], string> = {
  chat: "聊天",
  vision_qa: "看图问答",
  image_generate: "图片生成",
  image_edit: "图片编辑",
  video_generate: "视频生成",
  memory_compaction: "记忆整理",
};

const chatTypeNames: Record<string, string> = {
  private: "私聊",
  group: "群聊",
  supergroup: "超级群组",
  channel: "频道",
};

const memoryCategoryNames: Record<string, string> = {
  identity: "身份与称呼",
  preference: "长期偏好",
  habit: "稳定习惯",
  goal: "长期目标",
};

function ago(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return new Date(value).toLocaleString("zh-CN");
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="debug-code">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
}

function Status({ value }: { value: DebugRequest["status"] }) {
  return <span className={`debug-status ${value}`}><i />{statusNames[value]}</span>;
}

function Empty({ children }: { children: string }) {
  return <div className="debug-empty"><Activity size={24} /><span>{children}</span></div>;
}

function RequestDetails({ request, onPrompt }: { request: DebugRequest; onPrompt: (id: string) => void }) {
  return <article className="debug-detail">
    <header className="detail-head">
      <div><span className="detail-kicker">{requestKindNames[request.kind]}</span><h2>{request.model}</h2></div>
      <Status value={request.status} />
    </header>
    <dl className="detail-meta">
      <div><dt>开始时间</dt><dd>{new Date(request.createdAt).toLocaleString("zh-CN")}</dd></div>
      <div><dt>耗时</dt><dd>{request.durationMs === null ? "运行中" : `${request.durationMs} 毫秒`}</dd></div>
      <div><dt>会话</dt><dd>{request.chatType ? (chatTypeNames[request.chatType] ?? request.chatType) : "-"} · {request.chatId ?? "-"}</dd></div>
      <div><dt>消息 ID</dt><dd>{request.messageId ?? "-"}</dd></div>
      {request.taskId && <div><dt>任务 ID</dt><dd className="mono-inline">{request.taskId}</dd></div>}
      {request.errorCode && <div><dt>错误代码</dt><dd className="error-text">{request.errorCode}</dd></div>}
    </dl>
    <section className="detail-section">
      <h3>使用的 Prompt</h3>
      <div className="prompt-chips">{request.promptRefs.length ? request.promptRefs.map((prompt) =>
        <button key={`${prompt.id}.${prompt.version}`} onClick={() => onPrompt(prompt.id)}>{prompt.id}<span>v{prompt.version}</span><ChevronRight size={14} /></button>
      ) : <span className="muted">本次 API 调用未使用系统 Prompt</span>}</div>
    </section>
    {request.contextLayers && <section className="detail-section"><h3>五层上下文</h3><div className="layer-stack">
      {Object.entries(layerNames).map(([key, label]) => <details key={key} open={key === "recentMessages"}>
        <summary><span>{label}</span><span className="layer-state">{request.contextLayers?.[key] == null ? "空" : "已记录"}</span></summary>
        <JsonBlock value={request.contextLayers?.[key] ?? null} />
      </details>)}
    </div></section>}
    <section className="detail-section split-code"><div><h3>请求</h3><JsonBlock value={request.requestPreview} /></div><div><h3>响应</h3><JsonBlock value={request.responsePreview} /></div></section>
    {request.media != null && <section className="detail-section"><h3>媒体信息</h3><JsonBlock value={request.media} /></section>}
    {request.details != null && <section className="detail-section"><h3>追踪详情</h3><JsonBlock value={request.details} /></section>}
  </article>;
}

function RequestsView({ requests, onPrompt }: { requests: DebugRequest[]; onPrompt: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => requests.filter((item) => `${item.kind} ${item.model} ${item.status}`.toLowerCase().includes(query.toLowerCase())), [query, requests]);
  const [selectedId, setSelectedId] = useState(requests[0]?.id ?? "");
  useEffect(() => { if (!requests.some((item) => item.id === selectedId)) setSelectedId(requests[0]?.id ?? ""); }, [requests, selectedId]);
  const selected = requests.find((item) => item.id === selectedId) ?? filtered[0];
  return <div className="request-layout">
    <aside className="request-list"><label className="debug-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选请求" /></label>
      <div className="request-scroll">{filtered.map((request) => <button className={`request-row ${request.id === selected?.id ? "active" : ""}`} key={request.id} onClick={() => setSelectedId(request.id)}>
        <span className="request-main"><strong>{requestKindNames[request.kind]}</strong><small>{request.model}</small></span><Status value={request.status} />
        <span className="request-foot"><span>{ago(request.createdAt)}</span><span>{request.durationMs === null ? "..." : `${request.durationMs} 毫秒`}</span></span>
      </button>)}</div>
    </aside>
    <main className="request-content">{selected ? <RequestDetails request={selected} onPrompt={onPrompt} /> : <Empty>暂无请求快照</Empty>}</main>
  </div>;
}

function MemoryView({ data }: { data: DebugMemory }) {
  return <div className="memory-view">
    <section className="memory-overview"><div><span>待整理轮数</span><strong>{data.pendingTurns} <em>/ {data.batchSize}</em></strong></div><div><span>已存记忆</span><strong>{data.memories.length}</strong></div><div><span>最近整理</span><strong className="compact-date">{data.lastCompaction ? ago(data.lastCompaction.createdAt) : "尚未整理"}</strong></div></section>
    <div className="memory-columns"><section><header><div><span className="section-kicker">用户范围</span><h2>长期记忆</h2></div><Database size={20} /></header>
      <div className="memory-list">{data.memories.length ? data.memories.map((item) => <article key={item.id}><span>{memoryCategoryNames[item.category] ?? item.category}</span><p>{item.content}</p><time>{new Date(item.updatedAt).toLocaleString("zh-CN")}</time></article>) : <Empty>暂无长期记忆</Empty>}</div></section>
      <section><header><div><span className="section-kicker">私聊范围</span><h2>滚动摘要</h2></div><FileText size={20} /></header>
        {data.summary ? <><p className="summary-copy">{data.summary.content}</p><div className="summary-meta">已整理至消息 {data.summary.throughMessageId} · {new Date(data.summary.createdAt).toLocaleString("zh-CN")}</div></> : <Empty>暂无滚动摘要</Empty>}
      </section></div>
    <section className="compaction-history"><header><div><span className="section-kicker">每 10 轮整理</span><h2>整理历史</h2></div></header>
      {data.history.length ? data.history.map((item) => <details key={item.id}><summary><Status value={item.status} /><span>{new Date(item.createdAt).toLocaleString("zh-CN")}</span><span>{item.durationMs ?? 0} 毫秒</span></summary><JsonBlock value={{ input: item.requestPreview, output: item.responsePreview, changes: item.details, errorCode: item.errorCode }} /></details>) : <Empty>暂无整理记录</Empty>}
    </section>
  </div>;
}

function PromptsView({ prompts, selectedId, requests }: { prompts: DebugPrompt[]; selectedId: string; requests: DebugRequest[] }) {
  const [activeId, setActiveId] = useState(selectedId || prompts[0]?.id || "");
  useEffect(() => { if (selectedId) setActiveId(selectedId); }, [selectedId]);
  const active = prompts.find((item) => item.id === activeId) ?? prompts[0];
  return <div className="prompt-layout"><aside className="prompt-list">{prompts.map((prompt) => {
    const uses = requests.filter((request) => request.promptRefs.some((ref) => ref.id === prompt.id && ref.version === prompt.version)).length;
    return <button key={prompt.id} className={prompt.id === active?.id ? "active" : ""} onClick={() => setActiveId(prompt.id)}><Braces size={18} /><span><strong>{prompt.name}</strong><small>{prompt.id} · v{prompt.version}</small></span><em>{uses}</em></button>;
  })}</aside><main className="prompt-content">{active ? <><header><div><span className="detail-kicker">{active.id} · v{active.version}</span><h2>{active.name}</h2><p>{active.purpose}</p></div><span className="readonly-badge">只读</span></header><pre className="prompt-source">{active.text}</pre></> : <Empty>暂无已注册的 Prompt</Empty>}</main></div>;
}

export function DebugApp() {
  const [tab, setTab] = useState<Tab>("requests");
  const [data, setData] = useState<{ requests: DebugRequest[]; prompts: DebugPrompt[]; memory: DebugMemory } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [promptId, setPromptId] = useState("");
  const load = async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try { setData(await loadDebugConsole()); setError(null); }
    catch (reason) {
      if (reason instanceof DebugApiError && reason.status === 401) { location.assign(`/login?next=${encodeURIComponent("/mia/debug")}`); return; }
      setError(reason instanceof DebugApiError && reason.status === 404 ? "页面不存在" : reason instanceof DebugApiError && reason.code === "telegram_not_bound" ? "当前账号尚未绑定 Telegram。" : "调试数据暂时不可用，请稍后重试。");
    } finally { setRefreshing(false); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(true), 10_000); return () => clearInterval(timer); }, []);
  const openPrompt = (id: string) => { setPromptId(id); setTab("prompts"); };
  const clear = async () => { if (!confirm("确定清空你的全部 Mia 调试快照吗？此操作无法撤销。")) return; await clearDebugRequests(); await load(); };
  return <div className="debug-shell">
    <header className="debug-topbar"><div className="debug-brand"><img src="/mia/mia-assistant.jpg" alt="" /><div><strong>Mia 调试台</strong><span>开发请求追踪</span></div></div>
      <nav aria-label="调试视图">{(["requests", "memory", "prompts"] as const).map((item) => <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item === "requests" ? "请求记录" : item === "memory" ? "长期记忆" : "Prompt"}</button>)}</nav>
      <div className="top-actions"><span className="live-state"><i />实时</span><button className="tool-button" onClick={() => void load()} title="刷新" aria-label="刷新"><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button><button className="tool-button danger" onClick={() => void clear()} title="清空日志" aria-label="清空日志"><Trash2 size={17} /></button></div>
    </header>
    <div className="debug-page-head"><div><span>私人开发控制台</span><h1>{tab === "requests" ? "模型请求" : tab === "memory" ? "记忆状态" : "Prompt 库"}</h1></div>{data && <div className="page-stat"><Clock3 size={16} /><span>每 10 秒自动刷新</span></div>}</div>
    {error ? <div className="fatal-state"><Activity size={28} /><h2>{error}</h2></div> : !data ? <div className="fatal-state"><RefreshCw className="spin" size={28} /><h2>正在加载调试记录</h2></div> :
      tab === "requests" ? <RequestsView requests={data.requests} onPrompt={openPrompt} /> : tab === "memory" ? <MemoryView data={data.memory} /> : <PromptsView prompts={data.prompts} selectedId={promptId} requests={data.requests} />}
  </div>;
}
