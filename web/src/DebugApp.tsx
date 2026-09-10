import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, Braces, Check, ChevronDown, ChevronRight, Clock3, Database, FileText, RefreshCw, Save, Search, Trash2 } from "lucide-react";

import { clearDebugRequests, DebugApiError, loadDebugConsole, saveDebugModelConfigs, saveDebugPrompt, type DebugMemory, type DebugModelConfig, type DebugModelConfigState, type DebugModelOption, type DebugPrompt, type DebugRequest } from "./debug-api";
import "./debug.css";

type Tab = "requests" | "memory" | "prompts" | "models";
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
  group_compaction: "群聊整理",
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

function formatDebugModelPrice(model: DebugModelOption): string {
  const pricing = model.pricing;
  if (!pricing) return "价格暂不可用";
  const format = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return "-";
    const digits = value >= 1 ? 2 : value >= 0.1 ? 3 : 4;
    return `$${value.toFixed(digits)}`;
  };
  const text = pricing.unit === "token_1m"
    ? `输入 ${format(pricing.inputPrice)}`
    : pricing.unit === "image" ? `${format(pricing.price)} / 张` : `${format(pricing.price)} / 秒`;
  return pricing.discountRatio === undefined
    ? text
    : `${text} · 折扣 ${(pricing.discountRatio * 100).toFixed(0)}%`;
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
  const upstreamError = request.details && typeof request.details === "object" && !Array.isArray(request.details)
    ? (request.details as Record<string, unknown>).upstreamError
    : null;
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
    {upstreamError != null && <section className="detail-section upstream-error"><h3>上游错误信息</h3><JsonBlock value={upstreamError} /></section>}
    <section className="detail-section">
      <h3>使用的 Prompt</h3>
      <div className="prompt-chips">{request.promptRefs.length ? request.promptRefs.map((prompt) =>
        <button key={`${prompt.id}.${prompt.version}`} onClick={() => onPrompt(prompt.id)}>{prompt.id}<span>v{prompt.version} · 实际发送</span><ChevronRight size={14} /></button>
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

function PromptsView({ prompts, selectedId, requests, onSaved }: { prompts: DebugPrompt[]; selectedId: string; requests: DebugRequest[]; onSaved: (prompt: DebugPrompt) => void }) {
  const [activeId, setActiveId] = useState(selectedId || prompts[0]?.id || "");
  useEffect(() => { if (selectedId) setActiveId(selectedId); }, [selectedId]);
  const active = prompts.find((item) => item.id === activeId) ?? prompts[0];
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => { setDraft(active?.text ?? ""); setFeedback(null); }, [active?.id]);
  const save = async () => {
    if (!active || !draft.trim() || saving) return;
    setSaving(true); setFeedback(null);
    try { onSaved(await saveDebugPrompt(active.id, draft)); setFeedback("已保存，立即生效"); }
    catch (error) { setFeedback(error instanceof DebugApiError && error.status === 422 ? "内容格式不合适" : "保存失败，请稍后重试"); }
    finally { setSaving(false); }
  };
  return <div className="prompt-layout"><aside className="prompt-list">{prompts.map((prompt) => {
    const uses = requests.filter((request) => request.promptRefs.some((ref) => ref.id === prompt.id && ref.version === prompt.version)).length;
    return <button key={prompt.id} className={prompt.id === active?.id ? "active" : ""} onClick={() => setActiveId(prompt.id)}><Braces size={18} /><span><strong>{prompt.name}</strong><small>{prompt.id} · v{prompt.version}</small></span><em>{uses}</em></button>;
  })}</aside><main className="prompt-content">{active ? <><header><div><span className="detail-kicker">{active.id} · v{active.version}</span><h2>{active.name}</h2><p>{active.purpose}</p>{active.includes?.length ? <p>包含基础模块：{active.includes.join("、")}</p> : active.kind === "base" ? <p>基础模块，不会在组合 Prompt 之外重复发送。</p> : null}</div><span className="readonly-badge">可编辑</span></header><textarea className="prompt-editor" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} /><div className="prompt-editor-actions"><span className={feedback === "保存失败，请稍后重试" || feedback === "内容格式不合适" ? "save-feedback error" : "save-feedback success"}>{feedback ?? "保存后立即生效"}</span><button className="save-model-config" type="button" disabled={saving || !draft.trim()} onClick={() => void save()}><Save size={15} />{saving ? "保存中" : "保存 Prompt"}</button></div></> : <Empty>暂无已注册的 Prompt</Empty>}</main></div>;
}

const capabilityNames: Record<DebugModelConfig["capability"], string> = {
  chat: "文本",
  vision: "视觉",
  image: "图片",
  video: "视频",
};

function draftValues(configs: DebugModelConfig[]): Record<string, string> {
  return Object.fromEntries(configs.map((config) => [config.key, config.model ?? ""]));
}

function ModelConfigsView({ state, onSaved }: { state: DebugModelConfigState; onSaved: (state: DebugModelConfigState) => void }) {
  const { configs, models } = state;
  const [draft, setDraft] = useState<Record<string, string>>(() => draftValues(configs));
  const [baseline, setBaseline] = useState<Record<string, string>>(() => draftValues(configs));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dirty = configs.some((config) => (draft[config.key] ?? "").trim() !== (baseline[config.key] ?? "").trim());
  const invalid = configs.some((config) => config.capability !== "vision" && (draft[config.key] ?? "").trim() === "");

  useEffect(() => {
    if (dirty) return;
    const next = draftValues(configs);
    setDraft(next);
    setBaseline(next);
  }, [configs, dirty]);

  const update = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveState("idle");
  };

  const save = async () => {
    if (!dirty || invalid || saveState === "saving") return;
    const values = Object.fromEntries(configs
      .filter((config) => (draft[config.key] ?? "").trim() !== (baseline[config.key] ?? "").trim())
      .map((config) => [config.key, (draft[config.key] ?? "").trim() || null]));
    setSaveState("saving");
    try {
      const saved = await saveDebugModelConfigs(values);
      const next = draftValues(saved.configs);
      setDraft(next);
      setBaseline(next);
      setSaveState("saved");
      onSaved(saved);
    } catch {
      setSaveState("error");
    }
  };

  const groups = [
    { key: "user_default", title: "用户默认", note: "用户未单独选择模型时使用；个人设置仍然优先" },
    { key: "internal", title: "Mia 内部", note: "路由、记忆和系统任务使用；保存后对新请求生效" },
  ] as const;

  return <div className="model-config-view">
    <div className="model-config-toolbar">
      <p>贴纸生成沿用“图片生成与编辑”的模型。已开始的图片、贴纸和视频任务不会中途换模型。</p>
      <div className="model-config-actions">
        {invalid && <span className="save-feedback error"><AlertCircle size={15} />只有视觉模型可以留空</span>}
        {!invalid && saveState === "saved" && <span className="save-feedback success"><Check size={15} />配置已生效</span>}
        {saveState === "error" && <span className="save-feedback error"><AlertCircle size={15} />保存失败，请检查模型 ID</span>}
        <button className="save-model-config" disabled={!dirty || invalid || saveState === "saving"} onClick={() => void save()}>
          {saveState === "saving" ? <RefreshCw size={16} className="spin" /> : <Save size={16} />}
          {saveState === "saving" ? "正在保存" : "保存更改"}
        </button>
      </div>
    </div>
    <div className="model-config-table-wrap">
      <table className="model-config-table">
        <thead><tr><th>场景</th><th>能力</th><th>默认模型</th></tr></thead>
        <tbody>{groups.map((group) => <ModelConfigGroupRows key={group.key} group={group} configs={configs.filter((config) => config.group === group.key)} models={models} draft={draft} onUpdate={update} />)}</tbody>
      </table>
    </div>
  </div>;
}

function ModelPicker({ config, models, value, onChange }: { config: DebugModelConfig; models: DebugModelOption[]; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const candidates = useMemo(() => models.filter((model) => (
    config.capability === "vision"
      ? model.capability === "chat" && model.supportsVision
      : config.capability === "video"
        ? model.capability === "video"
        : model.capability === config.capability
  )).sort((left, right) => Number(right.recommended) - Number(left.recommended) || left.displayName.localeCompare(right.displayName)), [config.capability, models]);
  const selected = candidates.find((model) => model.id.toLowerCase() === value.toLowerCase());
  const unavailable = value !== "" && !selected;
  const normalizedQuery = query.trim().toLowerCase();
  const visible = candidates.filter((model) => `${model.displayName} ${model.vendor} ${model.id}`.toLowerCase().includes(normalizedQuery));

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const choose = (next: string) => { onChange(next); setOpen(false); setQuery(""); };
  return <div className={`model-picker ${open ? "open" : ""}`} ref={root}>
    <button type="button" className="model-picker-trigger" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
      <span className="model-picker-value">
        <strong>{value === "" ? "自动选择" : (selected?.displayName ?? value)}</strong>
        {value !== "" && <small>{selected ? `${selected.vendor} · ${selected.id}` : "当前不可用"}</small>}
      </span>
      {unavailable && <AlertCircle className="model-unavailable-icon" size={16} />}
      <ChevronDown className="model-picker-chevron" size={17} />
    </button>
    {open && <div className="model-picker-menu">
      <label className="model-picker-search"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、厂商或模型 ID" aria-label="搜索模型" /></label>
      <div className="model-picker-options">
        {config.capability === "vision" && normalizedQuery === "" && <button type="button" className="model-option" onClick={() => choose("")}><span><strong>自动选择</strong><small>优先使用推荐的视觉模型</small></span>{value === "" && <Check size={16} />}</button>}
        {visible.map((model) => <button type="button" className="model-option" key={model.id} onClick={() => choose(model.id)}>
          <span><strong>{model.displayName}{(model.recommended || (config.capability === "vision" && model.visionRecommended)) && <em>推荐</em>}</strong><small>{model.vendor} · {model.id}</small><small className="model-price">{formatDebugModelPrice(model)}</small></span>
          {model.id.toLowerCase() === value.toLowerCase() && <Check size={16} />}
        </button>)}
        {visible.length === 0 && normalizedQuery !== "" && <p className="model-picker-empty">没有匹配的模型</p>}
      </div>
    </div>}
  </div>;
}

function ModelConfigGroupRows({ group, configs, models, draft, onUpdate }: {
  group: { key: DebugModelConfig["group"]; title: string; note: string };
  configs: DebugModelConfig[];
  models: DebugModelOption[];
  draft: Record<string, string>;
  onUpdate: (key: string, value: string) => void;
}) {
  return <>
    <tr className="model-group-row"><th colSpan={3}><strong>{group.title}</strong><span>{group.note}</span></th></tr>
    {configs.map((config) => {
      const value = draft[config.key] ?? "";
      const rowInvalid = config.capability !== "vision" && value.trim() === "";
      return <tr key={config.key} className={rowInvalid ? "invalid" : ""}>
        <td data-label="场景"><strong>{config.scenario}</strong><span>{config.description}</span><code>{config.key}</code></td>
        <td data-label="能力"><span className={`capability-badge ${config.capability}`}>{capabilityNames[config.capability]}</span></td>
        <td data-label="默认模型"><ModelPicker config={config} models={models} value={value} onChange={(next) => onUpdate(config.key, next)} /></td>
      </tr>;
    })}
  </>;
}

export function DebugApp() {
  const [tab, setTab] = useState<Tab>("requests");
  const [data, setData] = useState<{ requests: DebugRequest[]; prompts: DebugPrompt[]; memory: DebugMemory; modelConfig: DebugModelConfigState } | null>(null);
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
      <nav aria-label="调试视图">{(["requests", "memory", "prompts", "models"] as const).map((item) => <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item === "requests" ? "请求记录" : item === "memory" ? "长期记忆" : item === "prompts" ? "Prompt" : "模型配置"}</button>)}</nav>
      <div className="top-actions"><span className="live-state"><i />实时</span><button className="tool-button" onClick={() => void load()} title="刷新" aria-label="刷新"><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button><button className="tool-button danger" onClick={() => void clear()} title="清空日志" aria-label="清空日志"><Trash2 size={17} /></button></div>
    </header>
    <div className="debug-page-head"><div><span>私人开发控制台</span><h1>{tab === "requests" ? "模型请求" : tab === "memory" ? "记忆状态" : tab === "prompts" ? "Prompt 库" : "场景模型"}</h1></div>{data && <div className="page-stat"><Clock3 size={16} /><span>每 10 秒自动刷新</span></div>}</div>
    {error ? <div className="fatal-state"><Activity size={28} /><h2>{error}</h2></div> : !data ? <div className="fatal-state"><RefreshCw className="spin" size={28} /><h2>正在加载调试记录</h2></div> :
      tab === "requests" ? <RequestsView requests={data.requests} onPrompt={openPrompt} /> : tab === "memory" ? <MemoryView data={data.memory} /> : tab === "prompts" ? <PromptsView prompts={data.prompts} selectedId={promptId} requests={data.requests} onSaved={(prompt) => setData((current) => current ? { ...current, prompts: current.prompts.map((item) => item.id === prompt.id ? prompt : item) } : current)} /> : <ModelConfigsView state={data.modelConfig} onSaved={(modelConfig) => setData((current) => current ? { ...current, modelConfig } : current)} />}
  </div>;
}
