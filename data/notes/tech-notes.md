# 기술 노트 — LLM 개발 경험

## RAG 파이프라인 설계 원칙

RAG를 구현해 보면서 가장 중요하게 배운 것은 **청킹 전략이 전체 시스템 품질을 결정한다**는 점이다.

단순히 500 토큰으로 자르는 것은 최악의 방법이다. 왜냐하면 문장이 중간에 잘려 의미가 손실되고, 임베딩의 품질이 떨어지기 때문이다.

내가 채택한 방식:
1. 먼저 문단(paragraph) 단위로 분리
2. 문단이 너무 크면 문장 단위로 재분리
3. 작은 문단들은 합쳐서 최소 의미 단위 보장
4. overlap을 두어 경계 부분의 컨텍스트 손실 방지

## Vector DB 선택 기준

**Chroma** (현재 사용 중):
- 장점: 로컬 설치, 비용 없음, 개발 속도 빠름
- 단점: 대용량에서 성능 한계, 클라우드 관리 어려움

**Pinecone**:
- 장점: 관리형, 대용량 최적화, 안정적
- 단점: 비용, 벤더 종속

내 판단: 개인 프로젝트/MVP에서는 Chroma, 실제 서비스라면 Pinecone.

## Claude vs GPT-4o 비교 경험

Claude를 선택한 이유:
1. 툴 호출(tool use) 신뢰도가 GPT-4o보다 높음
2. 긴 컨텍스트에서 일관성 유지
3. 한국어 품질이 GPT-4o와 비슷하거나 우수
4. System prompt 준수율이 높음

GPT-4o가 우세한 부분:
1. 함수 호출 속도가 빠름
2. JSON 모드 안정성
3. 에코시스템/커뮤니티

## Streaming 구현 노하우

SSE(Server-Sent Events)로 스트리밍을 구현할 때 주의점:
- `X-Accel-Buffering: no` 헤더 필수 (Nginx 프록시 환경)
- `Content-Type: text/event-stream` + `Cache-Control: no-cache`
- 클라이언트 disconnect 처리를 반드시 해야 서버 리소스 누수 없음
- EventSource API보다 fetch + ReadableStream이 더 유연함

## Memory 아키텍처 결정

단기 메모리 (Redis):
- 대화 컨텍스트 최대 20턴 유지
- TTL 1시간으로 자동 만료
- 빠른 읽기/쓰기

장기 메모리 (Vector DB):
- 대화 요약을 임베딩하여 저장
- 의미 기반 검색으로 관련 과거 경험 검색
- 지속성 보장

Context Compression:
- 20턴 이상 쌓이면 LLM으로 요약 → Redis에 압축 저장
- 비용과 품질의 균형점은 10-20턴 사이

## 에러 핸들링 철학

나는 "Fail gracefully" 원칙을 따른다:
- 외부 서비스(Redis, Chroma, DB)가 다운되어도 핵심 기능은 작동해야 함
- 각 레이어에 fallback 구현
- 에러 메시지는 사용자 친화적으로, 내부 에러는 서버 로그에만
