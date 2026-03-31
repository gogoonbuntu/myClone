import Redis from 'ioredis';
import { config } from '../config';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  toolsUsed?: string[];
}

class ShortTermMemory {
  private redis: Redis | null = null;
  private fallback = new Map<string, ConversationTurn[]>();

  private getClient(): Redis {
    if (!this.redis) {
      this.redis = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        enableOfflineQueue: false,
        connectTimeout: 3000,
        lazyConnect: true,
      });

      this.redis.on('error', (err) => {
        if (!err.message.includes('ECONNREFUSED')) {
          console.warn('Redis error:', err.message);
        }
      });
    }
    return this.redis;
  }

  private key(conversationId: string): string {
    return `pka:conv:${conversationId}`;
  }

  async getTurns(conversationId: string): Promise<ConversationTurn[]> {
    try {
      const client = this.getClient();
      await client.ping();
      const data = await client.get(this.key(conversationId));
      return data ? JSON.parse(data) : [];
    } catch {
      return this.fallback.get(conversationId) ?? [];
    }
  }

  async addTurn(conversationId: string, turn: ConversationTurn): Promise<void> {
    try {
      const client = this.getClient();
      await client.ping();
      const turns = await this.getTurns(conversationId);
      turns.push(turn);

      // Keep only last N turns
      const trimmed = turns.slice(-config.memory.maxConversationTurns);
      await client.setex(
        this.key(conversationId),
        config.memory.shortTermTtl,
        JSON.stringify(trimmed)
      );
    } catch {
      const turns = this.fallback.get(conversationId) ?? [];
      turns.push(turn);
      this.fallback.set(conversationId, turns.slice(-config.memory.maxConversationTurns));
    }
  }

  async clearConversation(conversationId: string): Promise<void> {
    try {
      const client = this.getClient();
      await client.del(this.key(conversationId));
    } catch {
      this.fallback.delete(conversationId);
    }
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
