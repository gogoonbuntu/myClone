# 이커머스 플랫폼 프로젝트

## 프로젝트 배경

2024년에 실시간 재고 관리가 가능한 풀스택 이커머스 플랫폼을 개발했다.
팀: 3명 (나 + 백엔드 1명 + 디자이너 1명)
기간: 약 3개월

## 기술 스택 선택 이유

React + Next.js:
- SSR로 SEO 최적화
- Image 최적화 내장
- 프론트엔드는 Next.js가 표준이라 팀 합류가 쉬움

Node.js + Express:
- 팀 전체가 JS/TS에 친숙
- 비동기 처리에 강점
- WebSocket과의 인테그레이션 쉬움

PostgreSQL + Redis:
- 재고 데이터는 관계형 DB가 적합 (트랜잭션 필수)
- Redis로 세션 + 재고 캐싱으로 응답속도 극적 개선

## 핵심 도전과 해결책

### 재고 동시성 문제

문제: 동시에 같은 상품을 여러 사용자가 구매할 때 oversell 발생
해결: PostgreSQL의 `SELECT FOR UPDATE`로 row-level lock + 트랜잭션

```sql
BEGIN;
SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE;
-- quantity > 0 확인 후
UPDATE inventory SET quantity = quantity - $2 WHERE product_id = $1;
COMMIT;
```

이 방법으로 oversell 100% 방지.

### 성능 최적화

초기 상품 목록 API: 2.3초
Redis 캐싱 후: 45ms

캐싱 전략:
- 상품 목록: 5분 캐시 (업데이트 시 invalidation)
- 사용자 세션: 24시간
- 재고는 캐시 안 함 (실시간 필요)

### 결제 연동 (Stripe)

Webhook 처리가 가장 까다로웠다.
결제 완료 이벤트를 idempotency key로 중복 처리 방지.
실패한 webhook은 큐에 쌓아 재시도.

## 교훈

1. **캐싱 전략을 처음부터 설계하라** — 나중에 추가하면 리팩토링 비용이 크다
2. **트랜잭션 범위를 최소화하라** — 긴 트랜잭션은 데드락 위험
3. **Stripe Webhook은 반드시 idempotent하게** — 중복 처리가 최악
4. **재고는 항상 DB에서 직접, 절대 캐시 믿지 마라**
