'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SearchResult {
  content: string;
  score: number;
  source: string;
}

interface SearchResponse {
  query: string;
  l1: { label: string; method: string; results: SearchResult[]; count: number; latency: number };
  l2: { label: string; method: string; results: SearchResult[]; count: number; latency: number };
}

type Tab = 'search' | 'memory' | 'longterm' | 'reflection';

// ─── Tab Config ──────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; icon: string; desc: string; l1: string; l2: string }[] = [
  {
    id: 'search',
    label: '벡터 검색',
    icon: '🔍',
    desc: '같은 질문으로 키워드 vs 벡터 검색 비교',
    l1: 'string.includes() — 단어 포함 여부만 확인',
    l2: 'embedding + cosine similarity — 의미 유사도 계산',
  },
  {
    id: 'memory',
    label: '대화 메모리',
    icon: '🧠',
    desc: '히스토리 없이 vs 있이 대화했을 때 차이',
    l1: 'Stateless — 매번 새 대화',
    l2: 'Sliding Window — 이전 대화 맥락 유지',
  },
  {
    id: 'longterm',
    label: '장기 메모리',
    icon: '💾',
    desc: 'RAG만 vs RAG+과거 대화 기억 비교',
    l1: 'RAG만 사용 — 과거 대화 무시',
    l2: 'RAG + 장기 기억 — 이전 대화 요약 자동 소환',
  },
  {
    id: 'reflection',
    label: 'Reflection',
    icon: '🪞',
    desc: '1회 생성 vs 자기 비판→개선 비교',
    l1: '1회 생성 — 그대로 출력',
    l2: '생성 → 자기 비판 → 개선 답변',
  },
];

// ─── Main Component ──────────────────────────────────────────────────────────

export default function LabPage() {
  const [activeTab, setActiveTab] = useState<Tab>('search');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  // Search state
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);

  // Streaming state for memory/longterm/reflection
  const [l1Text, setL1Text] = useState('');
  const [l2Text, setL2Text] = useState('');
  const [l1Latency, setL1Latency] = useState<number | null>(null);
  const [l2Latency, setL2Latency] = useState<number | null>(null);
  const [l1Status, setL1Status] = useState('');
  const [l2Status, setL2Status] = useState('');
  const [reflectionData, setReflectionData] = useState<{ critique: string; improved: boolean } | null>(null);
  const [improvedText, setImprovedText] = useState('');
  const [memoryInfo, setMemoryInfo] = useState('');

  const tabConfig = TABS.find(t => t.id === activeTab)!;

  const resetState = () => {
    setL1Text('');
    setL2Text('');
    setL1Latency(null);
    setL2Latency(null);
    setL1Status('');
    setL2Status('');
    setReflectionData(null);
    setImprovedText('');
    setMemoryInfo('');
    setSearchResult(null);
  };

  // ── Search experiment (REST) ───────────────────────────────────────────────

  const runSearch = async () => {
    setLoading(true);
    resetState();
    try {
      const res = await fetch('http://localhost:3001/api/lab/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      setSearchResult(data);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  // ── Streaming experiments (SSE) ────────────────────────────────────────────

  const runStreaming = async (endpoint: string) => {
    setLoading(true);
    resetState();

    try {
      const res = await fetch(`http://localhost:3001/api/lab/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSE(currentEvent, data);
            } catch { /* skip */ }
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  const handleSSE = (event: string, data: Record<string, unknown>) => {
    const level = data.level as string;

    switch (event) {
      case 'status':
        if (level === 'l1') setL1Status(data.message as string);
        else setL2Status(data.message as string);
        break;
      case 'text':
        if (level === 'l1') setL1Text(prev => prev + (data.content as string));
        else setL2Text(prev => prev + (data.content as string));
        break;
      case 'done':
        if (level === 'l1') {
          setL1Latency(data.latency as number);
          setL1Status('');
        } else {
          setL2Latency(data.latency as number);
          setL2Status('');
        }
        break;
      case 'reflection':
        setReflectionData(data as unknown as { critique: string; improved: boolean });
        break;
      case 'improved':
        setImprovedText(data.content as string);
        break;
      case 'history':
        setMemoryInfo(`대화 히스토리: ${data.turnCount}턴 저장됨`);
        break;
      case 'memories':
        setMemoryInfo(`과거 기억 ${data.count}개 소환됨`);
        break;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || loading) return;
    if (activeTab === 'search') runSearch();
    else runStreaming(activeTab);
  };

  const placeholders: Record<Tab, string> = {
    search: '예: "백엔드 프레임워크" — L1은 정확한 단어만, L2는 Spring/Java도 찾음',
    memory: '예: 2번 연속 질문해보세요. "내 이름이 뭐야?" → "방금 뭐 물어봤지?"',
    longterm: '예: "지난번에 뭐 얘기했지?" — L2는 과거 대화를 기억합니다',
    reflection: '예: "AI Agent란 무엇인가?" — L2는 초안을 비판하고 개선합니다',
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#0a0a0f', color: '#e2e8f0' }}>
      {/* Header */}
      <header style={{
        padding: '16px 24px',
        borderBottom: '1px solid rgba(99, 102, 241, 0.15)',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: 'linear-gradient(135deg, rgba(99,102,241,0.08), transparent)',
      }}>
        <Link href="/" style={{
          color: '#818cf8',
          textDecoration: 'none',
          fontSize: 14,
          padding: '6px 12px',
          borderRadius: 8,
          border: '1px solid rgba(99,102,241,0.3)',
          transition: 'all 0.2s',
        }}>
          ← 나의 AI
        </Link>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#c7d2fe' }}>
            🧪 AI 학습 실험실
          </h1>
          <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
            Level 1 vs Level 2 — 같은 질문, 다른 결과를 직접 비교하세요
          </p>
        </div>
      </header>

      {/* Tabs */}
      <nav style={{
        display: 'flex',
        gap: 4,
        padding: '12px 24px',
        borderBottom: '1px solid rgba(99,102,241,0.1)',
        overflowX: 'auto',
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); resetState(); }}
            style={{
              padding: '10px 18px',
              borderRadius: 10,
              border: 'none',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 600 : 400,
              background: activeTab === tab.id
                ? 'linear-gradient(135deg, #4f46e5, #7c3aed)'
                : 'rgba(30,30,50,0.6)',
              color: activeTab === tab.id ? '#fff' : '#94a3b8',
              transition: 'all 0.2s',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </nav>

      {/* Experiment Description */}
      <div style={{
        margin: '16px 24px',
        padding: '16px 20px',
        borderRadius: 12,
        background: 'rgba(30,30,50,0.5)',
        border: '1px solid rgba(99,102,241,0.15)',
      }}>
        <p style={{ margin: '0 0 8px 0', fontSize: 15, color: '#c7d2fe' }}>
          {tabConfig.icon} <strong>{tabConfig.desc}</strong>
        </p>
        <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
          <span style={{ color: '#f97316' }}>
            <strong>L1:</strong> {tabConfig.l1}
          </span>
          <span style={{ color: '#22d3ee' }}>
            <strong>L2:</strong> {tabConfig.l2}
          </span>
        </div>
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} style={{ padding: '0 24px', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={placeholders[activeTab]}
            style={{
              flex: 1,
              padding: '14px 18px',
              borderRadius: 12,
              border: '1px solid rgba(99,102,241,0.3)',
              background: 'rgba(15,15,30,0.8)',
              color: '#e2e8f0',
              fontSize: 15,
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            style={{
              padding: '14px 28px',
              borderRadius: 12,
              border: 'none',
              background: loading
                ? 'rgba(99,102,241,0.3)'
                : 'linear-gradient(135deg, #4f46e5, #7c3aed)',
              color: '#fff',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            {loading ? '실험 중...' : '실험 시작'}
          </button>
        </div>
      </form>

      {/* Results */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 16,
        padding: '0 24px 40px',
        minHeight: 300,
      }}>
        {/* L1 Column */}
        <ResultColumn
          level="L1"
          label={tabConfig.l1}
          color="#f97316"
          bgColor="rgba(249,115,22,0.05)"
          borderColor="rgba(249,115,22,0.2)"
          tab={activeTab}
          searchResult={searchResult?.l1}
          text={l1Text}
          latency={l1Latency}
          status={l1Status}
        />

        {/* L2 Column */}
        <ResultColumn
          level="L2"
          label={tabConfig.l2}
          color="#22d3ee"
          bgColor="rgba(34,211,238,0.05)"
          borderColor="rgba(34,211,238,0.2)"
          tab={activeTab}
          searchResult={searchResult?.l2}
          text={activeTab === 'reflection' && improvedText ? improvedText : l2Text}
          latency={l2Latency}
          status={l2Status}
          reflectionData={reflectionData}
          memoryInfo={memoryInfo}
        />
      </div>
    </div>
  );
}

// ─── Result Column Component ─────────────────────────────────────────────────

function ResultColumn({
  level,
  label,
  color,
  bgColor,
  borderColor,
  tab,
  searchResult,
  text,
  latency,
  status,
  reflectionData,
  memoryInfo,
}: {
  level: string;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  tab: Tab;
  searchResult?: SearchResponse['l1'];
  text: string;
  latency: number | null;
  status: string;
  reflectionData?: { critique: string; improved: boolean } | null;
  memoryInfo?: string;
}) {
  return (
    <div style={{
      borderRadius: 16,
      border: `1px solid ${borderColor}`,
      background: bgColor,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: `1px solid ${borderColor}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            color,
            padding: '2px 8px',
            borderRadius: 6,
            background: `${color}22`,
            textTransform: 'uppercase',
          }}>
            {level}
          </span>
          <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>{label}</span>
        </div>
        {latency !== null && (
          <span style={{ fontSize: 11, color: '#64748b' }}>
            ⏱️ {latency}ms
          </span>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: 16, minHeight: 200, fontSize: 14, lineHeight: 1.7 }}>
        {status && (
          <div style={{
            padding: '8px 12px',
            borderRadius: 8,
            background: 'rgba(99,102,241,0.1)',
            color: '#a5b4fc',
            fontSize: 13,
            marginBottom: 12,
            animation: 'pulse 1.5s infinite',
          }}>
            ⏳ {status}
          </div>
        )}

        {/* Search results */}
        {tab === 'search' && searchResult && (
          <div>
            <div style={{ fontSize: 13, color: '#64748b', marginBottom: 8 }}>
              방식: {searchResult.method}
            </div>
            <div style={{ fontSize: 13, color, marginBottom: 12 }}>
              결과: {searchResult.count}건 / {searchResult.latency}ms
            </div>
            {searchResult.results.length === 0 ? (
              <div style={{ color: '#475569', fontStyle: 'italic' }}>검색 결과 없음</div>
            ) : (
              searchResult.results.map((r, i) => (
                <div key={i} style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'rgba(15,15,30,0.6)',
                  marginBottom: 8,
                  border: '1px solid rgba(100,116,139,0.15)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                    <span style={{ color: '#94a3b8' }}>📄 {r.source}</span>
                    <span style={{
                      color,
                      fontWeight: 600,
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: `${color}15`,
                    }}>
                      {r.score}%
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: '#cbd5e1' }}>{r.content}</div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Streaming text */}
        {tab !== 'search' && text && (
          <div style={{ color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>{text}</div>
        )}

        {/* Reflection info */}
        {reflectionData && level === 'L2' && (
          <div style={{
            marginTop: 16,
            padding: '12px 14px',
            borderRadius: 10,
            background: reflectionData.improved
              ? 'rgba(34, 197, 94, 0.1)'
              : 'rgba(99, 102, 241, 0.1)',
            border: `1px solid ${reflectionData.improved ? 'rgba(34,197,94,0.3)' : 'rgba(99,102,241,0.3)'}`,
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: reflectionData.improved ? '#4ade80' : '#a5b4fc', marginBottom: 6 }}>
              {reflectionData.improved ? '✅ 답변 개선됨' : '✨ 개선 불필요'}
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8' }}>
              비판: {reflectionData.critique}
            </div>
          </div>
        )}

        {/* Memory info */}
        {memoryInfo && level === 'L2' && (
          <div style={{
            marginTop: 12,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'rgba(34,211,238,0.08)',
            fontSize: 12,
            color: '#22d3ee',
          }}>
            💾 {memoryInfo}
          </div>
        )}

        {/* Empty state */}
        {!text && !searchResult && !status && (
          <div style={{ color: '#334155', textAlign: 'center', padding: '40px 0' }}>
            질문을 입력하고 실험을 시작하세요
          </div>
        )}
      </div>
    </div>
  );
}
