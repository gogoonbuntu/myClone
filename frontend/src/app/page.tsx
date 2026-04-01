'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

type Role = 'user' | 'assistant';

interface Source { id: string; content: string; score: number; source: string; category?: string; }
interface ToolEvent { name: string; result?: string; }
interface Reflection { improved: boolean; critique: string; }
interface AnalysisStep { step: number; label: string; detail: string; }

interface Message {
  id: string; role: Role; content: string; timestamp: Date;
  sources?: Source[]; tools?: ToolEvent[];
  reflection?: Reflection; latency?: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const SUGGESTIONS = [
  { icon: '🚀', text: '내 프로젝트 중 가장 복잡했던 것과 해결 방법을 알려줘' },
  { icon: '🧠', text: '새로운 기술을 배울 때 내가 쓰는 접근 방식은 뭐야?' },
  { icon: '⚡', text: 'TypeScript를 왜 쓰는지 내 실제 경험 기반으로 설명해줘' },
  { icon: '💡', text: '개발하면서 가장 크게 배운 교훈을 알려줘' },
];

// ─── Simple Markdown renderer ─────────────────────────────────────────────────

function md(text: string): string {
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
      case 'done':
        setMessages(p => p.map(m => m.id === aid ? { ...m, latency: data.latency as string } : m));
        break;
      case 'error':
        setMessages(p => p.map(m => m.id === aid ? { ...m, content: `❌ ${data.message}` } : m));
        break;
    }
  }, []);

  // ── Send message ───────────────────────────────────────────────────────────

  const send = useCallback(async (text?: string) => {
    const t = (text ?? input).trim();
    if (!t || loading) return;

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const userMsg = newMsg('user', t);
    const aid = crypto.randomUUID();
    const aMsg: Message = { id: aid, role: 'assistant', content: '', timestamp: new Date(), sources: [], tools: [] };

    setMessages(p => [...p, userMsg, aMsg]);
    setLoading(true); setStatus(null);

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: t, conversationId: convId, useReflection: true }),
      });
      if (!res.ok || !res.body) throw new Error(`API ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', curEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) { curEvent = line.slice(7).trim(); }
          else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              handleEvent(curEvent, data, aid);
            } catch { /**/ }
          }
        }
      }
    } catch (err) {
      setMessages(p => p.map(m => m.id === aid
        ? { ...m, content: `❌ 연결 오류: ${err instanceof Error ? err.message : '알 수 없는 오류'}` }
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
          <div className="sidebar-label">빠른 질문</div>
          {SUGGESTIONS.map((s, i) => (
            <button key={i} id={`q-${i}`} className="quick-btn" onClick={() => send(s.text)}>
              <span className="q-icon">{s.icon}</span>
              {s.text}
            </button>
          ))}

          <div className="sidebar-label" style={{marginTop:16}}>지식 베이스</div>
          <button className="quick-btn" onClick={() => setShowModal(true)} id="sidebar-upload-btn">
            <span className="q-icon">📁</span>
            지식 추가하기
          </button>

          <div className="sidebar-label" style={{marginTop:16}}>개발자 도구</div>
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
                  내 과거 경험, 기술 스택, 프로젝트, 메모를 학습하고<br/>
                  마치 내가 직접 답하듯 추론하는 개인 AI 에이전트입니다.
                </p>
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
                      <div
                        className="bubble"
                        dangerouslySetInnerHTML={{ __html:
                          msg.role === 'assistant'
                            ? `<p>${md(msg.content)}</p>`
                            : msg.content
                        }}
                      />
                    )}

                    {/* Sources */}
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="sources-panel">
                        <div className="sources-toggle" onClick={() => toggleExpanded(msg.id)}>
                          📚 {msg.sources.length}개 지식 참조됨 {expanded.has(msg.id) ? '▲' : '▼'}
                        </div>
                        {expanded.has(msg.id) && (
                          <div style={{marginTop:6}}>
                            {msg.sources.map(s => (
                              <span key={s.id} className="source-tag" title={s.content}>
                                📄 {s.source}{s.category ? ` / ${s.category}` : ''} ({(s.score*100).toFixed(0)}%)
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Tools */}
                    {msg.tools && msg.tools.length > 0 && (
                      <div style={{display:'flex',flexDirection:'column',gap:5}}>
                        {msg.tools.map((t, i) => (
                          <div key={i}>
                            <div className="tool-badge">🔧 {t.name}</div>
                            {t.result && <div className="tool-result">{t.result}</div>}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Reflection */}
                    {msg.reflection && (
                      <div className="reflect-badge">
                        {msg.reflection.improved ? '✨ 답변 개선됨' : '✅ 답변 검토 완료'}
                      </div>
                    )}

                    <div className="msg-time">
                      {msg.timestamp.toLocaleTimeString('ko-KR', {hour:'2-digit',minute:'2-digit'})}
                      {msg.latency && ` · ${msg.latency}`}
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
                placeholder="무엇이든 물어보세요… (Enter: 전송, Shift+Enter: 줄바꿈)"
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
            <div className="input-hint">나의 AI · Groq + Gemini Failover · RAG 기반 개인 지식 검색</div>
          </div>
        </div>
      </div>

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
    </div>
  );
}
