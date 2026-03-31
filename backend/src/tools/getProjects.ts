import { Pool } from 'pg';
import { config } from '../config';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      connectionTimeoutMillis: 3000,
    });
  }
  return pool;
}

export const getProjectsTool = {
  definition: {
    name: 'get_user_projects',
    description: '사용자의 프로젝트 목록과 상세 정보를 조회합니다. 특정 기술 스택, 상태, 복잡도로 필터링 가능합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: '프로젝트 상태: active | completed | paused | all (기본값: all)' },
        tech_stack: { type: 'string', description: '특정 기술 스택으로 필터링 (예: TypeScript, React)' },
        limit: { type: 'string', description: '반환할 최대 프로젝트 수 (기본값: 5)' },
      },
      required: [],
    },
  },

  async execute(input: { status?: string; tech_stack?: string; limit?: string }): Promise<string> {
    const limit = parseInt(input.limit || '5');

    try {
      const db = getPool();
      let query = 'SELECT * FROM projects';
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (input.status && input.status !== 'all') {
        conditions.push(`status = $${params.length + 1}`);
        params.push(input.status);
      }

      if (input.tech_stack) {
        conditions.push(`$${params.length + 1} = ANY(tech_stack)`);
        params.push(input.tech_stack);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ` ORDER BY complexity_score DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await db.query(query, params);

      if (result.rows.length === 0) {
        return '해당 조건의 프로젝트를 찾을 수 없습니다.';
      }

      return result.rows.map(p => `
**${p.name}** (${p.status}, 복잡도: ${p.complexity_score}/10)
- 설명: ${p.description}
- 기술 스택: ${p.tech_stack?.join(', ') || 'N/A'}
- GitHub: ${p.github_url || '비공개'}
- 기간: ${p.start_date || '?'} ~ ${p.end_date || '진행중'}
- 교훈: ${p.lessons_learned || '없음'}
      `.trim()).join('\n\n---\n\n');
    } catch {
      // Fallback to mock data when DB not available
      return `**PKA (Personal Knowledge AI Agent)** (active, 복잡도: 9/10)
- 설명: 개인 경험 기반으로 추론하는 AI Agent 시스템
- 기술 스택: TypeScript, Next.js, ChromaDB, Redis, Claude API
- 교훈: RAG 파이프라인 품질이 응답 품질의 핵심

---

**E-Commerce Platform** (completed, 복잡도: 7/10)
- 설명: 실시간 재고 관리 풀스택 이커머스
- 기술 스택: React, Node.js, PostgreSQL, Redis, Stripe
- 교훈: 캐싱 전략이 성능에 결정적 영향`;
    }
  },
};
