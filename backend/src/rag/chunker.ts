/**
 * Semantic Chunker
 * 단순 토큰 수가 아니라 의미 단위로 텍스트를 청킹합니다.
 */

import { config } from '../config';

export interface Chunk {
  content: string;
  index: number;
  tokenCount: number;
  metadata: {
    source: string;
    sourceType: string;
    category?: string;
    timestamp?: string;
    [key: string]: unknown;
  };
}

// Simple token estimator (1 token ≈ 4 chars)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Split text by semantic boundaries (paragraphs > sentences > words)
function splitBySemantic(text: string): string[] {
  // First try paragraph splits
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  if (paragraphs.length > 1) return paragraphs;

  // Then sentence splits
  const sentences = text.split(/(?<=[.!?。])\s+/).filter(s => s.trim().length > 0);
  if (sentences.length > 1) return sentences;

  // Fallback to fixed size
  return [text];
}

function mergeSmallChunks(segments: string[], maxTokens: number, overlap: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentTokens = 0;

  for (const seg of segments) {
    const segTokens = estimateTokens(seg);

    if (currentTokens + segTokens > maxTokens && current.length > 0) {
      chunks.push(current.trim());

      // Apply overlap: take last `overlap` chars from current as start of next
      const overlapText = current.slice(-overlap * 4);
      current = overlapText + ' ' + seg;
      currentTokens = estimateTokens(current);
    } else {
      current = current ? current + '\n\n' + seg : seg;
      currentTokens += segTokens;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

export function semanticChunk(
  text: string,
  metadata: Chunk['metadata'],
  options?: {
    chunkSize?: number;
    chunkOverlap?: number;
    minChunkSize?: number;
  }
): Chunk[] {
  const chunkSize = options?.chunkSize ?? config.rag.chunkSize;
  const chunkOverlap = options?.chunkOverlap ?? config.rag.chunkOverlap;
  const minChunkSize = options?.minChunkSize ?? config.rag.minChunkSize;

  const segments = splitBySemantic(text);
  const rawChunks = mergeSmallChunks(segments, chunkSize, chunkOverlap);

  return rawChunks
    .filter(chunk => estimateTokens(chunk) >= minChunkSize / 4)
    .map((content, index) => ({
      content,
      index,
      tokenCount: estimateTokens(content),
      metadata: {
        ...metadata,
        timestamp: metadata.timestamp || new Date().toISOString(),
      },
    }));
}

// Specialized chunkers for different content types

export function chunkMarkdown(
  markdown: string,
  metadata: Omit<Chunk['metadata'], 'category'>
): Chunk[] {
  // Split by headings first for structural chunking
  const sections = markdown.split(/(?=^#{1,3}\s)/m).filter(s => s.trim().length > 0);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const headingMatch = section.match(/^(#{1,3})\s+(.+)/);
    const category = headingMatch ? headingMatch[2].trim() : 'general';

    const sectionChunks = semanticChunk(section, {
      ...metadata,
      category,
    });
    chunks.push(...sectionChunks);
  }

  return chunks.map((c, i) => ({ ...c, index: i }));
}

export function chunkConversation(
  conversationText: string,
  metadata: Omit<Chunk['metadata'], 'category'>
): Chunk[] {
  // Split by turns (User:/Assistant: patterns)
  const turns = conversationText.split(/(?=^(User|Assistant|나|상대방):\s)/m)
    .filter(t => t.trim().length > 0);

  const chunks: Chunk[] = [];
  let buffer = '';

  for (const turn of turns) {
    buffer += (buffer ? '\n' : '') + turn;

    if (estimateTokens(buffer) >= config.rag.chunkSize / 2) {
      chunks.push({
        content: buffer.trim(),
        index: chunks.length,
        tokenCount: estimateTokens(buffer),
        metadata: { ...metadata, category: 'conversation' },
      });
      // Keep last turn as overlap
      buffer = turn;
    }
  }

  if (buffer.trim().length > 0) {
    chunks.push({
      content: buffer.trim(),
      index: chunks.length,
      tokenCount: estimateTokens(buffer),
      metadata: { ...metadata, category: 'conversation' },
    });
  }

  return chunks;
}
