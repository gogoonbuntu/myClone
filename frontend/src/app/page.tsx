'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

type Role = 'user' | 'assistant';

interface Source { id: string; content: string; score: number; source: string; category?: string; }
interface ToolEvent { name: string; result?: string; }
interface Reflection { improved: boolean; critique: string; }
interface AnalysisStep { step: number; label: string; detail: string; }
interface ProcessTraceStep {
  id: string; label: string; detail: string; durationMs?: number;
  data?: Record<string, unknown>;
}

interface Message {
  id: string; role: Role; content: string; timestamp: Date;
  sources?: Source[]; tools?: ToolEvent[];
  reflection?: Reflection; latency?: string;
  originalText?: string;
  modelUsed?: string;
  processTrace?: ProcessTraceStep[];
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const PLACEHOLDERS = [
  '무엇이든 물어보세요…',
  '내 프로젝트에 대해 질문해보세요…',
  '기술적 결정 이유를 묻고 싶으시면…',
  '내 개발 철학과 체계를 말해보세요…',
  '경험에서 배운 교훈을 알려주세요…',
];

const SUGGESTIONS = [
  { icon: '🚀', text: '내 프로젝트 중 가장 복잡했던 것과 해결 방법을 알려줘' },
  { icon: '🧠', text: '새로운 기술을 배울 때 내가 쓰는 접근 방식은 뭐야?' },
  { icon: '⚡', text: 'TypeScript를 왜 쓰는지 내 실제 경험 기반으로 설명해줘' },
  { icon: '💡', text: '개발하면서 가장 크게 배운 교훈을 알려줘' },
];

// ─── Simple Markdown renderer ─────────────────────────────────────────────────

function md(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/```([\w]*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr />')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[^<]*<\/li>[\n]?)+/g, '<ul>$&</ul>')
    .replace(/\n\n+/g, '</p><p>');
}

// ─── Source category helpers ────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  project:    '#6366f1',
  experience: '#22d3ee',
  note:       '#34d399',
  blog:       '#fbbf24',
  github:     '#a78bfa',
  url:        '#f472b6',
  text:       '#818cf8',
};
const CATEGORY_ICONS: Record<string, string> = {
  project:    '🚀',
  experience: '💼',
  note:       '📝',
  blog:       '✍️',
  github:     '🐙',
  url:        '🌐',
  text:       '📋',
};
function catColor(cat?: string | null): string {
  return CATEGORY_COLORS[(cat ?? '').toLowerCase()] ?? '#818cf8';
}
function catIcon(cat?: string | null): string {
  return CATEGORY_ICONS[(cat ?? '').toLowerCase()] ?? '📄';
}
function scoreLabel(s: number): { label: string; color: string } {
  if (s >= 0.85) return { label: '매우 높음', color: '#34d399' };
  if (s >= 0.70) return { label: '높음',     color: '#6366f1' };
  if (s >= 0.55) return { label: '보통',     color: '#fbbf24' };
  return                { label: '낮음',     color: '#9490b8' };
}

// ─── Inline Sources Panel ────────────────────────────────────────────────────

function SourcesPanel({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const topScore = Math.max(...sources.map(s => s.score));

  return (
    <div className="src-panel">
      <button className="src-toggle" onClick={() => setOpen(o => !o)}>
        <span className="src-toggle-icon">📚</span>
        <span>참고한 지식 {sources.length}개</span>
        <div className="src-score-pills">
          {sources.slice(0, 3).map(s => {
            const { color } = scoreLabel(s.score);
            return (
              <span key={s.id} className="src-mini-pill" style={{ background: `${color}22`, borderColor: `${color}44`, color }}>
                {catIcon(s.category)} {(s.score * 100).toFixed(0)}%
              </span>
            );
          })}
          {sources.length > 3 && <span className="src-mini-pill src-more">+{sources.length - 3}</span>}
        </div>
        <span className="src-caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="src-body">
          {/* Relevance bar chart */}
          <div className="src-bar-chart">
            {sources.map((s, i) => {
              const pct = topScore > 0 ? (s.score / topScore) * 100 : 0;
              const { color } = scoreLabel(s.score);
              const name = s.source.length > 18 ? s.source.slice(0, 18) + '…' : s.source;
              return (
                <div key={s.id} className="src-bar-row" style={{ animationDelay: `${i * 60}ms` }}>
                  <div className="src-bar-label">
                    <span className="src-bar-cat-icon">{catIcon(s.category)}</span>
                    <span className="src-bar-name">{name}</span>
                  </div>
                  <div className="src-bar-track">
                    <div className="src-bar-fill" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}aa, ${color})` }} />
                    <span className="src-bar-pct" style={{ color }}>{(s.score * 100).toFixed(0)}%</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Source cards */}
          <div className="src-cards">
            {sources.map(s => {
              const { label, color } = scoreLabel(s.score);
              const isExp = expanded === s.id;
              const cc = catColor(s.category);
              return (
                <div key={s.id} className="src-card" style={{ borderColor: `${cc}25` }}>
                  <div className="src-card-head" onClick={() => setExpanded(isExp ? null : s.id)}>
                    <div className="src-card-icon" style={{ background: `${cc}18`, color: cc }}>
                      {catIcon(s.category)}
                    </div>
                    <div className="src-card-meta">
                      <div className="src-card-name">{s.source}</div>
                      {s.category && (
                        <span className="src-card-cat" style={{ background: `${cc}18`, color: cc }}>{s.category}</span>
                      )}
                    </div>
                    <div className="src-card-score-wrap">
                      <div className="src-card-score" style={{ color }}>
                        {(s.score * 100).toFixed(0)}%
                      </div>
                      <div className="src-card-score-label" style={{ color }}>{label}</div>
                    </div>
                    <span className="src-card-caret">{isExp ? '▲' : '▼'}</span>
                  </div>
                  {isExp && (
                    <div className="src-card-content">
                      <div className="src-card-content-inner">{s.content}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Process Sequence Panel ───────────────────────────────────────────────────

const STEP_ICONS: Record<string, string> = {
  tokenize: '✂️', embed: '🔢', memory: '💾', rag_search: '🔍',
  prompt_build: '📝', llm_inference: '⚡', reflection: '🪞', output: '✅',
};
const STEP_COLORS: Record<string, string> = {
  tokenize: '#818cf8', embed: '#a78bfa', memory: '#22d3ee',
  rag_search: '#34d399', prompt_build: '#fbbf24', llm_inference: '#6366f1',
  reflection: '#f472b6', output: '#34d399',
};

function ProcessSequencePanel({ steps, msgId }: { steps: ProcessTraceStep[]; msgId: string }) {
  const [open, setOpen] = useState(false);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  const totalMs = steps[steps.length - 1]?.durationMs ?? 0;

  return (
    <div className="psp-wrap">
      <button className="psp-toggle" onClick={() => setOpen(o => !o)} id={`psp-${msgId}`}>
        <span className="psp-toggle-icon">⚙️</span>
        처리 시퀀스 ({steps.length}단계)
        <span className="psp-total-ms">{totalMs}ms</span>
        <span className="psp-caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="psp-body">
          {/* Timeline bar */}
          <div className="psp-timeline-bar">
            {steps.map((s) => {
              const pct = totalMs > 0 ? Math.max(2, Math.round(((s.durationMs ?? 0) / totalMs) * 100)) : Math.round(100 / steps.length);
              return (
                <div
                  key={s.id}
                  className="psp-bar-seg"
                  style={{ width: `${pct}%`, background: STEP_COLORS[s.id] ?? '#6366f1' }}
                  title={`${s.label}: ${s.durationMs ?? 0}ms`}
                />
              );
            })}
          </div>

          {/* Steps list */}
          <div className="psp-steps">
            {steps.map((s, i) => {
              const color = STEP_COLORS[s.id] ?? '#6366f1';
              const icon = STEP_ICONS[s.id] ?? '🔹';
              const isExpanded = expandedStep === s.id;
              const arch = s.id === 'llm_inference' ? (s.data?.architecture as Record<string, unknown> | undefined) : null;
              const ragChunks = s.id === 'rag_search' ? (s.data?.chunks as Array<{source:string;score:number;category:string|null;preview:string}> | undefined) : null;
              const procNotes = s.id === 'llm_inference' ? (s.data?.processingNote as string[] | undefined) : null;

              return (
                <div key={s.id} className="psp-step">
                  {/* connector line */}
                  {i < steps.length - 1 && <div className="psp-connector" style={{ borderColor: color }} />}

                  <div className="psp-step-header" onClick={() => setExpandedStep(isExpanded ? null : s.id)}>
                    <div className="psp-step-dot" style={{ background: color, boxShadow: `0 0 8px ${color}66` }}>
                      <span>{icon}</span>
                    </div>
                    <div className="psp-step-info">
                      <div className="psp-step-label" style={{ color }}>
                        <span className="psp-step-num">{i + 1}</span>
                        {s.label}
                      </div>
                      <div className="psp-step-detail">{s.detail}</div>
                    </div>
                    <div className="psp-step-ms">{s.durationMs != null ? `${s.durationMs}ms` : '—'}</div>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="psp-step-expanded">
                      {/* LLM Architecture detail */}
                      {arch && (
                        <div className="psp-arch-grid">
                          <div className="psp-arch-item"><span>파라미터</span><strong>{String(arch.params ?? '?')}</strong></div>
                          <div className="psp-arch-item"><span>레이어</span><strong>{String(arch.layers ?? '?')}</strong></div>
                          <div className="psp-arch-item"><span>Q헤드</span><strong>{String(arch.qHeads ?? '?')}</strong></div>
                          <div className="psp-arch-item"><span>KV헤드</span><strong>{String(arch.kvHeads ?? '?')}</strong></div>
                          <div className="psp-arch-item"><span>히든 차원</span><strong>{String(arch.hiddenDim ?? '?')}</strong></div>
                          <div className="psp-arch-item"><span>출력 토큰/s</span><strong>{String(s.data?.tokensPerSec ?? '?')}</strong></div>
                        </div>
                      )}
                      {arch && <div className="psp-arch-note">{String(arch.note ?? '')}</div>}
                      {procNotes && (
                        <div className="psp-layer-notes">
                          {procNotes.map((n, ni) => (
                            <div key={ni} className="psp-layer-note">
                              <span className="psp-layer-dot" style={{ background: color }} />
                              {n}
                            </div>
                          ))}
                        </div>
                      )}
                      {arch && s.data?.attentionNote && (
                        <div className="psp-attention-note">{String(s.data.attentionNote)}</div>
                      )}

                      {/* RAG chunks */}
                      {ragChunks && ragChunks.length > 0 && (
                        <div className="psp-rag-chunks">
                          {ragChunks.map((c, ci) => (
                            <div key={ci} className="psp-rag-chunk">
                              <div className="psp-rag-header">
                                <span>📄 {c.source}{c.category ? ` / ${c.category}` : ''}</span>
                                <span className="psp-rag-score" style={{ color }}>유사도 {c.score}%</span>
                              </div>
                              <div className="psp-rag-preview">{c.preview}{c.preview.length >= 80 ? '…' : ''}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {ragChunks && ragChunks.length === 0 && (
                        <div className="psp-rag-empty">관련 청크 없음 (유사도 0.3 미만)</div>
                      )}

                      {/* Generic data for other steps */}
                      {!arch && !ragChunks && s.data && (
                        <div className="psp-generic-data">
                          {Object.entries(s.data).map(([k, v]) => (
                            typeof v !== 'object' ? (
                              <div key={k} className="psp-data-row">
                                <span>{k}</span><strong>{String(v)}</strong>
                              </div>
                            ) : null
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Page() {
  const [messages, setMessages]           = useState<Message[]>([]);
  const [input, setInput]                 = useState('');
  const [loading, setLoading]             = useState(false);
  const [convId, setConvId]               = useState<string | null>(null);
  const [status, setStatus]               = useState<string | null>(null);
  const [showModal, setShowModal]         = useState(false);
  const [modalTab, setModalTab]           = useState<'file' | 'url' | 'text'>('file');
  const [vecCount, setVecCount]           = useState(0);
  const [expanded, setExpanded]           = useState<Set<string>>(new Set());
  const [serverInfo, setServerInfo]       = useState<{persona:string;llm:string;provider:string}|null>(null);
  const [thinkingMsg, setThinkingMsg]     = useState<Message|null>(null);

  // ─ New UX states ────────────────────────────────────────────────────────────────
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [copiedId, setCopiedId]             = useState<string|null>(null);
  const [toast, setToast]                   = useState<{msg:string;type:'ok'|'err'}|null>(null);
  const [lastSentText, setLastSentText]     = useState('');

  // Upload state
  const [isDragging, setIsDragging]       = useState(false);
  const [uploadStatus, setUploadStatus]   = useState<string|null>(null);
  const [urlInput, setUrlInput]           = useState('');
  const [textInput, setTextInput]         = useState('');
  const [sourceInput, setSourceInput]     = useState('');
  const [analysisSteps, setAnalysisSteps] = useState<AnalysisStep[]|null>(null);
  const [uploading, setUploading]         = useState(false);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef     = useRef<HTMLInputElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, status]);
  useEffect(() => { loadStats(); }, []);
  // Rotating placeholder
  useEffect(() => {
    const t = setInterval(() => setPlaceholderIdx(i => (i + 1) % PLACEHOLDERS.length), 3500);
    return () => clearInterval(t);
  }, []);
  // Keyboard shortcuts: Escape 싹기, ⌘K 포커스
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowModal(false); setThinkingMsg(null); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); textareaRef.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const loadStats = async () => {
    try {
      const [s, h] = await Promise.all([
        fetch(`${API_URL}/api/memory/stats`),
        fetch(`${API_URL}/health`),
      ]);
      if (s.ok) { const d = await s.json(); setVecCount(d.count || 0); }
      if (h.ok) { const d = await h.json(); setServerInfo({ persona: d.persona, llm: d.llm, provider: d.provider }); }
    } catch { /**/ }
  };

  const newMsg = (role: Role, content: string, extra?: Partial<Message>): Message => ({
    id: crypto.randomUUID(), role, content, timestamp: new Date(), ...extra,
  });

  // ── SSE handler ────────────────────────────────────────────────────────────

  const handleEvent = useCallback((type: string, data: Record<string,unknown>, aid: string) => {
    switch (type) {
      case 'init':    if (data.conversationId) setConvId(data.conversationId as string); break;
      case 'status':  setStatus(data.message as string); break;
      case 'text':
        setMessages(p => p.map(m => m.id === aid ? { ...m, content: m.content + (data.delta as string) } : m));
        break;
      case 'original_text':
        setMessages(p => p.map(m => m.id === aid ? { ...m, originalText: data.content as string } : m));
        break;
      case 'replace_text':
        setMessages(p => p.map(m => m.id === aid ? { ...m, content: data.content as string } : m));
        break;
      case 'tool_start':
        setStatus(`🔧 ${data.tool} 실행 중...`);
        break;
      case 'tool_result':
        setMessages(p => p.map(m => m.id === aid
          ? { ...m, tools: [...(m.tools ?? []), { name: data.tool as string, result: data.result as string }] }
          : m
        )); break;
      case 'sources':
        setMessages(p => p.map(m => m.id === aid ? { ...m, sources: data.sources as Source[] } : m));
        break;
      case 'reflection':
        setMessages(p => p.map(m => m.id === aid ? { ...m, reflection: data as unknown as Reflection } : m));
        break;
      case 'process_trace':
        setMessages(p => p.map(m => m.id === aid
          ? { ...m, processTrace: (data as { steps: ProcessTraceStep[] }).steps }
          : m
        ));
        break;
      case 'done':
        setMessages(p => p.map(m => m.id === aid ? { ...m, latency: data.latency as string, modelUsed: data.provider as string } : m));
        break;
      case 'error':
        setMessages(p => p.map(m => m.id === aid ? { ...m, content: m.content || `❌ ${data.message}` } : m));
        break;
    }
  }, []);

  // ── Send message ───────────────────────────────────────────────────────────

  const send = useCallback(async (text?: string) => {
    const t = (text ?? input).trim();
    if (!t || loading) return;
    setLastSentText(t);

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const userMsg = newMsg('user', t);
    const aid = crypto.randomUUID();
    const aMsg: Message = { id: aid, role: 'assistant', content: '', timestamp: new Date(), sources: [], tools: [] };

    setMessages(p => [...p, userMsg, aMsg]);
    setLoading(true); setStatus('응답 생성 중...');

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: t, conversationId: convId, useReflection: true }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);

      const body = await res.text();
      const lines = body.trim().split('\n');

      // Parse all NDJSON events
      const events: Array<{ event: string; data: Record<string,unknown> }> = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /**/ }
      }

      console.log('[CHAT] Parsed events:', events.map(e => e.event));

      // Separate text deltas (for typewriter) from other events (instant)
      let fullText = '';
      let replacementText: string | null = null;

      for (const { event, data } of events) {
        if (event === 'text') {
          fullText += (data.delta as string) || '';
        } else if (event === 'replace_text') {
          // Only accept non-empty string replacements
          const rt = data.content;
          if (typeof rt === 'string' && rt.length > 0) {
            replacementText = rt;
          }
        } else if (event === 'original_text') {
          // Store original text directly - don't go through handleEvent
          const ot = data.content;
          if (typeof ot === 'string' && ot.length > 0) {
            setMessages(p => p.map(m => m.id === aid ? { ...m, originalText: ot } : m));
          }
        } else {
          // Apply non-text events immediately
          handleEvent(event, data, aid);
        }
      }

      console.log('[CHAT] fullText length:', fullText.length, '| replacementText:', replacementText ? replacementText.length : 'null');

      // Typewriter animation for the text
      const textToType = (replacementText && replacementText.length > 0) ? replacementText : fullText;
      if (textToType && textToType.length > 0) {
        const CHARS_PER_TICK = 3;
        const TICK_MS = 10;

        for (let i = 0; i < textToType.length; i += CHARS_PER_TICK) {
          const chunk = textToType.slice(0, i + CHARS_PER_TICK);
          setMessages(p => p.map(m => m.id === aid ? { ...m, content: chunk } : m));
          await new Promise(r => setTimeout(r, TICK_MS));
        }
        // Ensure final text is set completely
        setMessages(p => p.map(m => m.id === aid ? { ...m, content: textToType } : m));
      }

    } catch (err) {
      setMessages(p => p.map(m => m.id === aid
        ? { ...m, content: m.content || `❌ 연결 오류: ${err instanceof Error ? err.message : '알 수 없는 오류'}` }
        : m
      ));
    } finally {
      setLoading(false); setStatus(null); loadStats();
    }
  }, [input, loading, convId, handleEvent]);

  // ── Clear conversation ─────────────────────────────────────────────────────

  const clearConv = async () => {
    if (convId) await fetch(`${API_URL}/api/chat/${convId}`, { method: 'DELETE' }).catch(()=>{});
    setMessages([]); setConvId(null); setStatus(null);
  };

  // ── Utility: copy + retry ────────────────────────────────────────────────

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
      .then(() => {
        setCopiedId(id);
        setToast({ msg: '클립보드에 복사되었습니다', type: 'ok' });
        setTimeout(() => setCopiedId(null), 2000);
      })
      .catch(() => setToast({ msg: '복사 실패', type: 'err' }));
  };

  const handleRetry = () => {
    setMessages(p => {
      const last = p[p.length - 1];
      return last?.role === 'assistant' ? p.slice(0, -1) : p;
    });
    if (lastSentText) send(lastSentText);
  };

  // ── Upload helpers ─────────────────────────────────────────────────────────

  const doUploadFile = async (file: File) => {
    setUploading(true); setUploadStatus(`📄 ${file.name} 분석 중...`); setAnalysisSteps(null);
    const fd = new FormData();
    fd.append('file', file); fd.append('sourceType', 'note'); fd.append('source', file.name.replace(/\.[^.]+$/, ''));
    try {
      const res = await fetch(`${API_URL}/api/ingest`, { method: 'POST', body: fd });
      const d = await res.json();
      if (res.ok) { setUploadStatus(`✅ ${d.chunks}개 청크 인덱싱 완료`); setAnalysisSteps(d.analysis); loadStats(); }
      else setUploadStatus(`❌ ${d.error}`);
    } catch { setUploadStatus('❌ 업로드 실패'); }
    setUploading(false);
  };

  const doUploadUrl = async () => {
    if (!urlInput.trim()) return;
    setUploading(true); setUploadStatus('🌐 URL 수집 중...'); setAnalysisSteps(null);
    try {
      const res = await fetch(`${API_URL}/api/ingest/url`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput.trim(), source: sourceInput || undefined }),
      });
      const d = await res.json();
      if (res.ok) { setUploadStatus(`✅ ${d.chunks}개 청크 인덱싱 완료 (${d.domain})`); setAnalysisSteps(d.analysis); loadStats(); }
      else setUploadStatus(`❌ ${d.error}`);
    } catch { setUploadStatus('❌ URL 수집 실패'); }
    setUploading(false);
  };

  const doUploadText = async () => {
    if (textInput.trim().length < 20) { setUploadStatus('⚠️ 최소 20자 이상 입력하세요'); return; }
    setUploading(true); setUploadStatus('📝 텍스트 분석 중...'); setAnalysisSteps(null);
    try {
      const res = await fetch(`${API_URL}/api/ingest/text`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textInput.trim(), source: sourceInput || '직접 입력' }),
      });
      const d = await res.json();
      if (res.ok) { setUploadStatus(`✅ ${d.chunks}개 청크 인덱싱 완료`); setAnalysisSteps(d.analysis); loadStats(); }
      else setUploadStatus(`❌ ${d.error}`);
    } catch { setUploadStatus('❌ 텍스트 처리 실패'); }
    setUploading(false);
  };

  const closeModal = () => {
    setShowModal(false); setAnalysisSteps(null); setUploadStatus(null);
    setUrlInput(''); setTextInput(''); setSourceInput('');
  };

  const toggleExpanded = (id: string) =>
    setExpanded(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="app">
      {/* ─── Sidebar ─── */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <div className="brand-icon">🧠</div>
            <div>
              <div className="brand-name">나의 AI</div>
              <div className="brand-tagline">내 경험·지식을 아는 AI</div>
            </div>
          </div>
          <button className="new-chat-btn" onClick={clearConv} id="new-chat-btn">
            <span>✏️</span> 새 대화 시작
          </button>
        </div>

        <div className="sidebar-body">
          {/* 온보딩 카드 — 지식 0개일 때 */}
          {vecCount === 0 && (
            <div className="onboard-card">
              <div className="onboard-card-title">🎯 시작하기</div>
              <div className="onboard-step onboard-done">✅ AI 에이전트 실행 중</div>
              <button className="onboard-step onboard-todo" onClick={() => setShowModal(true)}>
                📁 첫 지식 추가하기 →
              </button>
            </div>
          )}

          <div className="sidebar-label">빠른 질문</div>
          {SUGGESTIONS.map((s, i) => (
            <button key={i} id={`q-${i}`} className="quick-btn" onClick={() => send(s.text)}>
              <span className="q-icon">{s.icon}</span>
              {s.text}
            </button>
          ))}

          <div className="sidebar-label" style={{marginTop:16}}>
            지식 베이스
            {vecCount > 0 && <span className="sidebar-vec-badge">{vecCount.toLocaleString()}</span>}
          </div>
          <button className="quick-btn" onClick={() => setShowModal(true)} id="sidebar-upload-btn">
            <span className="q-icon">📁</span>
            지식 추가하기
          </button>

          <div className="sidebar-label" style={{marginTop:16}}>개발자 도구</div>
          <Link href="/knowledge" style={{textDecoration:'none'}}>
            <button className="quick-btn" id="sidebar-kb-btn" style={{width:'100%', textAlign:'left'}}>
              <span className="q-icon">🗂️</span>
              지식 베이스 탐색
            </button>
          </Link>
          <Link href="/lab" style={{textDecoration:'none'}}>
            <button className="quick-btn" id="sidebar-lab-btn" style={{width:'100%', textAlign:'left'}}>
              <span className="q-icon">🧪</span>
              AI 학습 실험실
            </button>
          </Link>
        </div>

        <div className="sidebar-bottom">
          <div className="status-badge">
            <div className="status-dot" />
            <div>
              <div className="status-label">
                모드: <strong>{serverInfo?.persona ?? '…'}</strong>
              </div>
              <div className="status-model">
                {serverInfo ? `${serverInfo.provider.toUpperCase()} · ${serverInfo.llm}` : '연결 중…'}
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* ─── Main ─── */}
      <div className="main">
        <header className="chat-header">
          <div>
            <div className="header-title">나의 AI — 개인 지식 에이전트</div>
            <div className="header-sub">
              {convId ? `세션 ${convId.slice(0,8)}` : '새 대화'}
            </div>
          </div>
          <div className="header-btns">
            <button className="icon-btn" onClick={() => setShowModal(true)} title="지식 추가" id="header-upload-btn">📎</button>
            <button className="icon-btn" onClick={clearConv} title="대화 초기화" id="clear-btn">🗑️</button>
          </div>
        </header>

        <div className="messages">
          <div className="messages-inner">
            {messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-logo">🧠</div>
                <div className="welcome-title">나의 AI에 오신 것을 환영합니다</div>
                <p className="welcome-desc">
                  내 경험, 기술 스택, 프로젝트를 학습하고<br/>
                  마치 내가 직접 답하듯 추론하는 개인 AI 에이전트입니다.
                </p>

                {/* Feature pills */}
                <div className="welcome-features">
                  <div className="welcome-feat">
                    <span className="welcome-feat-icon">🔍</span>
                    <div className="welcome-feat-name">RAG 검색</div>
                    <div className="welcome-feat-desc">벡터 유사도 기반 지식 검색</div>
                  </div>
                  <div className="welcome-feat">
                    <span className="welcome-feat-icon">🪿</span>
                    <div className="welcome-feat-name">Self-Reflection</div>
                    <div className="welcome-feat-desc">답변을 스스로 비판하고 개선</div>
                  </div>
                  <div className="welcome-feat">
                    <span className="welcome-feat-icon">⚡</span>
                    <div className="welcome-feat-name">멀티 모델</div>
                    <div className="welcome-feat-desc">Groq + Gemini 자동 페일오버</div>
                  </div>
                </div>

                {/* Onboarding banner when no knowledge */}
                {vecCount === 0 && (
                  <div className="welcome-onboard">
                    <div className="welcome-onboard-icon">💡</div>
                    <div>
                      <strong>첫 번째 지식을 추가해보세요</strong>
                      <p>지식 베이스가 비어있으면 AI가 일반적인 답변만 할 수 있어요.<br/>파일·URL·텍스트를 추가하면 내 경험 기반으로 답할 수 있습니다.</p>
                      <button className="onboard-add-btn" onClick={() => setShowModal(true)}>📁 지식 추가하기 →</button>
                    </div>
                  </div>
                )}

                <div className="chips">
                  {SUGGESTIONS.map((s, i) => (
                    <button key={i} id={`chip-${i}`} className="chip" onClick={() => send(s.text)}>
                      <span className="chip-icon">{s.icon}</span>
                      {s.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map(msg => (
                <div key={msg.id} className={`msg ${msg.role}`}>
                  <div className="avatar">{msg.role === 'user' ? '👤' : '🧠'}</div>
                  <div className="msg-body">
                    {/* Bubble */}
                    {msg.role === 'assistant' && msg.content === '' && loading ? (
                      <div className="bubble">
                        <div className="thinking">
                          <div className="dot"/><div className="dot"/><div className="dot"/>
                        </div>
                      </div>
                    ) : (
                      <div className="bubble-wrap">
                        <div
                          className="bubble"
                          dangerouslySetInnerHTML={{ __html:
                            msg.role === 'assistant'
                              ? `<p>${md(msg.content)}</p>`
                              : msg.content
                          }}
                        />
                        {/* Copy button */}
                        {msg.role === 'assistant' && msg.content && !msg.content.startsWith('❌') && (
                          <button
                            className={`copy-btn${copiedId === msg.id ? ' copied' : ''}`}
                            onClick={() => copyText(msg.content, msg.id)}
                            title="복사"
                          >
                            {copiedId === msg.id ? '✅' : '📋'}
                          </button>
                        )}
                      </div>
                    )}

                    {/* ─── Inline sources (knowledge references) ─── */}
                    {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                      <SourcesPanel sources={msg.sources} />
                    )}

                    {/* Reflection badge (improved indicator) */}
                    {msg.reflection && (
                      <div className="reflect-badge">
                        {msg.reflection.improved ? '✨ 답변 개선됨' : '✅ 답변 검토 완료'}
                      </div>
                    )}

                    {/* 사고 과정 상세 버튼 */}
                    {msg.role === 'assistant' && msg.latency && (
                      (msg.tools?.length || msg.reflection || msg.originalText) ? (
                        <button
                          className="thinking-open-btn"
                          onClick={() => setThinkingMsg(msg)}
                        >
                          💡 사고 과정 상세
                        </button>
                      ) : null
                    )}

                    {/* ─── 처리 시퀀스 패널 ─── */}
                    {msg.role === 'assistant' && msg.processTrace && msg.processTrace.length > 0 && (
                      <ProcessSequencePanel steps={msg.processTrace} msgId={msg.id} />
                    )}

                      {/* Error retry */}
                      {msg.role === 'assistant' && msg.content.startsWith('❌') && (
                        <button className="retry-btn" onClick={handleRetry}>
                          🔄 다시 시도
                        </button>
                      )}

                      <div className="msg-time">
                        {msg.timestamp.toLocaleTimeString('ko-KR', {hour:'2-digit',minute:'2-digit'})}
                        {msg.latency && ` · ${msg.latency}`}
                        {msg.modelUsed && (
                          <span className="model-badge">{msg.modelUsed.split('/')[0].toUpperCase()}</span>
                        )}
                      </div>
                  </div>
                </div>
              ))
            )}

            {/* Status pill */}
            {loading && status && (
              <div className="status-pill">
                <div className="spin"/>
                {status}
              </div>
            )}
            <div ref={bottomRef}/>
          </div>
        </div>

        {/* Stats bar */}
        <div className="stats-bar">
          <div className="stat">🧠 벡터 지식: <span className="stat-val">{vecCount.toLocaleString()}</span>개</div>
          {convId && (
            <div className="stat">💬 대화: <span className="stat-val">{messages.filter(m=>m.role==='user').length}</span>턴</div>
          )}
        </div>

        {/* Input */}
        <div className="input-area">
          <div className="input-box">
            <div className="input-wrap">
              <textarea
                ref={textareaRef}
                id="chat-input"
                className="chat-textarea"
                placeholder={loading ? '응답 생성 중…' : PLACEHOLDERS[placeholderIdx]}
                value={input}
                rows={1}
                disabled={loading}
                onChange={e => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                }}
              />
              <div className="input-actions">
                {input.length > 0 && <span className="char-count">{input.length}</span>}
                <button className="attach-btn" onClick={() => setShowModal(true)} title="지식 추가" id="attach-btn">📎</button>
                <button
                  id="send-btn"
                  className={`send-btn${loading ? ' spinning' : ''}`}
                  onClick={() => send()}
                  disabled={loading || !input.trim()}
                  title="전송"
                >
                  {loading ? '⟳' : '↑'}
                </button>
              </div>
            </div>
            <div className="input-hint">
              <span>⌘K 입력창 포커스</span>
              <span className="hint-dot">·</span>
              <span>Enter 전송</span>
              <span className="hint-dot">·</span>
              <span>Shift+Enter 줄바꿈</span>
              <span className="hint-dot">·</span>
              <span>Esc 닫기</span>
            </div>
          </div>
        </div>

      </div>

      {/* ─── Thinking Process Modal ─── */}
      {thinkingMsg && (
        <div className="backdrop" onClick={e => { if (e.target === e.currentTarget) setThinkingMsg(null); }}>
          <div className="modal thinking-modal" id="thinking-modal">
            <div className="modal-header">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div className="modal-title">💡 AI 사고 과정 상세</div>
                <button className="think-close-btn" onClick={() => setThinkingMsg(null)}>✕</button>
              </div>
              <div className="modal-desc">
                이 답변을 생성하기 위해 AI가 수행한 모든 단계를 확인할 수 있습니다.
              </div>
              {thinkingMsg.latency && (
                <div className="think-latency">⏱ 총 소요 시간: {thinkingMsg.latency}</div>
              )}
              {thinkingMsg.modelUsed && (
                <div className="think-latency" style={{marginTop: '4px'}}>🤖 사용 모델: <strong>{thinkingMsg.modelUsed}</strong></div>
              )}
            </div>

            <div className="think-modal-body">
              {/* Step 1: Tool executions */}
              {thinkingMsg.tools && thinkingMsg.tools.length > 0 && (
                <div className="think-section">
                  <div className="think-section-title">🔧 도구 실행 ({thinkingMsg.tools.length}개)</div>
                  <div className="think-section-desc">질문에 답하기 위해 다음 도구를 호출했습니다.</div>
                  {thinkingMsg.tools.map((t, i) => (
                    <div key={i} className="think-tool">
                      <div className="think-tool-name">🛠️ {t.name}</div>
                      {t.result && <pre className="think-tool-result">{t.result}</pre>}
                    </div>
                  ))}
                </div>
              )}

              {/* Step 2: Referenced sources — rich diagram */}
              {thinkingMsg.sources && thinkingMsg.sources.length > 0 && (
                <div className="think-section">
                  <div className="think-section-title">📚 참조한 지식 — {thinkingMsg.sources.length}개 청크</div>
                  <div className="think-section-desc">코사인 유사도 기반 벡터 검색 결과입니다. 클릭하면 원문을 확인할 수 있습니다.</div>

                  {/* Similarity overview bar */}
                  <div className="tsrc-overview">
                    <div className="tsrc-overview-label">유사도 분포</div>
                    <div className="tsrc-overview-bars">
                      {thinkingMsg.sources.map((s, i) => {
                        const { color } = scoreLabel(s.score);
                        const topS = Math.max(...(thinkingMsg.sources ?? []).map(x => x.score));
                        const pct = topS > 0 ? (s.score / topS) * 100 : 0;
                        return (
                          <div key={s.id} className="tsrc-overview-bar-wrap" title={`${s.source}: ${(s.score*100).toFixed(1)}%`}>
                            <div className="tsrc-overview-bar" style={{ height: `${Math.max(10, pct)}%`, background: color }} />
                            <div className="tsrc-overview-bar-num" style={{ color }}>{i+1}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Source cards */}
                  <div className="tsrc-cards">
                    {thinkingMsg.sources.map((s, i) => {
                      const { label, color } = scoreLabel(s.score);
                      const cc = catColor(s.category);
                      return (
                        <div key={s.id} className="tsrc-card" style={{ '--cc': cc } as React.CSSProperties}>
                          <div className="tsrc-card-top">
                            <div className="tsrc-card-rank" style={{ background: `${cc}22`, color: cc, borderColor: `${cc}44` }}>{i+1}</div>
                            <div className="tsrc-card-icon" style={{ color: cc }}>{catIcon(s.category)}</div>
                            <div className="tsrc-card-info">
                              <div className="tsrc-card-name">{s.source}</div>
                              {s.category && <span className="tsrc-card-cat" style={{ background: `${cc}15`, color: cc }}>{s.category}</span>}
                            </div>
                            <div className="tsrc-score-block">
                              <div className="tsrc-score-num" style={{ color }}>{(s.score*100).toFixed(1)}%</div>
                              <div className="tsrc-score-label" style={{ color }}>{label}</div>
                            </div>
                          </div>

                          {/* Inline score bar */}
                          <div className="tsrc-bar-track">
                            <div className="tsrc-bar-fill" style={{ width: `${s.score*100}%`, background: `linear-gradient(90deg, ${color}55, ${color})` }} />
                          </div>

                          {/* Preview */}
                          <div className="tsrc-preview">
                            {s.content.slice(0, 160)}{s.content.length > 160 ? '…' : ''}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Step 3: Original draft */}
              {thinkingMsg.originalText && (
                <div className="think-section">
                  <div className="think-section-title">📝 최초 생성 초안</div>
                  <div className="think-section-desc">Reflection 이전에 LLM이 생성한 원본 답변입니다.</div>
                  <div className="think-original" dangerouslySetInnerHTML={{ __html: `<p>${md(thinkingMsg.originalText)}</p>` }} />
                </div>
              )}

              {/* Step 4: Reflection critique */}
              {thinkingMsg.reflection && (
                <div className="think-section">
                  <div className="think-section-title">🪞 자기 비판 (Reflection)</div>
                  <div className="think-section-desc">AI가 초안을 스스로 비판하고 개선 여부를 판단한 과정입니다.</div>
                  <div className="think-critique">{thinkingMsg.reflection.critique}</div>
                  <div className="think-verdict">
                    {thinkingMsg.reflection.improved
                      ? '✅ 비판 결과: 초안의 부족한 점을 발견하여 답변을 개선했습니다.'
                      : '✅ 비판 결과: 개선이 필요하지 않아 원본을 유지했습니다.'}
                  </div>
                </div>
              )}

              {/* No details available */}
              {!thinkingMsg.tools?.length && !thinkingMsg.sources?.length && !thinkingMsg.originalText && !thinkingMsg.reflection && (
                <div className="think-section">
                  <div className="think-section-title">📋 사고 과정 요약</div>
                  <div className="think-section-desc">이 답변은 별도의 도구 호출이나 지식 검색 없이 생성되었습니다.</div>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setThinkingMsg(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Upload Modal ─── */}
      {showModal && (
        <div className="backdrop" onClick={e => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="modal" id="upload-modal">
            <div className="modal-header">
              <div className="modal-title">📚 지식 추가하기</div>
              <div className="modal-desc">
                파일, URL, 텍스트 — 어떤 방식으로든 내 지식 베이스에 추가할 수 있습니다.
              </div>
            </div>

            {/* Tabs */}
            <div className="tabs">
              <button className={`tab-btn${modalTab==='file'?' active':''}`} onClick={() => { setModalTab('file'); setAnalysisSteps(null); setUploadStatus(null); }}>📄 파일 업로드</button>
              <button className={`tab-btn${modalTab==='url'?' active':''}`} onClick={() => { setModalTab('url'); setAnalysisSteps(null); setUploadStatus(null); }}>🌐 URL 링크</button>
              <button className={`tab-btn${modalTab==='text'?' active':''}`} onClick={() => { setModalTab('text'); setAnalysisSteps(null); setUploadStatus(null); }}>📝 텍스트 붙여넣기</button>
            </div>

            {/* File tab */}
            {modalTab === 'file' && (
              <div>
                <div
                  className={`dropzone${isDragging?' over':''}`}
                  onDragOver={e=>{e.preventDefault();setIsDragging(true);}}
                  onDragLeave={()=>setIsDragging(false)}
                  onDrop={e=>{e.preventDefault();setIsDragging(false);const f=e.dataTransfer.files[0];if(f)doUploadFile(f);}}
                  onClick={()=>fileRef.current?.click()}
                >
                  <div className="dropzone-icon">{uploading ? '⏳' : '☁️'}</div>
                  <div className="dropzone-text">{uploading ? '분석 중...' : '파일을 끌어다 놓거나 클릭하여 선택'}</div>
                  <div className="dropzone-hint">.pdf · .md · .txt · .json · 최대 10MB</div>
                  <input ref={fileRef} type="file" accept=".pdf,.md,.txt,.json" style={{display:'none'}}
                    onChange={e=>{const f=e.target.files?.[0];if(f)doUploadFile(f);}} />
                </div>
              </div>
            )}

            {/* URL tab */}
            {modalTab === 'url' && (
              <div>
                <div className="url-note">
                  ⚠️ <span>로그인이 필요하거나 JavaScript 렌더링이 필요한 페이지(SPA)는 수집이 제한됩니다. 공개 블로그, 문서, Wikipedia 등에 최적화되어 있습니다.</span>
                </div>
                <label className="field-label">웹페이지 URL</label>
                <input className="field-input" type="url" placeholder="https://example.com/article" value={urlInput} onChange={e=>setUrlInput(e.target.value)} />
                <div className="field-note" style={{marginBottom:12}}>공개 접근 가능한 URL만 지원됩니다 (http / https)</div>
                <label className="field-label">소스 이름 (선택)</label>
                <input className="field-input" placeholder="예: 내 블로그 포스트" value={sourceInput} onChange={e=>setSourceInput(e.target.value)} />
                <div className="modal-actions" style={{marginTop:14}}>
                  <button className="btn btn-ghost" onClick={closeModal}>취소</button>
                  <button className="btn btn-primary" onClick={doUploadUrl} disabled={uploading || !urlInput.trim()}>
                    {uploading ? '수집 중...' : '🌐 URL 수집 시작'}
                  </button>
                </div>
              </div>
            )}

            {/* Text tab */}
            {modalTab === 'text' && (
              <div>
                <label className="field-label">텍스트 붙여넣기</label>
                <textarea className="field-input" placeholder="여기에 텍스트를 붙여넣기하세요. 회의록, 아티클, 노트, 코드 설명 등 무엇이든 가능합니다." value={textInput} onChange={e=>setTextInput(e.target.value)} style={{minHeight:130}} />
                <div className="field-note" style={{marginBottom:12}}>최소 20자 이상 · Markdown 형식 지원</div>
                <label className="field-label">소스 이름 (선택)</label>
                <input className="field-input" placeholder="예: 2024 회의록, 기술 노트" value={sourceInput} onChange={e=>setSourceInput(e.target.value)} />
                <div className="modal-actions" style={{marginTop:14}}>
                  <button className="btn btn-ghost" onClick={closeModal}>취소</button>
                  <button className="btn btn-primary" onClick={doUploadText} disabled={uploading || textInput.trim().length < 20}>
                    {uploading ? '분석 중...' : '📝 추가하기'}
                  </button>
                </div>
              </div>
            )}

            {/* Upload status */}
            {uploadStatus && (
              <div style={{marginTop:14, padding:'10px 12px', background:'rgba(255,255,255,0.03)', borderRadius:10, fontSize:13, color: uploadStatus.startsWith('✅') ? '#34d399' : uploadStatus.startsWith('❌') ? '#fb7185' : '#9490b8'}}>
                {uploadStatus}
              </div>
            )}

            {/* Analysis steps */}
            {analysisSteps && (
              <div className="analysis-card">
                <div className="analysis-title">✨ 분석 과정</div>
                {analysisSteps.map((s, i) => (
                  <div key={i} className="analysis-step" style={{animationDelay:`${i*80}ms`}}>
                    <div className="step-num">{s.step}</div>
                    <div className="step-info">
                      <div className="step-label">{s.label}</div>
                      <div className="step-detail">{s.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Close for file tab */}
            {modalTab === 'file' && (
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={closeModal}>닫기</button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* ─── Toast ─── */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          <span className="toast-icon">{toast.type === 'ok' ? '✅' : '⚠️'}</span>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
