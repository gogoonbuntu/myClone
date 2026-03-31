import { vectorStore } from '../rag/pipeline';
import { llmClient } from '../llm/client';
import { config } from '../config';

export interface MemorySummary {
  conversationId: string;
  summary: string;
  keyTopics: string[];
  createdAt: string;
}

class LongTermMemory {
  async storeConversationSummary(
    conversationId: string,
    conversationText: string
  ): Promise<void> {
    await vectorStore.init();

    // Generate summary embedding
    const summary = await this.summarizeConversation(conversationText);
    const { semanticChunk } = await import('../rag/chunker');

    const chunks = semanticChunk(summary, {
      source: `conversation:${conversationId}`,
      sourceType: 'conversation',
      category: 'memory',
      timestamp: new Date().toISOString(),
    });

    await vectorStore.addChunks(chunks);
  }

  private async summarizeConversation(text: string): Promise<string> {
    if (text.length < 200) return text;

    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: config.llm.anthropicApiKey });

      const response = await client.messages.create({
        model: config.llm.model,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `다음 대화를 핵심만 요약하라. 사용자의 질문, AI의 핵심 답변, 중요한 판단 포인트를 포함할 것:\n\n${text}`,
        }],
      });

      return response.content[0].type === 'text' ? response.content[0].text : text;
    } catch {
      return text.slice(0, 1000);
    }
  }

  async searchRelatedMemories(query: string): Promise<string> {
    const { retrieveContext, formatContext } = await import('../rag/pipeline');
    const chunks = await retrieveContext(query, 3);
    return formatContext(chunks);
  }
}

export const longTermMemory = new LongTermMemory();
