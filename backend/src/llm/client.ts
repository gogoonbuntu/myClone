import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type GenerativeModel,
  type Tool,
  type FunctionDeclaration,
  SchemaType,
} from '@google/generative-ai';
import { config } from '../config';

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Persona Prompts ──────────────────────────────────────────────────────────

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

답변 원칙:
1. 논리적 일관성을 최우선으로 한다
2. 가정과 근거를 명확히 분리한다
3. 실제 경험을 기반으로 답하되, 관련 context가 있으면 반드시 인용하라
4. 트레이드오프를 명시적으로 제시하라

답변 구조:
- 전제 정리 → 분석 → 근거 → 결론`,
};

// Safety settings (permissive for personal use)
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// ─── Gemini LLM Client ────────────────────────────────────────────────────────

export class LLMClient {
  private genAI: GoogleGenerativeAI;
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly personaMode: 'ENFP' | 'INTP';

  constructor() {
    this.genAI = new GoogleGenerativeAI(config.llm.googleApiKey);
    this.model = config.llm.model;
    this.embeddingModel = config.llm.embeddingModel;
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

  // Convert our generic tool definitions to Gemini's FunctionDeclaration format
  private toGeminiFunctions(tools: ToolDefinition[]): Tool[] {
    if (tools.length === 0) return [];

    const functionDeclarations: FunctionDeclaration[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: Object.fromEntries(
          Object.entries(t.input_schema.properties).map(([k, v]) => [
            k,
            { type: v.type === 'string' ? SchemaType.STRING : SchemaType.STRING, description: v.description },
          ])
        ),
        required: t.input_schema.required,
      },
    }));

    return [{ functionDeclarations }];
  }

  // Convert our message history to Gemini's Content format
  private toGeminiHistory(messages: Message[]) {
    return messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  }

  async streamResponse(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<string> {
    const geminiTools = this.toGeminiFunctions(tools);
    const history = this.toGeminiHistory(messages);
    const lastUserMessage = messages[messages.length - 1]?.content ?? '';

    const chatModel: GenerativeModel = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      ...(geminiTools.length > 0 ? { tools: geminiTools } : {}),
    });

    const chat = chatModel.startChat({ history });

    let fullText = '';

    try {
      const result = await chat.sendMessageStream(lastUserMessage);

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          fullText += text;
          onChunk({ type: 'text', content: text });
        }

        // Check for function calls in candidates
        const candidate = chunk.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.functionCall) {
              onChunk({
                type: 'tool_call',
                toolCall: {
                  id: `${part.functionCall.name}-${Date.now()}`,
                  name: part.functionCall.name,
                  input: (part.functionCall.args ?? {}) as Record<string, unknown>,
                },
              });
            }
          }
        }
      }

      onChunk({ type: 'done' });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Gemini error';
      onChunk({ type: 'error', error });
    }

    return fullText;
  }

  // Use Gemini's text-embedding-004 (768-dim, much better than pseudo-embeddings)
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const embModel = this.genAI.getGenerativeModel({ model: this.embeddingModel });
      const result = await embModel.embedContent(text);
      return result.embedding.values;
    } catch {
      // Fallback pseudo-embedding if API key not set
      return this.pseudoEmbedding(text);
    }
  }

  private pseudoEmbedding(text: string): number[] {
    const normalized = text.toLowerCase().trim();
    const vector = new Array(768).fill(0);
    for (let i = 0; i < normalized.length; i++) {
      vector[i % 768] += normalized.charCodeAt(i) / 255;
    }
    const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
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

JSON으로만 응답 (다른 텍스트 없이):
{"improve_needed": boolean, "critique": "비판 내용", "improved_answer": "개선된 답변 (improve_needed가 true일 때만)"}`;

    try {
      const model = this.genAI.getGenerativeModel({
        model: this.model,
        generationConfig: { maxOutputTokens: 2048, responseMimeType: 'application/json' },
        safetySettings: SAFETY_SETTINGS,
      });

      const result = await model.generateContent(reflectionPrompt);
      const text = result.response.text();
      const parsed = JSON.parse(text);

      return {
        improved: parsed.improve_needed,
        answer: parsed.improve_needed ? parsed.improved_answer : originalAnswer,
        critique: parsed.critique,
      };
    } catch {
      return { improved: false, answer: originalAnswer, critique: '' };
    }
  }
}

export const llmClient = new LLMClient();
