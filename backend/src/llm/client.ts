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
  ENFP: `당신은 사용자의 개인 지식 에이전트입니다.
사용자는 ENFP 성향으로, 열정적이고 창의적이며 가능성을 먼저 봅니다.

## 핵심 규칙 (절대 위반 금지)
1. **제공된 컨텍스트와 도구 결과에 있는 정보만 사용하라.** 
2. **존재하지 않는 프로젝트, 경험, 기술 스택을 절대 지어내지 마라.**
3. 컨텍스트에 관련 정보가 없으면 "현재 등록된 지식에서 관련 내용을 찾지 못했습니다. 지식을 추가해 주시면 더 정확한 답변이 가능합니다."라고 솔직하게 답하라.
4. 도구 결과가 비어있거나 "No projects found" 등이면 해당 정보가 없다고 명시하라.
5. 추측이나 일반론은 최소화하고, 반드시 "이것은 일반적인 정보입니다"라고 구분하라.

## 답변 원칙
- 실제 context에 있는 내용만 인용하라
- 기술적 설명은 "왜"와 "언제"를 포함하라
- 판단과 근거를 포함하되, 없는 사실을 만들지 마라

답변 구조: 컨텍스트 확인 → 판단 → 근거(출처 명시) → 결론`,

  INTP: `당신은 사용자의 개인 지식 에이전트입니다.
사용자는 INTP 성향으로, 논리적이고 체계적이며 근본 원리를 중시합니다.

## 핵심 규칙 (절대 위반 금지)
1. **제공된 컨텍스트와 도구 결과에 있는 정보만 사용하라.**
2. **존재하지 않는 프로젝트, 경험, 기술 스택을 절대 지어내지 마라.**
3. 컨텍스트에 관련 정보가 없으면 솔직하게 "등록된 지식에서 해당 내용을 찾을 수 없습니다."라고 답하라.
4. 추측과 사실을 명확히 구분하라.

## 답변 원칙
- 논리적 일관성을 최우선으로 한다
- 트레이드오프를 명시적으로 제시하라
- 없는 정보를 지어내기보다 정보의 부재를 인정하라

답변 구조: 전제 정리 → 분석 → 근거(출처 명시) → 결론`,
};

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// ─── Groq multi-model failover ────────────────────────────────────────────────
// Each Groq model has its own separate rate limit (TPD/RPM).
// We try multiple models before falling back to Gemini.

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',             // Primary: Llama 3.3 70B
  'openai/gpt-oss-120b',                 // GPT OSS 120B: largest model
  'moonshotai/kimi-k2-instruct',         // Kimi K2: high quality
  'meta-llama/llama-4-scout-17b-16e-instruct', // Llama 4 Scout
  'qwen/qwen3-32b',                      // Qwen 3 32B
  'openai/gpt-oss-20b',                  // GPT OSS 20B
  'llama-3.1-8b-instant',                // Fast & small fallback
];

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

export class LLMClient {
  private genAI: GoogleGenerativeAI;
  private groq: Groq;
  private readonly primaryProvider: 'groq' | 'google';
  private readonly personaMode: string;

  // Per-request active provider tracking (for logging)
  private lastUsedProvider: string = 'groq';
  private lastUsedModel: string = '';

  constructor() {
    this.genAI   = new GoogleGenerativeAI(config.llm.googleApiKey);
    this.groq    = new Groq({ apiKey: config.llm.groqApiKey });
    this.primaryProvider = config.llm.provider;
    this.personaMode     = config.persona.mode;

    console.log(`🤖 LLM: primary=${this.primaryProvider.toUpperCase()}, Groq models: ${GROQ_MODELS.length}, Gemini models: ${GEMINI_MODELS.length}`);
  }

  private geminiModel(): string {
    return config.llm.provider === 'google' ? config.llm.model : 'gemini-2.0-flash';
  }

  // ── System prompt builder ────────────────────────────────────────────────────

  buildSystemPrompt(retrievedContext?: string, toolResults?: string): string {
    const persona = PERSONA_PROMPTS[this.personaMode] ?? PERSONA_PROMPTS['ENFP'];
    const ctx  = retrievedContext ? `\n\n## 사용자의 실제 경험 & 지식\n${retrievedContext}` : '';
    const tool = toolResults     ? `\n\n## 도구 실행 결과\n${toolResults}`                    : '';
    return `${persona}${ctx}${tool}`;
  }

  // ── Timeout helper ─────────────────────────────────────────────────────────────

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
  }

  // ── Groq streaming ────────────────────────────────────────────────────────────

  private buildGroqMessages(messages: Message[], systemPrompt: string) {
    const validMessages = messages.filter(m => {
      const raw: unknown = m.content;
      const c = typeof raw === 'string' ? raw : String(raw ?? '');
      return c.trim() !== '';
    });
    const groqMessages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...validMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
      })),
    ];
    return { validMessages, groqMessages };
  }

  private async streamGroq(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: StreamCallback,
    modelOverride?: string
  ): Promise<string> {
    const { validMessages, groqMessages } = this.buildGroqMessages(messages, systemPrompt);

    const useTools = tools.length > 0;
    const groqTools: Groq.Chat.ChatCompletionTool[] = useTools ? tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: t.input_schema.properties, required: t.input_schema.required },
      },
    })) : [];

    const model = modelOverride || GROQ_MODELS[0];
    console.log(`  → Groq [${model}]: ${validMessages.length} messages, ${groqTools.length} tools`);

    const streamPromise = this.groq.chat.completions.create({
      model,
      messages: groqMessages,
      stream: true,
      max_tokens: 4096,
      temperature: 0.7,
      ...(groqTools.length > 0 ? { tools: groqTools, tool_choice: 'auto' } : {}),
    });

    // Add 30s timeout to the initial connection
    const stream = await this.withTimeout(streamPromise, 30000, 'Groq stream creation');

    let fullText = '';
    let hasToolCalls = false;
    let lastChunkTime = Date.now();

    for await (const chunk of stream) {
      lastChunkTime = Date.now();
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        fullText += delta.content;
        onChunk({ type: 'text', content: delta.content, provider: 'groq' });
      }

      if (delta?.tool_calls) {
        hasToolCalls = true;
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

    console.log(`  → Groq result: text=${fullText.length}chars, toolCalls=${hasToolCalls}`);

    // If tool_calls were returned, empty text is normal (orchestrator handles tools)
    if (!fullText && !hasToolCalls) {
      console.warn('⚠️  Groq returned no text and no tool calls, retrying without tools...');
      const stream2Promise = this.groq.chat.completions.create({
        model,
        messages: groqMessages,
        stream: true,
        max_tokens: 4096,
        temperature: 0.8,
      });
      const stream2 = await this.withTimeout(stream2Promise, 30000, 'Groq retry');
      for await (const chunk of stream2) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          fullText += delta.content;
          onChunk({ type: 'text', content: delta.content, provider: 'groq' });
        }
      }
      if (!fullText) throw new Error('Groq returned empty response after retry');
    }
    onChunk({ type: 'done', provider: 'groq' });
    return fullText;
  }

  // ── Gemini streaming ──────────────────────────────────────────────────────────

  private async streamGemini(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: StreamCallback,
    modelOverride?: string
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
      .filter(m => {
        const c = typeof m.content === 'string' ? m.content : String(m.content || '');
        return c.trim() !== '';
      })
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content ?? '') }],
      }));

    const gemModel = modelOverride || this.geminiModel();
    const chatModel = this.genAI.getGenerativeModel({
      model: gemModel,
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

  // ── Public: streamResponse with multi-model failover ──────────────────────────
  // Tries each Groq model (each has separate quota), then Gemini models

  async streamResponse(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<string> {
    let lastError: Error | null = null;

    // Phase 1: Try all Groq models
    for (const model of GROQ_MODELS) {
      try {
        console.log(`⚡ Trying GROQ [${model}]...`);
        const result = await this.streamGroq(messages, systemPrompt, tools, onChunk, model);
        this.lastUsedProvider = 'groq';
        this.lastUsedModel = model;
        console.log(`✅ GROQ [${model}] succeeded (${result.length} chars)`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const shortErr = lastError.message.slice(0, 120);
        console.warn(`⚠️  GROQ [${model}] failed: ${shortErr}`);
      }
    }

    // Phase 2: Try Gemini models
    for (const model of GEMINI_MODELS) {
      try {
        console.log(`⚡ Trying GEMINI [${model}]...`);
        const result = await this.streamGemini(messages, systemPrompt, tools, onChunk, model);
        this.lastUsedProvider = 'google';
        this.lastUsedModel = model;
        console.log(`✅ GEMINI [${model}] succeeded (${result.length} chars)`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const shortErr = lastError.message.slice(0, 120);
        console.warn(`⚠️  GEMINI [${model}] failed: ${shortErr}`);
      }
    }

    // All models failed
    let errorMsg: string;
    const rawMsg = lastError?.message || '';
    if (rawMsg.includes('429') || rawMsg.includes('rate_limit') || rawMsg.includes('quota')) {
      errorMsg = `⏳ 모든 AI 모델의 사용량 한도에 도달했습니다 (Groq ${GROQ_MODELS.length}개 + Gemini ${GEMINI_MODELS.length}개). 잠시 후 다시 시도해 주세요.`;
    } else {
      errorMsg = `AI 응답 생성에 실패했습니다: ${rawMsg.slice(0, 200)}`;
    }
    console.error(`❌ ${errorMsg}`);
    onChunk({ type: 'error', error: errorMsg });
    return '';
  }

  // ── Public: stream with a specific provider (no failover) ───────────────────

  async streamWithProvider(
    provider: 'groq' | 'google',
    messages: Message[],
    systemPrompt: string,
    onChunk: StreamCallback
  ): Promise<string> {
    try {
      console.log(`⚡ Force ${provider.toUpperCase()}...`);
      if (provider === 'groq') {
        return await this.streamGroq(messages, systemPrompt, [], onChunk);
      } else {
        return await this.streamGemini(messages, systemPrompt, [], onChunk);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  ${provider.toUpperCase()} failed: ${msg}`);
      onChunk({ type: 'error', error: msg });
      return '';
    }
  }

  // ── Embeddings: always Google text-embedding-004 (Groq has no embedding API) ─

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const model  = this.genAI.getGenerativeModel({ model: config.llm.embeddingModel });
      const result = await this.withTimeout(
        model.embedContent(text),
        10000,
        'Embedding generation'
      );
      return result.embedding.values;
    } catch (err) {
      console.warn(`⚠️  Embedding failed (using pseudo): ${err instanceof Error ? err.message : err}`);
      return this.pseudoEmbedding(text);
    }
  }

  private pseudoEmbedding(text: string): number[] {
    // Deterministic pseudo-embedding based on character codes
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

    // Try all Groq models first
    for (const model of GROQ_MODELS) {
      try {
        const res = await this.groq.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2048,
          response_format: { type: 'json_object' },
        });
        const text = res.choices[0]?.message?.content ?? '{}';
        const parsed = JSON.parse(text);
        const isImproved = !!parsed.improve_needed;
        console.log(`✅ Reflection via GROQ [${model}]`);
        return {
          improved: isImproved,
          answer:   isImproved && parsed.improved_answer
            ? (typeof parsed.improved_answer === 'string' ? parsed.improved_answer : JSON.stringify(parsed.improved_answer))
            : originalAnswer,
          critique: parsed.critique ?? '',
        };
      } catch (err) {
        console.warn(`⚠️  Reflection GROQ [${model}] failed: ${(err instanceof Error ? err.message : err + '').slice(0, 80)}`);
      }
    }

    // Then try Gemini models
    for (const gemModel of GEMINI_MODELS) {
      try {
        const model = this.genAI.getGenerativeModel({
          model: gemModel,
          generationConfig: { maxOutputTokens: 2048, responseMimeType: 'application/json' },
          safetySettings: SAFETY_SETTINGS,
        });
        const text = (await model.generateContent(prompt)).response.text();
        const parsed = JSON.parse(text);
        const isImproved = !!parsed.improve_needed;
        console.log(`✅ Reflection via GEMINI [${gemModel}]`);
        return {
          improved: isImproved,
          answer:   isImproved && parsed.improved_answer
            ? (typeof parsed.improved_answer === 'string' ? parsed.improved_answer : JSON.stringify(parsed.improved_answer))
            : originalAnswer,
          critique: parsed.critique ?? '',
        };
      } catch (err) {
        console.warn(`⚠️  Reflection GEMINI [${gemModel}] failed: ${(err instanceof Error ? err.message : err + '').slice(0, 80)}`);
      }
    }

    return { improved: false, answer: originalAnswer, critique: '' };
  }

  getLastUsedProvider(): string { return `${this.lastUsedProvider}/${this.lastUsedModel}`; }
}

export const llmClient = new LLMClient();
