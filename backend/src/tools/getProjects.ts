import { Pool } from 'pg';
import { config } from '../config';
import { vectorStore } from '../rag/pipeline';

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

// ─── 벡터 스토어에서 프로젝트 관련 청크 검색 (임베딩 불필요, 텍스트 매칭) ────

async function getProjectsFromVectors(searchQuery: string): Promise<string> {
  await vectorStore.init();
  const all = vectorStore.getAllVectors();

  if (all.length === 0) {
    return '등록된 지식이 없습니다. 지식 추가 기능으로 프로젝트/경력 정보를 업로드해 주세요.';
  }

  // 프로젝트·경력 관련 키워드로 텍스트 매칭
  const keywords = [
    '프로젝트', 'project', '개발', '구현', '서비스', '앱', '시스템',
    '백엔드', '프론트엔드', 'backend', 'frontend', '경력', '기술',
    '스택', searchQuery,
  ];

  let relevant = all.filter(v => {
    const text = v.content.toLowerCase();
    return keywords.some(k => text.includes(k.toLowerCase()));
  });

  // 키워드 매칭 없으면 전체 반환
  if (relevant.length === 0) relevant = all;

  relevant = relevant.slice(0, 10);

  // 소스별로 그룹화
  const bySource = new Map<string, string[]>();
  for (const v of relevant) {
    const src = (v.metadata.source as string) ?? '알 수 없는 소스';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(v.content);
  }

  const formatted = [...bySource.entries()].map(([src, chunks]) =>
    `**[${src}]**\n${chunks.join('\n\n').slice(0, 800)}`
  ).join('\n\n---\n\n');

  return `등록된 지식 베이스에서 찾은 내용 (${relevant.length}/${all.length}개 청크):\n\n${formatted}`;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const getProjectsTool = {
  definition: {
    name: 'get_user_projects',
    description: '사용자의 프로젝트, 경력, 기술 스택 정보를 조회합니다. PostgreSQL DB 우선 조회 후 없으면 업로드된 지식 베이스에서 검색합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status:     { type: 'string', description: '프로젝트 상태: active | completed | paused | all' },
        tech_stack: { type: 'string', description: '특정 기술 스택으로 필터링 (예: TypeScript, React)' },
        limit:      { type: 'string', description: '반환할 최대 프로젝트 수 (기본값: 5)' },
        query:      { type: 'string', description: '검색할 키워드 (예: 복잡했던, E-commerce, 이커머스)' },
      },
      required: [],
    },
  },

  async execute(input: { status?: string; tech_stack?: string; limit?: string; query?: string }): Promise<string> {
    const limit = parseInt(input.limit || '5');
    const searchQuery = input.query || input.tech_stack || '프로젝트';

    // 1차: PostgreSQL 시도
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
      if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
      query += ` ORDER BY complexity_score DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await db.query(query, params);

      if (result.rows.length > 0) {
        return result.rows.map(p => `
**${p.name}** (${p.status}, 복잡도: ${p.complexity_score}/10)
- 설명: ${p.description}
- 기술 스택: ${p.tech_stack?.join(', ') || 'N/A'}
- GitHub: ${p.github_url || '비공개'}
- 기간: ${p.start_date || '?'} ~ ${p.end_date || '진행중'}
- 교훈: ${p.lessons_learned || '없음'}
        `.trim()).join('\n\n---\n\n');
      }
    } catch {
      // DB 없음 — 벡터 스토어로 폴백
    }

    // 2차: 벡터 스토어 폴백
    return getProjectsFromVectors(searchQuery);
  },
};
