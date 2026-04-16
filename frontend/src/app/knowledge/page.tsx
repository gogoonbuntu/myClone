'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Chunk {
  id: string;
  content: string;
  tokenCount?: number;
  chunkIndex?: number;
}

interface KnowledgeSource {
  source: string;
  sourceType: string;
  timestamp: string;
  chunks: Chunk[];
}

interface KnowledgeData {
  totalVectors: number;
  totalSources: number;
  sources: KnowledgeSource[];
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const SOURCE_TYPE_ICONS: Record<string, string> = {
  note: '📝',
  web: '🌐',
  chat: '💬',
  conversation: '💬',
  pdf: '📄',
  md: '📋',
  default: '📁',
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  note: '노트',
  web: 'URL',
  chat: '대화',
  conversation: '대화',
  pdf: 'PDF',
  md: '마크다운',
  default: '파일',
};

function formatDate(iso: string): string {
  if (!iso) return '날짜 미상';
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function typeIcon(t: string) {
  return SOURCE_TYPE_ICONS[t] ?? SOURCE_TYPE_ICONS.default;
}
function typeLabel(t: string) {
  return SOURCE_TYPE_LABELS[t] ?? SOURCE_TYPE_LABELS.default;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function KnowledgePage() {
  const [data, setData]             = useState<KnowledgeData | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [query, setQuery]           = useState('');
  const [expandedSrc, setExpandedSrc] = useState<Set<string>>(new Set());
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());
  const [deleting, setDeleting]     = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/api/knowledge`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (source: string) => {
    setDeleting(source);
    try {
      const res = await fetch(
        `${API_URL}/api/knowledge/${encodeURIComponent(source)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      alert(`삭제 실패: ${e instanceof Error ? e.message : '알 수 없는 오류'}`);
    } finally {
      setDeleting(null); setConfirmDel(null);
    }
  };

  const toggleSrc = (src: string) =>
    setExpandedSrc(p => { const n = new Set(p); n.has(src) ? n.delete(src) : n.add(src); return n; });

  const toggleChunk = (id: string) =>
    setExpandedChunks(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const filtered = data?.sources.filter(s =>
    !query || s.source.toLowerCase().includes(query.toLowerCase())
  ) ?? [];

  return (
    <div className="kb-page">
      {/* sidebar */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link href="/" style={{ textDecoration: 'none' }}>
            <div className="brand">
              <div className="brand-icon">🧠</div>
              <div>
                <div className="brand-name">나의 AI</div>
                <div className="brand-tagline">내 경험·지식을 아는 AI</div>
              </div>
            </div>
          </Link>
        </div>
        <div className="sidebar-body">
          <div className="sidebar-label">탐색</div>
          <Link href="/" style={{ textDecoration: 'none' }}>
            <button className="quick-btn" style={{ width: '100%', textAlign: 'left' }}>
              <span className="q-icon">💬</span> 채팅으로 돌아가기
            </button>
          </Link>
          <Link href="/lab" style={{ textDecoration: 'none' }}>
            <button className="quick-btn" style={{ width: '100%', textAlign: 'left' }}>
              <span className="q-icon">🧪</span> AI 학습 실험실
            </button>
          </Link>

          {data && (
            <>
              <div className="sidebar-label" style={{ marginTop: 16 }}>요약</div>
              <div className="kb-stat-card">
                <div className="kb-stat-row">
                  <span>📦 총 소스</span>
                  <strong>{data.totalSources}</strong>
                </div>
                <div className="kb-stat-row">
                  <span>🔢 총 벡터</span>
                  <strong>{data.totalVectors.toLocaleString()}</strong>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* main */}
      <div className="kb-main">
        {/* header */}
        <header className="kb-header">
          <div>
            <div className="header-title">📚 지식 베이스 탐색기</div>
            <div className="header-sub">
              저장된 지식 데이터를 소스별로 확인하고 관리하세요
            </div>
          </div>
          <button className="icon-btn" onClick={load} title="새로고침" id="refresh-btn">🔄</button>
        </header>

        {/* content */}
        <div className="kb-content">
          {/* search */}
          <div className="kb-search-row">
            <div className="kb-search-wrap">
              <span className="kb-search-icon">🔍</span>
              <input
                className="kb-search"
                placeholder="소스 이름으로 검색..."
                value={query}
                onChange={e => setQuery(e.target.value)}
                id="kb-search"
              />
              {query && (
                <button className="kb-search-clear" onClick={() => setQuery('')}>✕</button>
              )}
            </div>
            {data && (
              <div className="kb-count-tag">
                {filtered.length} / {data.totalSources} 소스
              </div>
            )}
          </div>

          {/* states */}
          {loading && (
            <div className="kb-center">
              <div className="kb-spinner" />
              <p style={{ color: 'var(--text-muted)', marginTop: 14, fontSize: 13 }}>
                데이터 불러오는 중...
              </p>
            </div>
          )}

          {error && (
            <div className="kb-error">
              <div className="kb-error-icon">⚠️</div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>불러오기 실패</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{error}</div>
                <button className="btn btn-ghost" style={{ marginTop: 12, fontSize: 12 }} onClick={load}>
                  다시 시도
                </button>
              </div>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="kb-center">
              <div style={{ fontSize: 48, marginBottom: 16 }}>🗂️</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                {query ? '검색 결과 없음' : '저장된 지식이 없습니다'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 320, textAlign: 'center' }}>
                {query
                  ? `"${query}"와 일치하는 소스를 찾을 수 없습니다.`
                  : '채팅 페이지에서 파일, URL, 텍스트를 추가하면 여기에 표시됩니다.'}
              </div>
              {!query && (
                <Link href="/" style={{ textDecoration: 'none', marginTop: 18 }}>
                  <button className="btn btn-primary" style={{ fontSize: 13 }}>
                    📎 지식 추가하러 가기
                  </button>
                </Link>
              )}
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div className="kb-source-list">
              {filtered.map(src => {
                const isExpanded = expandedSrc.has(src.source);
                const isDel = deleting === src.source;
                const isConfirm = confirmDel === src.source;

                return (
                  <div key={src.source} className="kb-source-card">
                    {/* source header */}
                    <div className="kb-source-header">
                      <div className="kb-source-left">
                        <div className="kb-source-icon">
                          {typeIcon(src.sourceType)}
                        </div>
                        <div>
                          <div className="kb-source-name">{src.source}</div>
                          <div className="kb-source-meta">
                            <span className="kb-type-badge">{typeLabel(src.sourceType)}</span>
                            <span className="kb-meta-dot">·</span>
                            <span>{src.chunks.length}개 청크</span>
                            <span className="kb-meta-dot">·</span>
                            <span>{src.chunks.reduce((a, c) => a + (c.tokenCount ?? 0), 0).toLocaleString()} 토큰</span>
                            <span className="kb-meta-dot">·</span>
                            <span>{formatDate(src.timestamp)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="kb-source-actions">
                        <button
                          className="kb-expand-btn"
                          onClick={() => toggleSrc(src.source)}
                          title={isExpanded ? '접기' : '청크 보기'}
                        >
                          {isExpanded ? '▲ 접기' : '▼ 청크 보기'}
                        </button>

                        {isConfirm ? (
                          <div className="kb-confirm-row">
                            <span style={{ fontSize: 12, color: 'var(--rose-400)' }}>
                              정말 삭제?
                            </span>
                            <button
                              className="kb-del-confirm-btn"
                              onClick={() => handleDelete(src.source)}
                              disabled={isDel}
                            >
                              {isDel ? '삭제 중...' : '삭제'}
                            </button>
                            <button
                              className="kb-del-cancel-btn"
                              onClick={() => setConfirmDel(null)}
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <button
                            className="kb-del-btn"
                            onClick={() => setConfirmDel(src.source)}
                            title="소스 삭제"
                            disabled={isDel}
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                    </div>

                    {/* chunks */}
                    {isExpanded && (
                      <div className="kb-chunks">
                        {src.chunks
                          .slice()
                          .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
                          .map((chunk, i) => {
                            const isChunkExpanded = expandedChunks.has(chunk.id);
                            const preview = chunk.content.length > 200
                              ? chunk.content.slice(0, 200) + '…'
                              : chunk.content;

                            return (
                              <div key={chunk.id} className="kb-chunk">
                                <div className="kb-chunk-header">
                                  <div className="kb-chunk-num">청크 #{(chunk.chunkIndex ?? i) + 1}</div>
                                  <div className="kb-chunk-tags">
                                    {chunk.tokenCount !== undefined && (
                                      <span className="kb-chunk-tag">
                                        ~{chunk.tokenCount} 토큰
                                      </span>
                                    )}
                                    <span className="kb-chunk-tag">
                                      {chunk.content.length}자
                                    </span>
                                  </div>
                                  {chunk.content.length > 200 && (
                                    <button
                                      className="kb-chunk-expand"
                                      onClick={() => toggleChunk(chunk.id)}
                                    >
                                      {isChunkExpanded ? '접기' : '전체 보기'}
                                    </button>
                                  )}
                                </div>
                                <div className="kb-chunk-content">
                                  {isChunkExpanded ? chunk.content : preview}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
