import { retrieveContext, formatContext } from '../rag/pipeline';

export const searchLogsTool = {
  definition: {
    name: 'search_logs',
    description: '사용자의 과거 대화, 경험, 메모를 의미 기반으로 검색합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: '검색할 내용 (자연어로 입력)' },
        top_k: { type: 'string', description: '반환할 결과 수 (기본값: 3)' },
      },
      required: ['query'],
    },
  },

  async execute(input: { query: string; top_k?: string }): Promise<string> {
    const topK = parseInt(input.top_k || '3');

    try {
      const chunks = await retrieveContext(input.query, topK);
      if (chunks.length === 0) {
        return `"${input.query}"에 관한 기록을 찾을 수 없습니다.`;
      }
      return formatContext(chunks);
    } catch (err) {
      return `검색 실패: ${err instanceof Error ? err.message : 'Unknown error'}`;
    }
  },
};
