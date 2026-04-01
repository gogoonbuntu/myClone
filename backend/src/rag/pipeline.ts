import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
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

interface StoredVector {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Local File Vector Store (no Docker needed) ──────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data');
const VECTORS_FILE = path.join(DATA_DIR, 'vectors.json');

class VectorStore {
  private vectors: StoredVector[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    // Ensure data dir exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Load existing vectors from disk
    if (fs.existsSync(VECTORS_FILE)) {
      try {
        const raw = fs.readFileSync(VECTORS_FILE, 'utf-8');
        this.vectors = JSON.parse(raw);
        console.log(`✅ Local vector store loaded — ${this.vectors.length} vectors`);
      } catch {
        this.vectors = [];
        console.warn('⚠️  Could not parse vectors file, starting fresh');
      }
    } else {
      this.vectors = [];
      console.log('📦 Local vector store initialized (empty)');
    }

    this.initialized = true;
  }

  private save(): void {
    fs.writeFileSync(VECTORS_FILE, JSON.stringify(this.vectors), 'utf-8');
  }

  async addChunks(chunks: Chunk[]): Promise<void> {
    if (!this.initialized) await this.init();

    console.log(`📝 Generating embeddings for ${chunks.length} chunks...`);

    const embeddings = await Promise.all(
      chunks.map(c => llmClient.generateEmbedding(c.content))
    );

    for (let i = 0; i < chunks.length; i++) {
      this.vectors.push({
        id: uuidv4(),
        content: chunks[i].content,
        embedding: embeddings[i],
        metadata: {
          ...chunks[i].metadata,
          tokenCount: chunks[i].tokenCount,
          chunkIndex: chunks[i].index,
        },
      });
    }

    this.save();
    console.log(`✅ Added ${chunks.length} chunks → total ${this.vectors.length} vectors`);
  }

  async query(queryText: string, topK: number = 5): Promise<RetrievedChunk[]> {
    if (!this.initialized) await this.init();
    if (this.vectors.length === 0) return [];

    const queryEmb = await llmClient.generateEmbedding(queryText);

    // Compute similarity for all vectors
    const scored = this.vectors.map(v => ({
      ...v,
      score: cosineSimilarity(queryEmb, v.embedding),
    }));

    // Sort by score descending, take top K
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);

    return top.map(v => ({
      id: v.id,
      content: v.content,
      score: v.score,
      metadata: v.metadata as RetrievedChunk['metadata'],
    }));
  }

  async deleteBySource(source: string): Promise<void> {
    if (!this.initialized) await this.init();
    const before = this.vectors.length;
    this.vectors = this.vectors.filter(v => v.metadata.source !== source);
    if (this.vectors.length < before) {
      this.save();
      console.log(`🗑️ Deleted ${before - this.vectors.length} vectors for source: ${source}`);
    }
  }

  async getStats(): Promise<{ count: number }> {
    if (!this.initialized) await this.init();
    return { count: this.vectors.length };
  }

  getAllVectors(): StoredVector[] {
    return this.vectors;
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
  return results.filter(r => r.score > 0.3); // Lower threshold for local store
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

// ─── L1: Keyword Search (for Lab comparison) ─────────────────────────────────

export async function keywordSearch(
  query: string,
  topK: number = 5
): Promise<RetrievedChunk[]> {
  await vectorStore.init();
  const vectors = vectorStore.getAllVectors();
  if (vectors.length === 0) return [];

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  const scored: RetrievedChunk[] = vectors.map(v => {
    const content = v.content.toLowerCase();
    let matchCount = 0;
    for (const word of queryWords) {
      if (content.includes(word)) matchCount++;
    }
    const score = queryWords.length > 0 ? matchCount / queryWords.length : 0;
    return {
      id: v.id,
      content: v.content,
      score,
      metadata: v.metadata as RetrievedChunk['metadata'],
    };
  });

  return scored
    .filter(v => v.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
