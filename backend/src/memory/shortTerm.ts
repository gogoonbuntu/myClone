import { config } from '../config';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  toolsUsed?: string[];
}

class ShortTermMemory {
  private store = new Map<string, ConversationTurn[]>();

  async getTurns(conversationId: string): Promise<ConversationTurn[]> {
    return this.store.get(conversationId) ?? [];
  }

  async addTurn(conversationId: string, turn: ConversationTurn): Promise<void> {
    const turns = this.store.get(conversationId) ?? [];
    turns.push(turn);
    this.store.set(conversationId, turns.slice(-config.memory.maxConversationTurns));
  }

  async clearConversation(conversationId: string): Promise<void> {
    this.store.delete(conversationId);
  }

  async getCompressedContext(conversationId: string): Promise<string> {
    const turns = await this.getTurns(conversationId);
    if (turns.length === 0) return '';

    return turns
      .map(t => `${t.role === 'user' ? '사용자' : 'AI'}: ${t.content}`)
      .join('\n');
  }
}

export const shortTermMemory = new ShortTermMemory();

