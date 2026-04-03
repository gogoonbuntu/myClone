'use client';

import { useState } from 'react';
import Link from 'next/link';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SearchResult { content: string; score: number; source: string; }
interface SearchLevel { label: string; method: string; results: SearchResult[]; count: number; latency: number; }
interface SearchResponse { query: string; l1: SearchLevel; l2: SearchLevel; l3?: SearchLevel; }

type Tab = 'search' | 'memory' | 'longterm' | 'reflection' | 'llm';

const TABS: { id: Tab; label: string; icon: string; desc: string; l1: string; l2: string }[] = [
  { id: 'search', label: '검색 비교', icon: '🔍', desc: '키워드 vs 벡터 vs 하이브리드 검색 비교', l1: 'string.includes() 키워드 매칭', l2: 'embedding + cosine similarity + hybrid RRF' },
  { id: 'memory', label: '대화 메모리', icon: '🧠', desc: '히스토리 없이 vs 있이 대화했을 때 차이', l1: 'Stateless — 매번 새 대화', l2: 'Sliding Window — 이전 대화 맥락 유지' },
  { id: 'longterm', label: '장기 메모리', icon: '💾', desc: 'RAG만 vs RAG+과거 대화 기억 비교', l1: 'RAG만 사용', l2: 'RAG + 장기 기억 자동 소환' },
  { id: 'reflection', label: 'Reflection', icon: '🪞', desc: '1회 생성 vs 자기 비판→개선 비교', l1: '1회 생성 그대로 출력', l2: '생성 → 자기 비판 → 개선 답변' },
  { id: 'llm', label: 'LLM 비교', icon: '⚡', desc: 'Groq (Llama 3.3 70B) vs Gemini (2.0 Flash) 같은 질문 비교', l1: 'Groq — Llama 3.3 70B (초고속)', l2: 'Gemini — 2.0 Flash (멀티모달)' },
];

export default function LabPage() {
  const [activeTab, setActiveTab] = useState<Tab>('search');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
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
    setL1Text(''); setL2Text(''); setL1Latency(null); setL2Latency(null);
    setL1Status(''); setL2Status(''); setReflectionData(null); setImprovedText('');
    setMemoryInfo(''); setSearchResult(null);
  };

  const runSearch = async () => {
    setLoading(true); resetState();
    try {
      const res = await fetch('http://localhost:3001/api/lab/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
      setSearchResult(await res.json());
    } catch { /* */ }
    setLoading(false);
  };

  const runStreaming = async (endpoint: string) => {
    setLoading(true); resetState();
    try {
      const res = await fetch(`http://localhost:3001/api/lab/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
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
          if (line.startsWith('event: ')) currentEvent = line.slice(7);
          else if (line.startsWith('data: ')) {
            try { handleSSE(currentEvent, JSON.parse(line.slice(6))); } catch { /* */ }
          }
        }
      }
    } catch { /* */ }
    setLoading(false);
  };

  const handleSSE = (event: string, data: Record<string, unknown>) => {
    const level = data.level as string;
    switch (event) {
      case 'status': level === 'l1' ? setL1Status(data.message as string) : setL2Status(data.message as string); break;
      case 'text': level === 'l1' ? setL1Text(p => p + (data.content as string)) : setL2Text(p => p + (data.content as string)); break;
      case 'done':
        if (level === 'l1') { setL1Latency(data.latency as number); setL1Status(''); }
        else { setL2Latency(data.latency as number); setL2Status(''); }
        break;
      case 'reflection': setReflectionData(data as unknown as { critique: string; improved: boolean }); break;
      case 'improved': setImprovedText(data.content as string); break;
      case 'history': setMemoryInfo(`대화 히스토리: ${data.turnCount}턴 저장됨`); break;
      case 'memories': setMemoryInfo(`과거 기억 ${data.count}개 소환됨`); break;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || loading) return;
    if (activeTab === 'search') runSearch();
    else runStreaming(activeTab);
  };

  const placeholders: Record<Tab, string> = {
    search: '"백엔드 프레임워크" — L1은 정확한 단어만, L2는 의미까지, L3는 둘 다',
    memory: '2번 연속 질문: "내 이름이 뭐야?" → "방금 뭐 물어봤지?"',
    longterm: '"지난번에 뭐 얘기했지?" — L2는 과거 대화를 기억합니다',
    reflection: '"AI Agent란 무엇인가?" — L2는 초안을 비판하고 개선합니다',
    llm: '"TypeScript vs Java 장단점" — 같은 질문, 다른 모델의 답변 비교',
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#0a0a0f', color: '#e2e8f0', fontFamily: "'Inter','Pretendard',sans-serif" }}>
      <header style={{ padding: '16px 24px', borderBottom: '1px solid rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', gap: 16, background: 'linear-gradient(135deg, rgba(99,102,241,0.08), transparent)' }}>
        <Link href="/" style={{ color: '#818cf8', textDecoration: 'none', fontSize: 14, padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.3)' }}>← 나의 AI</Link>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#c7d2fe' }}>🧪 AI 학습 실험실</h1>
          <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>Level 1 vs Level 2 — 같은 질문, 다른 결과를 직접 비교하세요</p>
        </div>
      </header>

      <nav style={{ display: 'flex', gap: 4, padding: '12px 24px', borderBottom: '1px solid rgba(99,102,241,0.1)', overflowX: 'auto' }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); resetState(); }} style={{ padding: '10px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: activeTab === tab.id ? 600 : 400, background: activeTab === tab.id ? 'linear-gradient(135deg, #4f46e5, #7c3aed)' : 'rgba(30,30,50,0.6)', color: activeTab === tab.id ? '#fff' : '#94a3b8', transition: 'all 0.2s', whiteSpace: 'nowrap' }}>
            {tab.icon} {tab.label}
          </button>
        ))}
      </nav>

      <div style={{ margin: '16px 24px', padding: '14px 18px', borderRadius: 12, background: 'rgba(30,30,50,0.5)', border: '1px solid rgba(99,102,241,0.15)' }}>
        <p style={{ margin: '0 0 6px', fontSize: 14, color: '#c7d2fe' }}><strong>{tabConfig.icon} {tabConfig.desc}</strong></p>
        <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
          <span style={{ color: '#f97316' }}><strong>{activeTab === 'llm' ? 'Groq' : 'L1'}:</strong> {tabConfig.l1}</span>
          <span style={{ color: '#22d3ee' }}><strong>{activeTab === 'llm' ? 'Gemini' : 'L2'}:</strong> {tabConfig.l2}</span>
        </div>
      </div>

      <form onSubmit={handleSubmit} style={{ padding: '0 24px', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={placeholders[activeTab]} style={{ flex: 1, padding: '12px 16px', borderRadius: 12, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(15,15,30,0.8)', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
          <button type="submit" disabled={loading || !query.trim()} style={{ padding: '12px 24px', borderRadius: 12, border: 'none', background: loading ? 'rgba(99,102,241,0.3)' : 'linear-gradient(135deg, #4f46e5, #7c3aed)', color: '#fff', cursor: loading ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
            {loading ? '실험 중...' : '실험 시작'}
          </button>
        </div>
      </form>

      {/* Results */}
      <div style={{ display: 'grid', gridTemplateColumns: activeTab === 'search' && searchResult?.l3 ? '1fr 1fr 1fr' : '1fr 1fr', gap: 12, padding: '0 24px 40px', minHeight: 280 }}>
        <ResultCol level={activeTab === 'llm' ? 'Groq' : 'L1'} label={tabConfig.l1} color="#f97316" tab={activeTab} search={searchResult?.l1} text={l1Text} latency={l1Latency} status={l1Status} />
        <ResultCol level={activeTab === 'llm' ? 'Gemini' : 'L2'} label={tabConfig.l2} color="#22d3ee" tab={activeTab} search={searchResult?.l2} text={activeTab === 'reflection' && improvedText ? improvedText : l2Text} latency={l2Latency} status={l2Status} reflection={reflectionData} memory={memoryInfo} />
        {activeTab === 'search' && searchResult?.l3 && (
          <ResultCol level="L3" label="Hybrid RRF" color="#a78bfa" tab={activeTab} search={searchResult.l3} text="" latency={null} status="" />
        )}
      </div>
    </div>
  );
}

function ResultCol({ level, label, color, tab, search, text, latency, status, reflection, memory }: {
  level: string; label: string; color: string; tab: Tab;
  search?: SearchLevel; text: string; latency: number | null; status: string;
  reflection?: { critique: string; improved: boolean } | null; memory?: string;
}) {
  return (
    <div style={{ borderRadius: 14, border: `1px solid ${color}30`, background: `${color}08`, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${color}20`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 11, fontWeight: 700, color, padding: '2px 8px', borderRadius: 6, background: `${color}20` }}>{level}</span>
          <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>{label}</span>
        </div>
        {latency !== null && <span style={{ fontSize: 11, color: '#64748b' }}>⏱️ {latency}ms</span>}
      </div>
      <div style={{ padding: 14, minHeight: 180, fontSize: 13, lineHeight: 1.7 }}>
        {status && <div style={{ padding: '6px 10px', borderRadius: 8, background: 'rgba(99,102,241,0.1)', color: '#a5b4fc', fontSize: 12, marginBottom: 10 }}>⏳ {status}</div>}

        {tab === 'search' && search && (
          <div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{search.method}</div>
            <div style={{ fontSize: 12, color, marginBottom: 10 }}>{search.count}건 / {search.latency}ms</div>
            {search.results.length === 0 ? <div style={{ color: '#475569', fontStyle: 'italic' }}>검색 결과 없음</div> :
              search.results.map((r, i) => (
                <div key={i} style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(15,15,30,0.6)', marginBottom: 6, border: '1px solid rgba(100,116,139,0.12)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                    <span style={{ color: '#94a3b8' }}>📄 {r.source}</span>
                    <span style={{ color, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: `${color}15` }}>{r.score}%</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#cbd5e1' }}>{r.content}</div>
                </div>
              ))
            }
          </div>
        )}

        {tab !== 'search' && text && <div style={{ color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>{text}</div>}

        {reflection && (level === 'L2' || level === 'Gemini') && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: reflection.improved ? 'rgba(34,197,94,0.1)' : 'rgba(99,102,241,0.1)', border: `1px solid ${reflection.improved ? 'rgba(34,197,94,0.3)' : 'rgba(99,102,241,0.3)'}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: reflection.improved ? '#4ade80' : '#a5b4fc', marginBottom: 4 }}>{reflection.improved ? '✅ 답변 개선됨' : '✨ 개선 불필요'}</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>{reflection.critique}</div>
          </div>
        )}

        {memory && (level === 'L2' || level === 'Gemini') && (
          <div style={{ marginTop: 10, padding: '6px 10px', borderRadius: 8, background: 'rgba(34,211,238,0.08)', fontSize: 11, color: '#22d3ee' }}>💾 {memory}</div>
        )}

        {!text && !search && !status && <div style={{ color: '#334155', textAlign: 'center', padding: '30px 0' }}>질문을 입력하고 실험을 시작하세요</div>}
      </div>
    </div>
  );
}
