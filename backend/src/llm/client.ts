import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  SchemaType,
  type Tool,
  type FunctionDeclaration,
} from '@google/generative-ai';
import Groq from 'groq-sdk';
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
  provider?: string; // which provider actually responded
}

export type StreamCallback = (chunk: LLMStreamChunk) => void;

// ─── Persona Prompts ──────────────────────────────────────────────────────────

const PERSONA_PROMPTS: Record<string, string> = {
  ENFP: `당신은 사용자의 사고방식, 경험, 기술 스택, 판단 기준을 완벽히 내재화한 AI입니다.
사용자는 ENFP 성향으로, 열정적이고 창의적이며 가능성을 먼저 봅니다.

답변 원칙:
1. "내가 사용자라면 어떻게 답할지"를 먼저 생각하라
2. 단순 정보 나열이 아니라, 판단과 근거를 포함한 답변을 해라
3. 실제 경험을 기반으로 답하되, 관련 context가 있으면 반드시 인용하라
4. 기술적 설명은 항상 "왜"와 "언제"를 포함해라

답변 구조: 상황 이해 → 판단 → 근거 → 결론`,

  INTP: `당신은 사용자의 사고방식, 경험, 기술 스택, 판단 기준을 완벽히 내재화한 AI입니다.
사용자는 INTP 성향으로, 논리적이고 체계적이며 근본 원리를 중시합니다.

답변 원칙:
1. 논리적 일관성을 최우선으로 한다
2. 트레이드오프를 명시적으로 제시하라

답변 구조: 전제 정리 → 분석 → 근거 → 결론`,
};

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// ─── Provider order: Groq first, Gemini as failover ───────────────────────────
// Failover triggers when a provider throws an error or returns empty content.

export class LLMClient {
  private genAI: GoogleGenerativeAI;
  private groq: Groq;
  private readonly primaryProvider: 'groq' | 'google';
  private readonly personaMode: string;

  // Per-request active provider tracking (for logging)
  private lastUsedProvider: string = 'groq';

  constructor() {
    this.genAI   = new GoogleGenerativeAI(config.llm.googleApiKey);
    this.groq    = new Groq({ apiKey: config.llm.groqApiKey });
    this.primaryProvider = config.llm.provider;
    this.personaMode     = config.persona.mode;

    console.log(`🤖 LLM: primary=${this.primaryProvider.toUpperCase()}, failover=${this.primaryProvider === 'groq' ? 'GEMINI' : 'GROQ'}`);
  }

  // ── Provider ordering ────────────────────────────────────────────────────────

  private getProviderOrder(): Array<'groq' | 'google'> {
    return this.primaryProvider === 'groq'
      ? ['groq', 'google']
      : ['google', 'groq'];
  }

  private modelFor(provider: 'groq' | 'google'): string {
    if (provider === 'groq')   return config.llm.provider === 'groq'   ? config.llm.model : 'llama-3.3-70b-versatile';
    if (provider === 'google') return config.llm.provider === 'google' ? config.llm.model : 'gemini-2.0-flash';
    return config.llm.model;
  }

  // ── System prompt builder ────────────────────────────────────────────────────

  buildSystemPrompt(retrievedContext?: string, toolResults?: string): string {
    const persona = PERSONA_PROMPTS[this.personaMode] ?? PERSONA_PROMPTS['ENFP'];
    const ctx  = retrievedContext ? `\n\n## 사용자의 실제 경험 & 지식\n${retrievedContext}` : '';
    const tool = toolResults     ? `\n\n## 도구 실행 결과\n${toolResults}`                    : '';
    return `${persona}${ctx}${tool}`;
  }

  // ── Groq streaming ────────────────────────────────────────────────────────────

  private async streamGroq(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<string> {
    const validMessages = messages.filter(m => m.content && m.content.trim() !== '');
    const groqMessages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...validMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    const groqTools: Groq.Chat.ChatCompletionTool[] = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: t.input_schema.properties, required: t.input_schema.required },
      },
    }));

    const stream = await this.groq.chat.completions.create({
      model: this.modelFor('groq'),
      messages: groqMessages,
      stream: true,
      max_tokens: 4096,
      temperature: 0.7,
      ...(groqTools.length > 0 ? { tools: groqTools, tool_choice: 'auto' } : {}),
    });

    let fullText = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        fullText += delta.content;
        onChunk({ type: 'text', content: delta.content, provider: 'groq' });
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(tc.function.arguments ?? '{}'); } catch { /**/ }
            onChunk({
              type: 'tool_call',
              toolCall: { id: tc.id ?? `groq-${Date.now()}`, name: tc.function.name, input: parsedInput },
              provider: 'groq',
            });
          }
        }
      }
    }

    if (!fullText) throw new Error('Groq returned empty response');
    onChunk({ type: 'done', provider: 'groq' });
    return fullText;
  }

  // ── Gemini streaming ──────────────────────────────────────────────────────────

  private async streamGemini(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<string> {
    const fnDecls: FunctionDeclaration[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: Object.fromEntries(
          Object.entries(t.input_schema.properties).map(([k, v]) => [
            k, { type: SchemaType.STRING, description: v.description },
          ])
        ),
        required: t.input_schema.required,
      },
    }));
    const geminiTools: Tool[] = fnDecls.length > 0 ? [{ functionDeclarations: fnDecls }] : [];

    const history = messages.slice(0, -1)
      .filter(m => m.content && m.content.trim() !== '')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const chatModel = this.genAI.getGenerativeModel({
      model: this.modelFor('google'),
      systemInstruction: systemPrompt,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
      ...(geminiTools.length > 0 ? { tools: geminiTools } : {}),
    });

    const chat   = chatModel.startChat({ history });
    const lastMsg = messages[messages.length - 1]?.content ?? '';
    const result  = await chat.sendMessageStream(lastMsg);

    let fullText = '';
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        onChunk({ type: 'text', content: text, provider: 'google' });
      }
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.functionCall) {
          onChunk({
            type: 'tool_call',
            toolCall: {
              id: `${part.functionCall.name}-${Date.now()}`,
              name: part.functionCall.name,
              input: (part.functionCall.args ?? {}) as Record<string, unknown>,
            },
            provider: 'google',
          });
        }
      }
    }

    if (!fullText) throw new Error('Gemini returned empty response');
    onChunk({ type: 'done', provider: 'google' });
    return fullText;
  }

  // ── Public: streamResponse with automatic failover ───────────────────────────

  async streamResponse(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<string> {
    const providers = this.getProviderOrder();
    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        console.log(`⚡ Trying ${provider.toUpperCase()}...`);
        let result: string;

        if (provider === 'groq') {
          result = await this.streamGroq(messages, systemPrompt, tools, onChunk);
        } else {
          result = await this.streamGemini(messages, systemPrompt, tools, onChunk);
        }

        this.lastUsedProvider = provider;
        return result;

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const next = providers[providers.indexOf(provider) + 1];
        console.warn(`⚠️  ${provider.toUpperCase()} failed: ${lastError.message}${next ? ` → Failing over to ${next.toUpperCase()}` : ''}`);

        // Notify frontend that we're failing over
        if (next) {
          onChunk({ type: 'text', content: '', provider });  // flush
        }
      }
    }

    // Both providers failed
    onChunk({ type: 'error', error: `All providers failed. Last error: ${lastError?.message}` });
    return '';
  }

  // ── Embeddings: always Google text-embedding-004 (Groq has no embedding API) ─

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const model  = this.genAI.getGenerativeModel({ model: config.llm.embeddingModel });
      const result = await model.embedContent(text);
      return result.embedding.values;
    } catch {
      return this.pseudoEmbedding(text);
    }
  }

  private pseudoEmbedding(text: string): number[] {
    const norm = text.toLowerCase().trim();
    const vec  = new Array(768).fill(0);
    for (let i = 0; i < norm.length; i++) vec[i % 768] += norm.charCodeAt(i) / 255;
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? vec.map(v => v / mag) : vec;
  }

  // ── Reflection with failover ──────────────────────────────────────────────────

  async reflectAndImprove(
    originalAnswer: string,
    question: string,
    context: string
  ): Promise<{ improved: boolean; answer: string; critique: string }> {
    const prompt = `다음 답변을 자기 비판적으로 검토하라.

질문: ${question}
초안: ${originalAnswer}
컨텍스트: ${context}

다음 JSON으로만 응답:
{"improve_needed": false, "critique": "...", "improved_answer": "..."}`;

    const providers = this.getProviderOrder();

    for (const provider of providers) {
      try {
        let text = '';

        if (provider === 'groq') {
          const res = await this.groq.chat.completions.create({
            model: this.modelFor('groq'),
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 2048,
            response_format: { type: 'json_object' },
          });
          text = res.choices[0]?.message?.content ?? '{}';
        } else {
          const model = this.genAI.getGenerativeModel({
            model: this.modelFor('google'),
            generationConfig: { maxOutputTokens: 2048, responseMimeType: 'application/json' },
            safetySettings: SAFETY_SETTINGS,
          });
          text = (await model.generateContent(prompt)).response.text();
        }

        const parsed = JSON.parse(text);
        return {
          improved: parsed.improve_needed,
          answer:   parsed.improve_needed ? parsed.improved_answer : originalAnswer,
          critique: parsed.critique ?? '',
        };
      } catch (err) {
        console.warn(`⚠️  Reflection ${provider} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    return { improved: false, answer: originalAnswer, critique: '' };
  }

  getLastUsedProvider(): string { return this.lastUsedProvider; }
}

export const llmClient = new LLMClient();
