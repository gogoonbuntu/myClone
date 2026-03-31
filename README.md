# 🧠 Personal Knowledge AI Agent (PKA)

> "나에 대해 모든 것을 답하는 AI 시스템"

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![Claude](https://img.shields.io/badge/LLM-Claude--3.5--Sonnet-orange)](https://anthropic.com/)
[![ChromaDB](https://img.shields.io/badge/VectorDB-Chroma-green)](https://trychroma.com/)

---

## 📖 개요

PKA는 단순 Q&A 챗봇이 아닙니다.
**개인의 경험, 사고방식, 기술 스택, 판단 기준을 학습하고 맥락 기반으로 추론하는 AI Agent입니다.**

### 핵심 기능

| 기능 | 설명 |
|------|------|
| 🔍 **RAG 기반 응답** | 개인 지식 (프로젝트, 노트, 채팅)에서 관련 컨텍스트 검색 |
| 🎭 **Persona 기반 응답** | ENFP/INTP 모드로 실제 사고방식 재현 |
| 🤖 **Tool Use** | GitHub, DB, 과거 로그 실시간 조회 |
| 🔄 **Reflection Loop** | 자기 비판 → 답변 개선 |
| 💾 **Memory 시스템** | 단기(Redis) + 장기(ChromaDB) 이중 메모리 |
| ⚡ **Streaming** | SSE 실시간 스트리밍 응답 |

---

## 🏗️ 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                   Frontend (Next.js 15)                  │
│     Chat UI + Streaming + Source Citations + Upload      │
└────────────────────────┬────────────────────────────────┘
                         │ SSE / REST
┌────────────────────────▼────────────────────────────────┐
│                 Backend (Node.js + TypeScript)           │
│                                                         │
│   ┌──────────────────────────────────────────────────┐  │
│   │              Agent Orchestrator                   │  │
│   │  1. Intent 분석                                    │  │
│   │  2. RAG 검색 (ChromaDB)                           │  │
│   │  3. Tool 호출 결정                                 │  │
│   │  4. LLM 생성 (Claude, Streaming)                  │  │
│   │  5. Reflection Loop (자기 비판 → 개선)             │  │
│   │  6. Memory 저장                                    │  │
│   └──────────────────────────────────────────────────┘  │
│                                                         │
│   ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│   │ LLM Layer│  │Tool Layer│  │   Memory Layer        │  │
│   │  Claude  │  │ GitHub   │  │  Redis (단기)          │  │
│   │  Streaming│  │ DB 조회  │  │  ChromaDB (장기)      │  │
│   │  Tool Call│  │ Log 검색 │  │  Compression          │  │
│   └──────────┘  └──────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              Infrastructure (Docker)                     │
│    ChromaDB (벡터) + Redis (세션) + PostgreSQL (메타데이터)│
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 빠른 시작

### 1. 환경 변수 설정

```bash
cp .env.example .env
# .env 파일을 열고 ANTHROPIC_API_KEY 설정
```

### 2. 인프라 실행 (Docker)

```bash
docker-compose up -d
```

### 3. 백엔드 실행

```bash
cd backend
npm install
npm run dev
# → http://localhost:3001
```

### 4. 프론트엔드 실행

```bash
cd frontend
npm install
npm run dev
# → http://localhost:3000
```

### 5. 지식 업로드

```bash
# CLI로 일괄 업로드
cd backend
npm run ingest -- --source ../data/notes --type note
npm run ingest -- --source ../data/chats --type chat
npm run ingest -- --source ../data/projects --type project

# 또는 UI에서 파일 드래그&드롭
```

---

## 📁 프로젝트 구조

```
pka/
├── frontend/                    # Next.js 15 Chat UI
│   └── src/app/
│       ├── page.tsx             # 메인 채팅 UI
│       ├── layout.tsx           # SEO + 폰트
│       └── globals.css          # 프리미엄 다크모드 스타일
│
├── backend/                     # Node.js + TypeScript API
│   └── src/
│       ├── server.ts            # Express 서버
│       ├── config.ts            # 설정 관리
│       ├── agent/
│       │   └── orchestrator.ts  # ⭐ 핵심 에이전트 루프
│       ├── llm/
│       │   └── client.ts        # Claude API 클라이언트
│       ├── rag/
│       │   ├── chunker.ts       # 의미 단위 청킹
│       │   └── pipeline.ts      # ChromaDB 벡터 스토어
│       ├── memory/
│       │   ├── shortTerm.ts     # Redis 단기 메모리
│       │   └── longTerm.ts      # ChromaDB 장기 메모리
│       ├── tools/
│       │   ├── getProjects.ts   # 프로젝트 DB 조회
│       │   ├── searchLogs.ts    # 벡터 검색
│       │   └── githubFetch.ts   # GitHub API
│       ├── api/
│       │   ├── chat.ts          # POST /api/chat (SSE)
│       │   └── ingest.ts        # POST /api/ingest
│       └── ingest/
│           └── cli.ts           # 일괄 인제스트 CLI
│
├── data/                        # 개인 지식 데이터
│   ├── chats/                   # 과거 대화
│   ├── projects/                # 프로젝트 문서
│   ├── notes/                   # 기술 노트
│   └── resume/                  # 이력서
│
├── docker-compose.yml           # ChromaDB + Redis + PostgreSQL
└── .env.example                 # 환경 변수 템플릿
```

---

## 🧰 기술 스택

### Backend
- **Runtime**: Node.js 20+ + TypeScript 5.6
- **Framework**: Express 4 + SSE Streaming
- **LLM**: Claude claude-3-5-sonnet (Anthropic SDK)
- **Vector DB**: ChromaDB (local)
- **Session DB**: Redis (ioredis)
- **Relational DB**: PostgreSQL 16 (pg)
- **RAG**: 자체 구현 (의미 단위 청킹 + 코사인 유사도)
- **Agent**: 자체 구현 (LangChain X)

### Frontend
- **Framework**: Next.js 15 (App Router)
- **Style**: Vanilla CSS (다크모드, 글로우 이펙트, 마이크로 애니메이션)
- **Streaming**: EventSource API + ReadableStream

---

## 🔑 주요 설계 결정

### 1. RAG 청킹 전략
단순 500 토큰 청킹 대신 **의미 단위 청킹**:
- 문단 → 문장 → 단어 순서로 경계 탐지
- 최소 청크 크기 보장 (의미 손실 방지)
- 오버랩으로 경계 컨텍스트 보존

### 2. Agent 직접 구현 (LangChain 비사용)
- 블랙박스 의존성 제거
- 커스텀 Reflection 루프
- 툴 호출과 스트리밍의 완전한 제어

### 3. 이중 메모리 아키텍처
- **Redis**: 빠른 읽기/쓰기, TTL 자동 만료
- **ChromaDB**: 의미 기반 장기 검색
- Graceful fallback (DB 다운 시에도 작동)

### 4. Persona System
- ENFP/INTP 모드 시스템 프롬프트
- "내가 말할 법한 방식"으로 답변 재현
- 답변 구조 (상황 이해 → 판단 → 근거 → 결론)

---

## 📊 API 레퍼런스

### POST /api/chat
SSE 스트리밍 채팅

```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "내 프로젝트 중 가장 복잡했던 것은?", "conversationId": "optional"}'
```

**SSE Events**:
- `init` — 대화 ID 발급
- `status` — 처리 상태 ("검색 중...", "툴 실행 중...")
- `text` — 스트리밍 텍스트 델타
- `tool_start` — 툴 시작
- `tool_result` — 툴 결과
- `sources` — 사용된 RAG 소스
- `reflection` — 반성 결과
- `done` — 완료

### POST /api/ingest
파일 업로드 및 청킹

```bash
curl -X POST http://localhost:3001/api/ingest \
  -F "file=@resume.pdf" \
  -F "sourceType=resume"
```

---

## 📈 평가 지표

| 지표 | 측정 방법 |
|------|-----------|
| Context 활용률 | RAG 검색 후 응답에 소스 인용 여부 |
| Hallucination Rate | 알 수 없는 정보에 대한 부정확 답변 비율 |
| Latency | 첫 토큰까지 시간 (목표: < 2s) |
| 스타일 재현도 | Persona 프롬프트 준수율 |

---

## 🗺️ 로드맵

- [x] Phase 1: 기본 챗봇 + LLM 연결
- [x] Phase 2: RAG 파이프라인
- [x] Phase 3: Agent + Tool 시스템
- [x] Phase 4: UI + Streaming
- [ ] Phase 5: 임베딩 모델 개선 (Voyage AI / OpenAI Embeddings)
- [ ] Phase 6: Multi-step Reasoning (서브태스크 분해)
- [ ] Phase 7: 평가 대시보드
- [ ] Phase 8: 모바일 UI

---

## ⚙️ 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API 키 |
| `LLM_MODEL` | - | 기본값: claude-3-5-sonnet-20241022 |
| `PERSONA_MODE` | - | ENFP 또는 INTP |
| `GITHUB_TOKEN` | - | GitHub 툴 사용 시 필요 |
| `CHROMA_AUTH_TOKEN` | - | ChromaDB 인증 토큰 |