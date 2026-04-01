import fs from 'fs';
import path from 'path';
import { llmClient } from '../llm/client';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ConversationSummary {
  id: string;
  summary: string;
  embedding: number[];
  timestamp: string;
  turnCount: number;
}

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

// ─── Long-term Memory (Local file-based) ─────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data');
const LONG_TERM_FILE = path.join(DATA_DIR, 'long_term_memory.json');

class LongTermMemory {
  private memories: ConversationSummary[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    if (fs.existsSync(LONG_TERM_FILE)) {
      try {
        this.memories = JSON.parse(fs.readFileSync(LONG_TERM_FILE, 'utf-8'));
      } catch {
        this.memories = [];
      }
    }
    this.initialized = true;
  }

  private save(): void {
    fs.writeFileSync(LONG_TERM_FILE, JSON.stringify(this.memories), 'utf-8');
  }

  // Summarize a conversation and store it as long-term memory
  async storeConversation(
    conversationId: string,
    turns: Array<{ role: string; content: string }>
  ): Promise<void> {
    await this.init();
    if (turns.length < 2) return;

    // Use LLM to summarize the conversation
    const conversationText = turns
      .map(t => `${t.role === 'user' ? '사용자' : 'AI'}: ${t.content}`)
      .join('\n');

    const summaryPrompt = `다음 대화를 3~5문장으로 핵심 내용 요약해줘. 사용자가 무엇을 물었고, AI가 어떤 핵심 정보를 제공했는지 위주로:\n\n${conversationText.slice(0, 3000)}`;

    try {
      let summary = '';
      await llmClient.streamResponse(
        [{ role: 'user', content: summaryPrompt }],
        '너는 대화 요약 전문가야. 간결하게 핵심만 요약해.',
        [],
        (chunk) => { if (chunk.type === 'text' && chunk.content) summary += chunk.content; }
      );

      if (!summary) return;

      const embedding = await llmClient.generateEmbedding(summary);

      // Remove old memory for same conversation
      this.memories = this.memories.filter(m => m.id !== conversationId);

      this.memories.push({
        id: conversationId,
        summary,
        embedding,
        timestamp: new Date().toISOString(),
        turnCount: turns.length,
      });

      this.save();
      console.log(`💾 Long-term memory saved for conversation ${conversationId}`);
    } catch (err) {
      console.warn('Long-term memory save failed:', err instanceof Error ? err.message : err);
    }
  }

  // Recall relevant past conversations
  async recall(query: string, topK: number = 3): Promise<string[]> {
    await this.init();
    if (this.memories.length === 0) return [];

    const queryEmb = await llmClient.generateEmbedding(query);

    const scored = this.memories.map(m => ({
      ...m,
      score: cosineSimilarity(queryEmb, m.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored
      .slice(0, topK)
      .filter(m => m.score > 0.3)
      .map(m => `[과거 대화 기억 - ${new Date(m.timestamp).toLocaleDateString('ko-KR')}]\n${m.summary}`);
  }

  async getStats(): Promise<{ count: number }> {
    await this.init();
    return { count: this.memories.length };
  }
}

export const longTermMemory = new LongTermMemory();
