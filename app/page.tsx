"use client";

import { useState, useRef, useEffect, FormEvent, KeyboardEvent } from "react";

type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

// Keep this list in sync with ALLOWED_MODELS in app/api/chat/route.ts
const MODELS = [
  { id: "gemini-3.8-flash",     label: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash",     label: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash",     label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash",     label: "Gemini 3.5 Flash" },
  { id: "gemini-3.5-flash-lite",label: "Gemini 3.5 Flash Lite" },
  { id: "gemini-2.5-pro",       label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash",     label: "Gemini 2.5 Flash" },
];

const DEFAULT_MODEL = "gemini-3.8-flash";

// ─── Goal presets ─────────────────────────────────────────────────────────────
// Each goal maps to a system instruction sent to Gemini.
// Add, remove, or edit entries here to change the dropdown options.
const GOALS = [
  { id: "friendly",  label: "😊 Friendly Assistant", instruction: "You are a friendly, concise general assistant. Give clear, direct answers — avoid unnecessary filler or overly long responses. If you're unsure about something, say so honestly rather than guessing." },
  { id: "concise",   label: "⚡ Strict Q&A",         instruction: "Answer only the exact question asked. No greetings, no extra context. Maximum 2 sentences." },
  { id: "coder",     label: "💻 Code Tutor",          instruction: "You are an expert programming tutor. Explain concepts step-by-step with code examples. Use simple language suitable for beginners." },
  { id: "creative",  label: "✨ Creative Writer",      instruction: "You are a creative storyteller. Write vivid, imaginative responses with rich descriptions and metaphors." },
  { id: "hindi",     label: "🇮🇳 Hindi Assistant",     instruction: "You are a helpful assistant. Always reply in Hindi using Devanagari script." },
  { id: "haryanvi", label: "🗣️ Haryanvi Assistant",   instruction: "You are a helpful assistant. Always reply in Haryanvi dialect using Devanagari script. Use authentic Haryanvi vocabulary, phrases, and tone." },
];

const DEFAULT_GOAL = "friendly";

// ─── Usage tracking ──────────────────────────────────────────────────────────
// Counts requests per model per day using localStorage so the numbers survive
// page refreshes. Resets automatically each calendar day (key includes the date).
// NOTE: This is a client-side approximation. If you use the same API key from
// multiple devices the counts won't sync, but exhausted flags from 429 responses
// are always authoritative.
const FREE_TIER_DAILY_LIMIT = 20;

type ModelUsage = { count: number; exhausted: boolean };
type UsageMap   = Record<string, ModelUsage>;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" — auto-resets daily
}
function loadUsage(): UsageMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(`gemini_usage_${todayKey()}`);
    return raw ? (JSON.parse(raw) as UsageMap) : {};
  } catch { return {}; }
}
function persistUsage(u: UsageMap) {
  try { localStorage.setItem(`gemini_usage_${todayKey()}`, JSON.stringify(u)); }
  catch { /* storage full — silently ignore */ }
}
function getModelUsage(u: UsageMap, id: string): ModelUsage {
  return u[id] ?? { count: 0, exhausted: false };
}

let idCounter = 0;

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [model, setModel]       = useState(DEFAULT_MODEL);
  const [goal, setGoal]         = useState(DEFAULT_GOAL);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [usage, setUsage]       = useState<UsageMap>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  // Hydrate usage from localStorage after first render (avoids SSR mismatch)
  useEffect(() => { setUsage(loadUsage()); }, []);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }, [input]);

  // Called after a successful API response to update counts
  function trackRequest(modelId: string) {
    setUsage((prev) => {
      const cur = getModelUsage(prev, modelId);
      const next = cur.count + 1;
      const updated: UsageMap = {
        ...prev,
        [modelId]: { count: next, exhausted: next >= FREE_TIER_DAILY_LIMIT },
      };
      persistUsage(updated);
      return updated;
    });
  }

  // Called when the server returns 429 — authoritative exhausted signal
  function markExhausted(modelId: string) {
    setUsage((prev) => {
      const updated: UsageMap = {
        ...prev,
        [modelId]: { ...getModelUsage(prev, modelId), exhausted: true },
      };
      persistUsage(updated);
      return updated;
    });
  }

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const userMessage = input.trim();
    if (!userMessage || loading) return;

    const userMsg: Message = { id: ++idCounter, role: "user", content: userMessage };
    const fullHistory = [...messages, userMsg];
    setMessages(fullHistory);
    setInput("");
    setLoading(true); // shows the typing indicator while waiting for the first token

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: fullHistory.map(({ role, content }) => ({ role, content })),
          model,
          systemInstruction: GOALS.find((g) => g.id === goal)?.instruction,
        }),
      });

      // ── Error responses come back as JSON (not streams) ──────────────────────
      if (res.status === 429) {
        const data = await res.json();
        if (data.quotaExhausted) markExhausted(data.model || model);
        throw new Error(data.error ?? "Rate limit reached. Please try again later.");
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error ?? "Something went wrong.");
      }
      if (!res.body) throw new Error("No response body from server.");

      // ── Stream the reply in token-by-token ───────────────────────────────────
      // Create an empty assistant message now so the UI has somewhere to append to.
      const assistantId = ++idCounter;
      setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);
      setLoading(false); // hide the typing indicator — streaming text is the visual feedback

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const chunk = JSON.parse(jsonStr);

            if (chunk.done) {
              // Final event from the server — track usage for the model that was used
              trackRequest(chunk.model || model);
              break outer;
            }

            if (chunk.text) {
              // Append the new token to the assistant message already in state
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + chunk.text }
                    : m
                )
              );
            }
          } catch {
            /* skip malformed SSE chunks */
          }
        }
      }
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : "Something went wrong.";
      setMessages((prev) => [
        ...prev,
        { id: ++idCounter, role: "assistant", content: `⚠️ ${text}` },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleEdit(msg: Message) {
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx === -1) return;
    setMessages(messages.slice(0, idx));
    setInput(msg.content);
    setHoveredId(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  }

  // ─── Derived values for the selected model ────────────────────────────────
  const selUsage   = getModelUsage(usage, model);
  const remaining  = Math.max(0, FREE_TIER_DAILY_LIMIT - selUsage.count);
  const pct        = (selUsage.count / FREE_TIER_DAILY_LIMIT) * 100;
  const barColor   = selUsage.exhausted ? "#ef4444" : pct >= 75 ? "#f59e0b" : "#22c55e";

  return (
    <main style={s.page}>
      {/* ── Header ── */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <span style={s.logo}>✦</span>
          <span style={s.title}>Gemini Chat</span>

          <div style={s.headerRight}>
            {/* Remaining-requests pill */}
            <div style={s.usagePill} title={`${selUsage.count} of ${FREE_TIER_DAILY_LIMIT} requests used today (approx.)`}>
              <span style={{ ...s.dot2, background: barColor }} />
              <span style={s.usageLabel}>
                {selUsage.exhausted ? "Quota full" : `${remaining}/${FREE_TIER_DAILY_LIMIT} left`}
              </span>
            </div>

            {/* Goal picker */}
            <select
              id="goal-select"
              style={{ ...s.modelSelect, ...s.goalSelect, ...(loading ? s.modelSelectDisabled : {}) }}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={loading}
              aria-label="Select assistant goal"
            >
              {GOALS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>

            {/* Model picker */}
            <select
              id="model-select"
              style={{ ...s.modelSelect, ...(loading ? s.modelSelectDisabled : {}) }}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={loading}
              aria-label="Select Gemini model"
            >
              {MODELS.map((m) => {
                const mu  = getModelUsage(usage, m.id);
                const rem = Math.max(0, FREE_TIER_DAILY_LIMIT - mu.count);
                const tag = mu.exhausted ? " — full" : ` (${rem} left)`;
                return (
                  <option key={m.id} value={m.id}>
                    {m.label}{tag}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        {/* Thin progress bar under the header */}
        <div style={s.barTrack}>
          <div style={{ ...s.barFill, width: `${Math.min(pct, 100)}%`, background: barColor }} />
        </div>
      </header>

      {/* ── Message list ── */}
      <section style={s.messageArea} aria-live="polite" aria-label="Chat messages">
        {messages.length === 0 && !loading && (
          <div style={s.empty}>
            <p style={s.emptyIcon}>✦</p>
            <p style={s.emptyText}>Ask me anything</p>
            <p style={s.emptyHint}>Press Enter to send · Shift+Enter for a new line</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{ ...s.row, justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}
            onMouseEnter={() => setHoveredId(msg.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            {msg.role === "assistant" && <div style={s.avatar}>✦</div>}
            {msg.role === "user" && hoveredId === msg.id && (
              <button style={s.editBtn} onClick={() => handleEdit(msg)} title="Edit message">✏</button>
            )}
            <div style={{ ...s.bubble, ...(msg.role === "user" ? s.bubbleUser : s.bubbleAssistant) }}>
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ ...s.row, justifyContent: "flex-start" }}>
            <div style={s.avatar}>✦</div>
            <div style={{ ...s.bubble, ...s.bubbleAssistant, ...s.typingBubble }}>
              <span style={{ ...s.dot, animationDelay: "0ms" }} />
              <span style={{ ...s.dot, animationDelay: "160ms" }} />
              <span style={{ ...s.dot, animationDelay: "320ms" }} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </section>

      {/* ── Input ── */}
      <form style={s.form} onSubmit={handleSubmit} aria-label="Message input">
        <div style={{ ...s.inputWrapper, ...(loading ? s.inputWrapperDisabled : {}) }}>
          <textarea
            ref={inputRef} id="chat-input" style={s.textarea}
            placeholder="Message Gemini…" value={input} rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown} disabled={loading}
            aria-label="Type your message"
          />
          <button
            id="send-button" type="submit"
            style={{ ...s.sendBtn, ...(loading || !input.trim() ? s.sendBtnDisabled : s.sendBtnActive) }}
            disabled={loading || !input.trim()} aria-label="Send message"
          >↑</button>
        </div>
        <p style={s.hint}>Shift+Enter for new line</p>
      </form>

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40%            { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>
    </main>
  );
}

/* ─── Styles ─────────────────────────────────────────────── */
const s: Record<string, React.CSSProperties> = {
  page: { display:"flex", flexDirection:"column", height:"100dvh",
          background:"#0d0d0d", fontFamily:"'Inter',system-ui,sans-serif", color:"#e8e8e8" },

  header: { borderBottom:"1px solid #1e1e1e", padding:"0 1.25rem", flexShrink:0 },
  headerInner: { maxWidth:720, margin:"0 auto", height:56, display:"flex", alignItems:"center", gap:"0.5rem" },
  logo:  { fontSize:"1rem", color:"#7c6ff7" },
  title: { fontSize:"1rem", fontWeight:600, letterSpacing:"-0.01em" },
  headerRight: { marginLeft:"auto", display:"flex", alignItems:"center", gap:"0.6rem" },

  usagePill: { display:"flex", alignItems:"center", gap:"0.35rem",
               background:"#111", border:"1px solid #222", borderRadius:20, padding:"0.2rem 0.65rem" },
  dot2: { width:7, height:7, borderRadius:"50%", flexShrink:0, display:"inline-block" },
  usageLabel: { fontSize:"0.72rem", color:"#888", whiteSpace:"nowrap" as const },

  barTrack: { height:2, background:"#1a1a1a" },
  barFill:  { height:"100%", borderRadius:2, transition:"width 0.4s ease, background 0.4s ease" },

  modelSelect: { background:"#111", color:"#aaa", border:"1px solid #2a2a2a",
                 borderRadius:8, padding:"0.3rem 0.6rem", fontSize:"0.78rem",
                 fontFamily:"inherit", cursor:"pointer", outline:"none" },
  goalSelect:  { minWidth:140 },
  modelSelectDisabled: { opacity:0.5, cursor:"not-allowed" },

  messageArea: { flex:1, overflowY:"auto", padding:"1.5rem 1.25rem",
                 display:"flex", flexDirection:"column", gap:"1rem" },

  empty: { margin:"auto", textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:"0.4rem" },
  emptyIcon: { fontSize:"2rem", color:"#7c6ff7", margin:0 },
  emptyText: { fontSize:"1.15rem", fontWeight:600, margin:0, color:"#ccc" },
  emptyHint: { fontSize:"0.8rem", color:"#555", margin:0 },

  row:    { display:"flex", alignItems:"flex-end", gap:"0.5rem", maxWidth:720, width:"100%", margin:"0 auto" },
  avatar: { flexShrink:0, width:28, height:28, borderRadius:"50%", background:"#1a1a2e",
            border:"1px solid #2e2e4e", display:"flex", alignItems:"center",
            justifyContent:"center", fontSize:"0.65rem", color:"#7c6ff7" },
  bubble: { padding:"0.65rem 1rem", borderRadius:18, maxWidth:"78%",
            lineHeight:1.65, fontSize:"0.94rem", wordBreak:"break-word", whiteSpace:"pre-wrap" },
  bubbleUser:      { background:"#7c6ff7", color:"#fff", borderBottomRightRadius:4 },
  bubbleAssistant: { background:"#1a1a1a", color:"#e0e0e0", border:"1px solid #272727", borderBottomLeftRadius:4 },
  editBtn: { flexShrink:0, background:"transparent", border:"1px solid #333",
             borderRadius:8, color:"#666", fontSize:"0.8rem", padding:"0.25rem 0.5rem",
             cursor:"pointer", alignSelf:"center", lineHeight:1 },
  typingBubble: { display:"flex", alignItems:"center", gap:5, padding:"0.75rem 1rem" },
  dot: { display:"inline-block", width:7, height:7, borderRadius:"50%", background:"#666", animation:"bounce 1.2s infinite" },

  form: { flexShrink:0, padding:"0.75rem 1.25rem 1rem", borderTop:"1px solid #1a1a1a",
          maxWidth:720, width:"100%", margin:"0 auto", boxSizing:"border-box" },
  inputWrapper: { display:"flex", alignItems:"flex-end", gap:"0.5rem", background:"#111",
                  border:"1px solid #2a2a2a", borderRadius:14, padding:"0.5rem 0.5rem 0.5rem 1rem" },
  inputWrapperDisabled: { opacity:0.6 },
  textarea: { flex:1, background:"transparent", border:"none", outline:"none", color:"#e8e8e8",
              fontSize:"0.94rem", fontFamily:"inherit", lineHeight:1.6, resize:"none", overflowY:"hidden", padding:"0.2rem 0" },
  sendBtn: { flexShrink:0, width:34, height:34, borderRadius:10, border:"none", fontSize:"1.1rem",
             cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  sendBtnActive:   { background:"#7c6ff7", color:"#fff" },
  sendBtnDisabled: { background:"#222", color:"#444", cursor:"not-allowed" },
  hint: { margin:"0.35rem 0 0", fontSize:"0.72rem", color:"#3a3a3a", textAlign:"center" },
};
