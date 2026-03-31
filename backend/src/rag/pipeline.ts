import { ChromaClient, Collection } from 'chromadb';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { llmClient } from '../llm/client';
import type { Chunk } from './chunker';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetrievedChunk {
  id: string;
  content: string;
  score: number;
  metadata: {
    source: string;
    sourceType: string;
    category?: string;
    timestamp?: string;
    [key: string]: unknown;
  };
}

// ─── Chroma Vector Store ──────────────────────────────────────────────────────

class VectorStore {
  private client!: ChromaClient;
  private collection!: Collection;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    this.client = new ChromaClient({
      path: `http://${config.chroma.host}:${config.chroma.port}`,
    });

    try {
      this.collection = await this.client.getOrCreateCollection({
        name: config.chroma.collection,
        metadata: { description: 'PKA personal knowledge base' },
      });
      this.initialized = true;
      console.log(`✅ ChromaDB connected — collection: ${config.chroma.collection}`);
    } catch (err) {
      console.warn('⚠️  ChromaDB not available, using mock vector store');
      this.initialized = false;
    }
  }

  async addChunks(chunks: Chunk[]): Promise<void> {
    if (!this.initialized) {
      console.log('📝 Mock: would add', chunks.length, 'chunks to vector store');
      return;
    }

    const embeddings = await Promise.all(
      chunks.map(c => llmClient.generateEmbedding(c.content))
    );

    const ids = chunks.map(() => uuidv4());
    const documents = chunks.map(c => c.content);
    const metadatas = chunks.map(c => ({
      ...c.metadata,
      tokenCount: c.tokenCount,
      chunkIndex: c.index,
    }));

    // ChromaDB accepts batches
    await this.collection.add({
      ids,
      embeddings,
      documents,
      metadatas: metadatas as Record<string, string | number | boolean>[],
    });

    console.log(`✅ Added ${chunks.length} chunks to vector store`);
  }

  async query(queryText: string, topK: number = 5): Promise<RetrievedChunk[]> {
    if (!this.initialized) {
      return this.mockQuery(queryText, topK);
    }

    const queryEmbedding = await llmClient.generateEmbedding(queryText);

    const results = await this.collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      include: ['documents', 'metadatas', 'distances'] as any,
    });

    const chunks: RetrievedChunk[] = [];

    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        chunks.push({
          id: results.ids[0][i],
          content: results.documents?.[0]?.[i] ?? '',
          score: 1 - (results.distances?.[0]?.[i] ?? 0), // Convert distance to similarity
          metadata: (results.metadatas?.[0]?.[i] ?? {}) as RetrievedChunk['metadata'],
        });
      }
    }

    return chunks;
  }

  async deleteBySource(source: string): Promise<void> {
    if (!this.initialized) return;
    const results = await this.collection.get({ where: { source } });
    if (results.ids.length > 0) {
      await this.collection.delete({ ids: results.ids });
    }
  }

  async getStats(): Promise<{ count: number }> {
    if (!this.initialized) return { count: 0 };
    const count = await this.collection.count();
    return { count };
  }

  private mockQuery(_queryText: string, topK: number): RetrievedChunk[] {
    // Return realistic demo results when ChromaDB not available
    return [
      {
        id: 'demo-1',
        content: 'PKA 프로젝트를 진행하면서 RAG 파이프라인의 청킹 전략이 응답 품질에 결정적인 영향을 미친다는 것을 깨달았습니다. 단순 500 토큰 청킹보다 의미 단위 청킹이 훨씬 효과적이었습니다.',
        score: 0.92,
        metadata: { source: 'project-pka', sourceType: 'project', category: 'lessons-learned' },
      },
      {
        id: 'demo-2',
        content: 'TypeScript와 Node.js를 백엔드로 선택한 이유: 타입 안전성, 풍부한 LLM SDK 지원, 스트리밍 처리의 용이성. Express + SSE 조합이 실시간 응답에 최적이었습니다.',
        score: 0.87,
        metadata: { source: 'notes/tech-decisions', sourceType: 'note', category: 'tech-stack' },
      },
    ].slice(0, topK);
  }
}

export const vectorStore = new VectorStore();

// ─── RAG Pipeline ────────────────────────────────────────────────────────────

export async function retrieveContext(
  query: string,
  topK: number = config.rag.topK
): Promise<RetrievedChunk[]> {
  await vectorStore.init();
  const results = await vectorStore.query(query, topK);
  return results.filter(r => r.score > 0.5); // Filter low-relevance
}

export function formatContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';

  return chunks
    .map((c, i) => {
      const source = c.metadata.source || 'unknown';
      const category = c.metadata.category ? ` [${c.metadata.category}]` : '';
      return `[컨텍스트 ${i + 1}] (출처: ${source}${category}, 관련도: ${(c.score * 100).toFixed(0)}%)\n${c.content}`;
    })
    .join('\n\n---\n\n');
}
