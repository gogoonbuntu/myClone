import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMStreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
}

export type StreamCallback = (chunk: LLMStreamChunk) => void;

// ─── Persona Prompts ─────────────────────────────────────────────────────────

const PERSONA_PROMPTS = {
  ENFP: `당신은 사용자의 사고방식, 경험, 기술 스택, 판단 기준을 완벽히 내재화한 AI입니다.
사용자는 ENFP 성향으로, 열정적이고 창의적이며 가능성을 먼저 봅니다.
문제를 접근할 때 큰 그림을 먼저 본 뒤 구체적인 구현으로 내려갑니다.

답변 원칙:
1. "내가 사용자라면 어떻게 답할지"를 먼저 생각하라
2. 단순 정보 나열이 아니라, 판단과 근거를 포함한 답변을 해라
3. 실제 경험을 기반으로 답하되, 관련 context가 있으면 반드시 인용하라
4. 기술적 설명은 항상 "왜"와 "언제"를 포함해라
5. 불확실한 것은 솔직하게 말하되, 최선의 판단을 제시해라

답변 구조:
- 상황 이해 (질문의 핵심 파악)
- 판단 (내 관점에서의 답변)
- 근거 (경험/지식 기반 근거)
- 결론 (실행 가능한 제안)`,

  INTP: `당신은 사용자의 사고방식, 경험, 기술 스택, 판단 기준을 완벽히 내재화한 AI입니다.
사용자는 INTP 성향으로, 논리적이고 체계적이며 근본 원리를 중시합니다.
문제를 접근할 때 정확한 분석과 엄밀한 논증을 통해 결론을 도출합니다.

답변 원칙:
1. 논리적 일관성을 최우선으로 한다
2. 가정과 근거를 명확히 분리한다
3. 실제 경험을 기반으로 답하되, 관련 context가 있으면 반드시 인용하라
4. 트레이드오프를 명시적으로 제시하라
5. 불확실한 것은 불확실하다고 명시하라

답변 구조:
- 전제 정리 (질문의 가정 검토)
- 분석 (논리적 분석)
- 근거 (경험/지식 기반 근거)
- 결론 (최적 선택안과 근거)`,
};

// ─── LLM Client ──────────────────────────────────────────────────────────────

export class LLMClient {
  private client: Anthropic;
  private readonly model: string;
  private readonly personaMode: 'ENFP' | 'INTP';

  constructor() {
    this.client = new Anthropic({ apiKey: config.llm.anthropicApiKey });
    this.model = config.llm.model;
    this.personaMode = config.persona.mode;
  }

  buildSystemPrompt(retrievedContext?: string, toolResults?: string): string {
    const persona = PERSONA_PROMPTS[this.personaMode];
    const contextSection = retrievedContext
      ? `\n\n## 사용자의 실제 경험 & 지식 (검색된 컨텍스트)\n${retrievedContext}\n\n이 컨텍스트를 기반으로 답변하되, 관련 있는 경험을 자연스럽게 참조하라.`
      : '';
    const toolSection = toolResults
      ? `\n\n## 도구 실행 결과\n${toolResults}`
      : '';

    return `${persona}${contextSection}${toolSection}`;
  }

  async streamResponse(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<string> {
    let fullText = '';

    try {
      const stream = await this.client.messages.stream({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        tools: tools.length > 0 ? tools : undefined,
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta') {
          if (chunk.delta.type === 'text_delta') {
            fullText += chunk.delta.text;
            onChunk({ type: 'text', content: chunk.delta.text });
          } else if (chunk.delta.type === 'input_json_delta') {
            // Tool use accumulation
          }
        } else if (chunk.type === 'content_block_start') {
          if (chunk.content_block.type === 'tool_use') {
            onChunk({
              type: 'tool_call',
              toolCall: {
                id: chunk.content_block.id,
                name: chunk.content_block.name,
                input: {},
              },
            });
          }
        } else if (chunk.type === 'message_stop') {
          onChunk({ type: 'done' });
        }
      }

      const finalMessage = await stream.finalMessage();

      // Extract full tool calls from final message
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          onChunk({
            type: 'tool_call',
            toolCall: {
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            },
          });
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'LLM error';
      onChunk({ type: 'error', error });
    }

    return fullText;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Claude doesn't have embeddings; use a simple hash-based fallback
    // In production, use OpenAI text-embedding-3-small or Voyage AI
    // For demo: use a deterministic pseudo-embedding
    const normalized = text.toLowerCase().trim();
    const vector = new Array(1536).fill(0);

    for (let i = 0; i < normalized.length; i++) {
      const charCode = normalized.charCodeAt(i);
      vector[i % 1536] += charCode / 255;
    }

    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return magnitude > 0 ? vector.map(v => v / magnitude) : vector;
  }

  async reflectAndImprove(
    originalAnswer: string,
    question: string,
    context: string
  ): Promise<{ improved: boolean; answer: string; critique: string }> {
    const reflectionPrompt = `다음 답변을 자기 비판적으로 검토하라.

질문: ${question}

내 초안 답변:
${originalAnswer}

사용한 컨텍스트:
${context}

검토 기준:
1. 컨텍스트를 충분히 활용했는가?
2. 답변이 구체적이고 실행 가능한가?
3. 내 실제 경험과 스타일이 반영되었는가?
4. 개선이 필요한 부분이 있는가?

JSON으로 응답: {"improve_needed": boolean, "critique": "비판", "improved_answer": "개선된 답변 (필요시)"}`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: reflectionPrompt }],
    });

    try {
      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          improved: parsed.improve_needed,
          answer: parsed.improve_needed ? parsed.improved_answer : originalAnswer,
          critique: parsed.critique,
        };
      }
    } catch {
      // Reflection parsing failed, return original
    }

    return { improved: false, answer: originalAnswer, critique: '' };
  }
}

export const llmClient = new LLMClient();
