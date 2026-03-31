'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

type Role = 'user' | 'assistant';

interface Source {
  id: string;
  content: string;
  score: number;
  source: string;
  category?: string;
}

interface ToolEvent {
  name: string;
  result?: string;
}

interface Reflection {
  improved: boolean;
  critique: string;
}

interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: Date;
  sources?: Source[];
  tools?: ToolEvent[];
  reflection?: Reflection;
  latency?: string;
}

type StatusEvent = {
  type: 'status' | 'tool_start' | 'tool_result';
  message?: string;
  tool?: string;
  result?: string;
};

// ─── Markdown Renderer ────────────────────────────────────────────────────────

function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/^---$/gm, '<hr />')
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hup]|<li|<pre|<hr)(.+)$/gm, '$1')
    .replace(/^(.+)$/gm, (match) => {
      if (match.startsWith('<') || match.trim() === '') return match;
      return match;
    });
}

// ─── Suggestion Chips ─────────────────────────────────────────────────────────

const SUGGESTIONS = [
  { icon: '🚀', text: '내 프로젝트 중 가장 복잡했던 것은 무엇이고 어떻게 해결했어?' },
  { icon: '🧠', text: '내가 새로운 기술을 배울 때 어떤 접근 방식을 쓰는지 설명해줘' },
  { icon: '⚡', text: 'TypeScript를 왜 선택하는지, 내 실제 경험 기반으로 얘기해줘' },
  { icon: '💡', text: '개발하면서 가장 많이 배운 교훈은 뭐야?' },
];

// ─── API ──────────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [currentStatus, setCurrentStatus] = useState<string | null>(null);
  const [currentTools, setCurrentTools] = useState<ToolEvent[]>([]);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [knowledgeCount, setKnowledgeCount] = useState<number>(0);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [serverInfo, setServerInfo] = useState<{ persona: string; llm: string; provider: string } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentStatus]);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const [statsRes, healthRes] = await Promise.all([
        fetch(`${API_URL}/api/memory/stats`),
        fetch(`${API_URL}/health`),
      ]);
      if (statsRes.ok) {
        const data = await statsRes.json();
        setKnowledgeCount(data.count || 0);
      }
      if (healthRes.ok) {
        const health = await healthRes.json();
        setServerInfo({
          persona: health.persona || 'ENFP',
          llm: health.llm || 'unknown',
          provider: health.provider || 'unknown',
        });
      }
    } catch { /* ignore */ }
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const newMessage = (role: Role, content: string, extra?: Partial<Message>): Message => ({
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date(),
    ...extra,
  });

  const sendMessage = useCallback(async (text?: string) => {
    const messageText = (text ?? input).trim();
    if (!messageText || isLoading) return;

    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const userMsg = newMessage('user', messageText);
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setCurrentStatus(null);
    setCurrentTools([]);

    // Prepare assistant message placeholder
    const assistantMsgId = crypto.randomUUID();
    const assistantMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      sources: [],
      tools: [],
    };
    setMessages(prev => [...prev, assistantMsg]);

    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: messageText,
          conversationId,
          useReflection: true,
        }),
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            continue; // handled below with data
          }
          if (line.startsWith('data: ')) {
            const eventLine = lines[lines.indexOf(line) - 1] ?? '';
            const eventType = eventLine.replace('event: ', '').trim();
            const dataStr = line.replace('data: ', '').trim();

            try {
              const data = JSON.parse(dataStr);
              handleSSEEvent(eventType, data, assistantMsgId);
            } catch { /* skip malformed */ }
          }
        }
      }

      // Parse remaining buffer with event tracking
      const chunks = buffer.split('\n\n').filter(Boolean);
      for (const chunk of chunks) {
        const eventMatch = chunk.match(/event: (\w+)/);
        const dataMatch = chunk.match(/data: (.+)/);
        if (eventMatch && dataMatch) {
          try {
            const data = JSON.parse(dataMatch[1]);
            handleSSEEvent(eventMatch[1], data, assistantMsgId);
          } catch { /* skip */ }
        }
      }

    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId
          ? { ...m, content: `❌ 오류가 발생했습니다: ${err instanceof Error ? err.message : 'Unknown error'}` }
          : m
      ));
    } finally {
      setIsLoading(false);
      setCurrentStatus(null);
      fetchStats();
    }
  }, [input, isLoading, conversationId]);

  // Better SSE parsing — use a proper event stream reader
  const handleSSEEvent = (eventType: string, data: Record<string, unknown>, assistantMsgId: string) => {
    switch (eventType) {
      case 'init':
        if (data.conversationId) setConversationId(data.conversationId as string);
        break;

      case 'status':
        setCurrentStatus(data.message as string);
        break;

      case 'text':
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, content: m.content + (data.delta as string) }
            : m
        ));
        break;

      case 'tool_start':
        setCurrentTools(prev => [...prev, { name: data.tool as string }]);
        setCurrentStatus(`🔧 ${data.tool} 실행 중...`);
        break;

      case 'tool_result':
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? {
                ...m,
                tools: [
                  ...(m.tools ?? []),
                  { name: data.tool as string, result: data.result as string }
                ]
              }
            : m
        ));
        break;

      case 'sources':
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, sources: data.sources as Source[] }
            : m
        ));
        break;

      case 'reflection':
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, reflection: data as Reflection }
            : m
        ));
        break;

      case 'done':
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, latency: data.latency as string }
            : m
        ));
        break;

      case 'error':
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, content: `❌ ${data.message}` }
            : m
        ));
        break;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleFileUpload = async (file: File) => {
    setUploadStatus(`업로드 중: ${file.name}...`);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sourceType', 'note');
    formData.append('source', file.name.replace(/\.[^.]+$/, ''));

    try {
      const res = await fetch(`${API_URL}/api/ingest`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setUploadStatus(`✅ ${data.chunks}개 청크 인덱싱 완료!`);
        fetchStats();
      } else {
        setUploadStatus(`❌ 실패: ${data.error}`);
      }
    } catch {
      setUploadStatus('❌ 업로드 실패');
    }

    setTimeout(() => setUploadStatus(null), 3000);
    setShowUploadModal(false);
  };

  const clearConversation = async () => {
    if (conversationId) {
      await fetch(`${API_URL}/api/chat/${conversationId}`, { method: 'DELETE' });
    }
    setMessages([]);
    setConversationId(null);
    setCurrentStatus(null);
    setCurrentTools([]);
  };

  const toggleSources = (msgId: string) => {
    setExpandedSources(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  };

  return (
    <div className="app-layout">
      {/* ─── Sidebar ─── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="logo-icon">🧠</div>
            <span className="logo-text">PKA System</span>
          </div>
          <button className="new-chat-btn" onClick={clearConversation} id="new-chat-btn">
            <span>✏️</span> 새 대화
          </button>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section-title">빠른 질문</div>
          {SUGGESTIONS.map((s, i) => (
            <button
              key={i}
              id={`suggestion-${i}`}
              onClick={() => sendMessage(s.text)}
              style={{
                width: '100%',
                display: 'block',
                padding: '8px 10px',
                background: 'transparent',
                border: '1px solid transparent',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-secondary)',
                fontSize: '12px',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all var(--transition-fast)',
                marginBottom: '2px',
                lineHeight: '1.5',
              }}
              onMouseOver={e => {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
                (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
              }}
              onMouseOut={e => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
                (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
                (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)';
              }}
            >
              {s.icon} {s.text}
            </button>
          ))}

          <div className="sidebar-section-title" style={{ marginTop: '16px' }}>
            지식 베이스
          </div>
          <button
            id="upload-knowledge-btn"
            className="new-chat-btn"
            onClick={() => setShowUploadModal(true)}
            style={{ marginBottom: '8px' }}
          >
            <span>📁</span> 지식 업로드
          </button>

          {uploadStatus && (
            <div className="upload-progress">
              {uploadStatus}
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: '100%' }} />
              </div>
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="persona-badge">
            <div className="persona-dot" />
            <div>
              <div className="persona-text">
                모드: <span className="persona-mode">{serverInfo?.persona ?? 'ENFP'}</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {serverInfo
                  ? `${serverInfo.provider.toUpperCase()} · ${serverInfo.llm}`
                  : '연결 중...'}
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* ─── Main Chat ─── */}
      <main className="chat-main">
        <header className="chat-header">
          <div>
            <div className="chat-header-title">Personal Knowledge AI Agent</div>
            <div className="chat-header-meta">
              {conversationId ? `세션: ${conversationId.slice(0, 8)}...` : '새 대화'}
            </div>
          </div>
          <div className="header-actions">
            <button
              id="clear-chat-btn"
              className="icon-btn"
              onClick={clearConversation}
              title="대화 초기화"
            >
              🗑️
            </button>
            <button
              id="upload-header-btn"
              className="icon-btn"
              onClick={() => setShowUploadModal(true)}
              title="지식 업로드"
            >
              📤
            </button>
          </div>
        </header>

        {/* ─── Messages ─── */}
        <div className="messages-container" id="messages-container">
          {messages.length === 0 ? (
            <div className="welcome-screen">
              <div className="welcome-icon">🧠</div>
              <h1 className="welcome-title">Personal Knowledge AI</h1>
              <p className="welcome-subtitle">
                나의 경험, 사고방식, 기술 스택을 기반으로 답변하는 AI입니다.
                무엇이든 물어보세요.
              </p>
              <div className="suggestion-grid">
                {SUGGESTIONS.map((s, i) => (
                  <button
                    key={i}
                    id={`welcome-suggestion-${i}`}
                    className="suggestion-chip"
                    onClick={() => sendMessage(s.text)}
                  >
                    <span className="chip-icon">{s.icon}</span>
                    {s.text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map(msg => (
              <div key={msg.id} className={`message ${msg.role}`}>
                <div className="message-avatar">
                  {msg.role === 'user' ? '👤' : '🧠'}
                </div>

                <div className="message-body">
                  {/* Thinking indicator for empty assistant message */}
                  {msg.role === 'assistant' && msg.content === '' && isLoading ? (
                    <div className="message-bubble">
                      <div className="thinking-dots">
                        <div className="thinking-dot" />
                        <div className="thinking-dot" />
                        <div className="thinking-dot" />
                      </div>
                    </div>
                  ) : (
                    <div
                      className="message-bubble"
                      dangerouslySetInnerHTML={{ __html:
                        msg.role === 'assistant'
                          ? '<p>' + renderMarkdown(msg.content) + '</p>'
                          : msg.content
                      }}
                    />
                  )}

                  {/* Sources */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="sources-panel">
                      <div
                        className="sources-header"
                        onClick={() => toggleSources(msg.id)}
                      >
                        📚 {msg.sources.length}개 지식 소스 사용됨
                        <span>{expandedSources.has(msg.id) ? '▲' : '▼'}</span>
                      </div>
                      {expandedSources.has(msg.id) && msg.sources.map(s => (
                        <span key={s.id} className="source-chip" title={s.content}>
                          📄 {s.source || 'unknown'}
                          {s.category ? ` / ${s.category}` : ''}
                          {' '}({(s.score * 100).toFixed(0)}%)
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Tool Results */}
                  {msg.tools && msg.tools.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {msg.tools.map((t, i) => (
                        <div key={i}>
                          <div className="tool-badge">
                            🔧 {t.name}
                          </div>
                          {t.result && (
                            <div className="tool-result-card">
                              {t.result}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Reflection */}
                  {msg.reflection && (
                    <div className="reflection-badge">
                      {msg.reflection.improved ? '✨ 답변이 개선되었습니다' : '✅ 답변 검토 완료'}
                    </div>
                  )}

                  <div className="message-time">
                    {msg.timestamp.toLocaleTimeString('ko-KR', {
                      hour: '2-digit', minute: '2-digit'
                    })}
                    {msg.latency && ` · ${msg.latency}`}
                  </div>
                </div>
              </div>
            ))
          )}

          {/* Current Status */}
          {isLoading && currentStatus && (
            <div className="status-message">
              <div className="status-spinner" />
              {currentStatus}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* ─── Stats Bar ─── */}
        <div className="stats-bar">
          <div className="stat-item">
            🧠 지식 베이스: <span className="stat-value">{knowledgeCount}</span>개 벡터
          </div>
          {conversationId && (
            <div className="stat-item">
              💬 세션: <span className="stat-value">{messages.filter(m=>m.role==='user').length}</span> 턴
            </div>
          )}
        </div>

        {/* ─── Input Area ─── */}
        <div className="input-area">
          <div className="input-wrapper">
            <textarea
              ref={textareaRef}
              id="chat-input"
              className="chat-input"
              placeholder="무엇이든 물어보세요... (Shift+Enter로 줄바꿈)"
              value={input}
              onChange={e => {
                setInput(e.target.value);
                autoResize(e.target);
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isLoading}
            />
            <div className="input-actions">
              <button
                id="upload-btn"
                className="upload-btn"
                onClick={() => setShowUploadModal(true)}
                title="지식 파일 업로드"
              >
                📎
              </button>
              <button
                id="send-btn"
                className={`send-btn ${isLoading ? 'loading' : ''}`}
                onClick={() => sendMessage()}
                disabled={isLoading || !input.trim()}
                title="전송 (Enter)"
              >
                {isLoading ? '⟳' : '↑'}
              </button>
            </div>
          </div>
          <div className="input-hint">
            Enter로 전송 · Shift+Enter로 줄바꿈 · 파일로 지식 추가 가능
          </div>
        </div>
      </main>

      {/* ─── Upload Modal ─── */}
      {showUploadModal && (
        <div
          className="modal-backdrop"
          onClick={e => { if (e.target === e.currentTarget) setShowUploadModal(false); }}
        >
          <div className="modal" id="upload-modal">
            <h2 className="modal-title">📚 지식 업로드</h2>
            <p className="modal-description">
              PDF, Markdown, TXT, JSON 파일을 업로드하면 AI가 분석 후 지식 베이스에 추가합니다.
            </p>

            <div
              className={`drop-zone ${isDragging ? 'dragging' : ''}`}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={e => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) handleFileUpload(file);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="drop-icon">☁️</div>
              <div className="drop-text">파일을 드래그하거나 클릭해서 선택</div>
              <div className="drop-hint">.pdf .md .txt .json · 최대 10MB</div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.md,.txt,.json"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleFileUpload(file);
                }}
              />
            </div>

            <div className="modal-actions">
              <button
                id="cancel-upload-btn"
                className="btn btn-secondary"
                onClick={() => setShowUploadModal(false)}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
