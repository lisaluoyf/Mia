import { useEffect, useMemo, useState } from "react";
import { Activity, Braces, ChevronRight, Clock3, Database, FileText, RefreshCw, Search, Trash2 } from "lucide-react";

import { clearDebugRequests, DebugApiError, loadDebugConsole, type DebugMemory, type DebugPrompt, type DebugRequest } from "./debug-api";
import "./debug.css";

type Tab = "requests" | "memory" | "prompts";
const layerNames: Record<string, string> = {
  systemRules: "1 · System rules",
  conversation: "2 · Conversation",
  longTermMemory: "3 · Long-term memory",
  rollingSummary: "4 · Rolling summary",
  recentMessages: "5 · Recent messages",
};

function ago(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(value).toLocaleString();
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="debug-code">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
}

function Status({ value }: { value: DebugRequest["status"] }) {
  return <span className={`debug-status ${value}`}><i />{value}</span>;
}

function Empty({ children }: { children: string }) {
  return <div className="debug-empty"><Activity size={24} /><span>{children}</span></div>;
}

function RequestDetails({ request, onPrompt }: { request: DebugRequest; onPrompt: (id: string) => void }) {
  return <article className="debug-detail">
    <header className="detail-head">
      <div><span className="detail-kicker">{request.kind.replaceAll("_", " ")}</span><h2>{request.model}</h2></div>
      <Status value={request.status} />
    </header>
    <dl className="detail-meta">
      <div><dt>Started</dt><dd>{new Date(request.createdAt).toLocaleString()}</dd></div>
      <div><dt>Duration</dt><dd>{request.durationMs === null ? "Running" : `${request.durationMs} ms`}</dd></div>
      <div><dt>Chat</dt><dd>{request.chatType ?? "-"} · {request.chatId ?? "-"}</dd></div>
      <div><dt>Message</dt><dd>{request.messageId ?? "-"}</dd></div>
      {request.taskId && <div><dt>Task</dt><dd className="mono-inline">{request.taskId}</dd></div>}
      {request.errorCode && <div><dt>Error</dt><dd className="error-text">{request.errorCode}</dd></div>}
    </dl>
    <section className="detail-section">
      <h3>Prompts</h3>
      <div className="prompt-chips">{request.promptRefs.length ? request.promptRefs.map((prompt) =>
        <button key={`${prompt.id}.${prompt.version}`} onClick={() => onPrompt(prompt.id)}>{prompt.id}<span>v{prompt.version}</span><ChevronRight size={14} /></button>
      ) : <span className="muted">No system prompt for this API call</span>}</div>
    </section>
    {request.contextLayers && <section className="detail-section"><h3>Context layers</h3><div className="layer-stack">
      {Object.entries(layerNames).map(([key, label]) => <details key={key} open={key === "recentMessages"}>
        <summary><span>{label}</span><span className="layer-state">{request.contextLayers?.[key] == null ? "empty" : "captured"}</span></summary>
        <JsonBlock value={request.contextLayers?.[key] ?? null} />
      </details>)}
    </div></section>}
    <section className="detail-section split-code"><div><h3>Request</h3><JsonBlock value={request.requestPreview} /></div><div><h3>Response</h3><JsonBlock value={request.responsePreview} /></div></section>
    {request.media != null && <section className="detail-section"><h3>Media</h3><JsonBlock value={request.media} /></section>}
    {request.details != null && <section className="detail-section"><h3>Trace details</h3><JsonBlock value={request.details} /></section>}
  </article>;
}

function RequestsView({ requests, onPrompt }: { requests: DebugRequest[]; onPrompt: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => requests.filter((item) => `${item.kind} ${item.model} ${item.status}`.toLowerCase().includes(query.toLowerCase())), [query, requests]);
  const [selectedId, setSelectedId] = useState(requests[0]?.id ?? "");
  useEffect(() => { if (!requests.some((item) => item.id === selectedId)) setSelectedId(requests[0]?.id ?? ""); }, [requests, selectedId]);
  const selected = requests.find((item) => item.id === selectedId) ?? filtered[0];
  return <div className="request-layout">
    <aside className="request-list"><label className="debug-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter requests" /></label>
      <div className="request-scroll">{filtered.map((request) => <button className={`request-row ${request.id === selected?.id ? "active" : ""}`} key={request.id} onClick={() => setSelectedId(request.id)}>
        <span className="request-main"><strong>{request.kind.replaceAll("_", " ")}</strong><small>{request.model}</small></span><Status value={request.status} />
        <span className="request-foot"><span>{ago(request.createdAt)}</span><span>{request.durationMs === null ? "..." : `${request.durationMs} ms`}</span></span>
      </button>)}</div>
    </aside>
    <main className="request-content">{selected ? <RequestDetails request={selected} onPrompt={onPrompt} /> : <Empty>No request snapshots yet</Empty>}</main>
  </div>;
}

function MemoryView({ data }: { data: DebugMemory }) {
  return <div className="memory-view">
    <section className="memory-overview"><div><span>Pending turns</span><strong>{data.pendingTurns} <em>/ {data.batchSize}</em></strong></div><div><span>Stored memories</span><strong>{data.memories.length}</strong></div><div><span>Last compaction</span><strong className="compact-date">{data.lastCompaction ? ago(data.lastCompaction.createdAt) : "Not yet"}</strong></div></section>
    <div className="memory-columns"><section><header><div><span className="section-kicker">USER SCOPE</span><h2>Long-term memory</h2></div><Database size={20} /></header>
      <div className="memory-list">{data.memories.length ? data.memories.map((item) => <article key={item.id}><span>{item.category}</span><p>{item.content}</p><time>{new Date(item.updatedAt).toLocaleString()}</time></article>) : <Empty>No long-term memory yet</Empty>}</div></section>
      <section><header><div><span className="section-kicker">PRIVATE CHAT</span><h2>Rolling summary</h2></div><FileText size={20} /></header>
        {data.summary ? <><p className="summary-copy">{data.summary.content}</p><div className="summary-meta">Through message {data.summary.throughMessageId} · {new Date(data.summary.createdAt).toLocaleString()}</div></> : <Empty>No rolling summary yet</Empty>}
      </section></div>
    <section className="compaction-history"><header><div><span className="section-kicker">EVERY 10 TURNS</span><h2>Compaction history</h2></div></header>
      {data.history.length ? data.history.map((item) => <details key={item.id}><summary><Status value={item.status} /><span>{new Date(item.createdAt).toLocaleString()}</span><span>{item.durationMs ?? 0} ms</span></summary><JsonBlock value={{ input: item.requestPreview, output: item.responsePreview, changes: item.details, errorCode: item.errorCode }} /></details>) : <Empty>No compaction runs yet</Empty>}
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
  })}</aside><main className="prompt-content">{active ? <><header><div><span className="detail-kicker">{active.id} · v{active.version}</span><h2>{active.name}</h2><p>{active.purpose}</p></div><span className="readonly-badge">Read only</span></header><pre className="prompt-source">{active.text}</pre></> : <Empty>No prompts registered</Empty>}</main></div>;
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
      setError(reason instanceof DebugApiError && reason.status === 404 ? "Not found" : reason instanceof DebugApiError && reason.code === "telegram_not_bound" ? "This account has no Telegram binding." : "Debug data is temporarily unavailable.");
    } finally { setRefreshing(false); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(true), 10_000); return () => clearInterval(timer); }, []);
  const openPrompt = (id: string) => { setPromptId(id); setTab("prompts"); };
  const clear = async () => { if (!confirm("Clear all of your Mia debug snapshots?")) return; await clearDebugRequests(); await load(); };
  return <div className="debug-shell">
    <header className="debug-topbar"><div className="debug-brand"><img src="/mia/mia-assistant.jpg" alt="" /><div><strong>Mia Debug</strong><span>Developer traces</span></div></div>
      <nav aria-label="Debug views">{(["requests", "memory", "prompts"] as const).map((item) => <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item === "requests" ? "Requests" : item === "memory" ? "Memory" : "Prompts"}</button>)}</nav>
      <div className="top-actions"><span className="live-state"><i />Live</span><button className="tool-button" onClick={() => void load()} title="Refresh" aria-label="Refresh"><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button><button className="tool-button danger" onClick={() => void clear()} title="Clear logs" aria-label="Clear logs"><Trash2 size={17} /></button></div>
    </header>
    <div className="debug-page-head"><div><span>PRIVATE DEVELOPMENT CONSOLE</span><h1>{tab === "requests" ? "Model requests" : tab === "memory" ? "Memory state" : "Prompt library"}</h1></div>{data && <div className="page-stat"><Clock3 size={16} /><span>Auto refresh · 10s</span></div>}</div>
    {error ? <div className="fatal-state"><Activity size={28} /><h2>{error}</h2></div> : !data ? <div className="fatal-state"><RefreshCw className="spin" size={28} /><h2>Loading traces</h2></div> :
      tab === "requests" ? <RequestsView requests={data.requests} onPrompt={openPrompt} /> : tab === "memory" ? <MemoryView data={data.memory} /> : <PromptsView prompts={data.prompts} selectedId={promptId} requests={data.requests} />}
  </div>;
}

