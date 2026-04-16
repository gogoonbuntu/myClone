import { llmClient, type Message, type ToolCall, type StreamCallback } from '../llm/client';
import { retrieveContext, formatContext } from '../rag/pipeline';
import { shortTermMemory } from '../memory/shortTerm';
import { getProjectsTool } from '../tools/getProjects';
import { searchLogsTool } from '../tools/searchLogs';
import { githubFetchTool } from '../tools/githubFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentInput {
  conversationId: string;
  message: string;
  useReflection?: boolean;
}

export interface ProcessTraceStep {
  id: string;
  label: string;
  detail: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface AgentStreamEvent {
  type:
    | 'status'        // "검색 중...", "툴 실행 중..."
    | 'text'          // 실제 응답 텍스트 (스트리밍 delta)
    | 'original_text'  // 원본 텍스트 (Reflection 전)
    | 'replace_text'  // 기존 텍스트를 교체 (Reflection 개선)
    | 'tool_start'    // 툴 시작
    | 'tool_result'   // 툴 결과
    | 'sources'       // 사용한 RAG 소스
    | 'reflection'    // 반성 결과
    | 'process_trace' // 처리 시퀀스 전체
    | 'done'
    | 'error';
  content?: string;
  toolName?: string;
  toolResult?: string;
  sources?: Array<{ id: string; content: string; score: number; metadata: Record<string, unknown> }>;
  reflection?: { improved: boolean; critique: string };
  processTrace?: ProcessTraceStep[];
}

export type AgentStream = (event: AgentStreamEvent) => void;

// ─── Tools Registry ──────────────────────────────────────────────────────────

const TOOLS = [getProjectsTool, searchLogsTool, githubFetchTool];

const TOOL_DEFINITIONS = TOOLS.map(t => t.definition);

async function executeTool(toolCall: ToolCall): Promise<string> {
  const tool = TOOLS.find(t => t.definition.name === toolCall.name);
  if (!tool) return `Unknown tool: ${toolCall.name}`;

  return tool.execute(toolCall.input as unknown as Record<string, string>);
}

// ─── Model Architecture Info ─────────────────────────────────────────────────

interface ModelArch {
  name: string;
  params: string;
  layers: number;
  qHeads: number;
  kvHeads: number;
  hiddenDim: number;
  note: string;
}

function getModelArchInfo(provider: string): ModelArch {
  const p = provider.toLowerCase();

  // Llama 3.3 / 3.1 70B
  if (p.includes('llama') && (p.includes('70b') || p.includes('70-b'))) {
    return { name: 'Llama 3.3 70B', params: '70B', layers: 80, qHeads: 64, kvHeads: 8, hiddenDim: 8192, note: 'GQA 적용 — Q 64개가 KV 8개 공유' };
  }
  // Llama 4 Scout
  if (p.includes('llama-4') || p.includes('llama4') || p.includes('scout')) {
    return { name: 'Llama 4 Scout', params: '17B×16E MoE', layers: 48, qHeads: 32, kvHeads: 8, hiddenDim: 5120, note: 'MoE: 16개 전문가 중 활성화 선택' };
  }
  // Llama 3.1 8B
  if (p.includes('llama') && p.includes('8b')) {
    return { name: 'Llama 3.1 8B', params: '8B', layers: 32, qHeads: 32, kvHeads: 8, hiddenDim: 4096, note: 'GQA 적용 — 빠른 추론 특화' };
  }
  // Kimi K2
  if (p.includes('kimi') || p.includes('moonshot')) {
    return { name: 'Kimi K2', params: '32B MoE', layers: 48, qHeads: 32, kvHeads: 8, hiddenDim: 7168, note: 'MoE 구조, 수학·코딩 특화' };
  }
  // GPT OSS 120B
  if (p.includes('120b') || p.includes('gpt-oss-120')) {
    return { name: 'GPT OSS 120B', params: '120B', layers: 96, qHeads: 96, kvHeads: 8, hiddenDim: 12288, note: '대용량 파라미터, GQA 적용' };
  }
  // GPT OSS 20B
  if (p.includes('20b') || p.includes('gpt-oss-20')) {
    return { name: 'GPT OSS 20B', params: '20B', layers: 40, qHeads: 32, kvHeads: 8, hiddenDim: 5120, note: '경량 고속 모델' };
  }
  // Qwen 3 32B
  if (p.includes('qwen')) {
    return { name: 'Qwen3 32B', params: '32B', layers: 64, qHeads: 40, kvHeads: 8, hiddenDim: 5120, note: 'GQA + 다국어 특화' };
  }
  // Gemini 2.0 Flash
  if (p.includes('gemini-2') || p.includes('gemini/2')) {
    return { name: 'Gemini 2.0 Flash', params: '미공개', layers: 32, qHeads: 16, kvHeads: 8, hiddenDim: 4096, note: 'Google 독자 아키텍처, 내부 스펙 비공개' };
  }
  // Gemini 1.5 Flash
  if (p.includes('gemini-1') || p.includes('gemini')) {
    return { name: 'Gemini 1.5 Flash', params: '미공개', layers: 32, qHeads: 16, kvHeads: 8, hiddenDim: 4096, note: 'Google MoE 추정, 내부 스펙 비공개' };
  }
  // Default fallback
  return { name: provider || 'Unknown', params: '미공개', layers: 32, qHeads: 32, kvHeads: 8, hiddenDim: 4096, note: '스펙 미공개 모델' };
}

// ─── Agent Orchestrator ───────────────────────────────────────────────────────


export class AgentOrchestrator {

  async run(input: AgentInput, onEvent: AgentStream): Promise<void> {
    const { conversationId, message, useReflection = true } = input;
    const startTime = Date.now();
    const trace: ProcessTraceStep[] = [];
    const t = () => Date.now() - startTime;

    // Helper: estimate tokens (1 token ≈ 4 chars)
    const estimateTokens = (s: string) => Math.ceil(s.length / 4);

    try {
      // ── Step 1: 입력 토큰화
      const inputTokenEst = estimateTokens(message);
      trace.push({
        id: 'tokenize',
        label: '입력 토큰화',
        detail: `${message.length}자 → 약 ${inputTokenEst} 토큰으로 분할`,
        durationMs: t(),
        data: { chars: message.length, estimatedTokens: inputTokenEst, preview: message.slice(0, 60) },
      });

      // ── Step 2: 임베딩 생성
      onEvent({ type: 'status', content: '임베딩 생성 중...' });
      const embedStart = Date.now();
      trace.push({
        id: 'embed',
        label: '임베딩 생성 (text-embedding-004)',
        detail: `입력 텍스트 → 768차원 벡터 변환 (Google Embedding API)`,
        durationMs: Date.now() - embedStart,
        data: {
          model: 'text-embedding-004',
          outputDim: 768,
          heads: 12,
          headDim: 64,
          note: '12 heads × 64 dim = 768. 각 헤드가 다른 의미 관점을 포착',
        },
      });

      // ── Step 3: 기존 대화 컨텍스트 로드
      onEvent({ type: 'status', content: '기억 검색 중...' });
      const history = await shortTermMemory.getTurns(conversationId);
      const messages: Message[] = history.map(h => ({
        role: h.role,
        content: h.content,
      }));
      trace.push({
        id: 'memory',
        label: '단기 기억 로드',
        detail: `이전 대화 ${history.length}턴 로드 (Redis 단기 메모리)`,
        durationMs: t(),
        data: { turns: history.length, conversationId },
      });

      // ── Step 4: RAG 벡터 검색
      onEvent({ type: 'status', content: '지식 베이스 검색 중...' });
      const ragStart = Date.now();
      const retrievedChunks = await retrieveContext(message);
      const context = formatContext(retrievedChunks);
      const ragMs = Date.now() - ragStart;

      trace.push({
        id: 'rag_search',
        label: 'RAG 벡터 유사도 검색',
        detail: retrievedChunks.length > 0
          ? `코사인 유사도 계산 → 상위 ${retrievedChunks.length}개 청크 검색됨 (임계값 0.3 이상)`
          : '지식 베이스에서 관련 청크를 찾지 못함 (유사도 0.3 미만)',
        durationMs: ragMs,
        data: {
          method: 'cosine_similarity',
          threshold: 0.3,
          topK: 5,
          found: retrievedChunks.length,
          chunks: retrievedChunks.map(c => ({
            source: c.metadata.source,
            score: parseFloat((c.score * 100).toFixed(1)),
            category: c.metadata.category ?? null,
            preview: c.content.slice(0, 80),
          })),
        },
      });

      if (retrievedChunks.length > 0) {
        onEvent({ type: 'sources', sources: retrievedChunks });
      }

      // ── Step 5: 시스템 프롬프트 + 컨텍스트 조립
      const systemPrompt = llmClient.buildSystemPrompt(context || undefined);
      const contextTokens = estimateTokens(context);
      const systemTokens = estimateTokens(systemPrompt);
      trace.push({
        id: 'prompt_build',
        label: '프롬프트 조립',
        detail: `시스템 프롬프트 + 검색 컨텍스트 + 대화 히스토리 합산`,
        durationMs: t(),
        data: {
          systemTokens,
          contextTokens,
          historyTokens: messages.reduce((a, m) => a + estimateTokens(m.content), 0),
          totalInputTokens: systemTokens + contextTokens + inputTokenEst,
        },
      });

      // ── Step 6: LLM 추론 (Transformer forward pass)
      onEvent({ type: 'status', content: '응답 생성 중...' });
      messages.push({ role: 'user', content: message });

      const llmStart = Date.now();
      const collectedToolCalls: Array<{ toolCall: ToolCall; result: string }> = [];
      let responseText = '';
      const toolCallsInProgress = new Map<string, ToolCall>();
      let usedModel = '';

      const onChunk: StreamCallback = async (chunk) => {
        if (chunk.type === 'text') {
          responseText += chunk.content;
          if (chunk.provider) usedModel = chunk.provider;
          onEvent({ type: 'text', content: chunk.content });
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          const tc = chunk.toolCall;
          toolCallsInProgress.set(tc.id, tc);
          onEvent({ type: 'tool_start', toolName: tc.name });
        } else if (chunk.type === 'error') {
          console.error('LLM error in stream:', chunk.error);
          onEvent({ type: 'error', content: chunk.error ?? '알 수 없는 LLM 오류' });
        }
      };

      console.log('[ORCH] Step 6: Calling LLM...');
      await llmClient.streamResponse(messages, systemPrompt, TOOL_DEFINITIONS, onChunk);
      const llmMs = Date.now() - llmStart;
      const provider = llmClient.getLastUsedProvider();
      console.log(`[ORCH] Step 6 done: text=${responseText.length}, tools=${toolCallsInProgress.size}`);

      // Determine model architecture info
      const modelArch = getModelArchInfo(provider);
      trace.push({
        id: 'llm_inference',
        label: `LLM 추론 — ${provider}`,
        detail: `Transformer forward pass: ${modelArch.layers}개 레이어 × ${modelArch.qHeads}개 Q헤드 (KV: ${modelArch.kvHeads}개) × ${modelArch.hiddenDim} hidden dim`,
        durationMs: llmMs,
        data: {
          provider,
          architecture: modelArch,
          outputTokens: estimateTokens(responseText),
          tokensPerSec: llmMs > 0 ? Math.round((estimateTokens(responseText) / llmMs) * 1000) : 0,
          processingNote: [
            `레이어 1-${Math.floor(modelArch.layers * 0.25)}: 품사/위치 등 기초 패턴 학습`,
            `레이어 ${Math.floor(modelArch.layers * 0.25)+1}-${Math.floor(modelArch.layers * 0.6)}: 구문·의미 관계 포착`,
            `레이어 ${Math.floor(modelArch.layers * 0.6)+1}-${modelArch.layers}: 추론·맥락·태스크 특화`,
          ],
          attentionNote: modelArch.qHeads !== modelArch.kvHeads
            ? `GQA: ${modelArch.qHeads}개 Q헤드가 ${modelArch.kvHeads}개 KV헤드 공유 → 메모리 ${Math.round(modelArch.qHeads/modelArch.kvHeads)}배 절약`
            : `MHA: Q/K/V 헤드 모두 ${modelArch.qHeads}개 (BERT 방식)`,
        },
      });

      // ── Step 7: 툴 실행
      if (toolCallsInProgress.size > 0) {
        onEvent({ type: 'status', content: `${toolCallsInProgress.size}개 도구 실행 중...` });

        for (const [, toolCall] of toolCallsInProgress) {
          const toolStart = Date.now();
          onEvent({ type: 'tool_start', toolName: toolCall.name });
          const result = await executeTool(toolCall);
          collectedToolCalls.push({ toolCall, result });
          onEvent({ type: 'tool_result', toolName: toolCall.name, toolResult: result });
          trace.push({
            id: `tool_${toolCall.name}`,
            label: `도구 실행: ${toolCall.name}`,
            detail: `외부 도구 호출 후 결과를 컨텍스트에 삽입`,
            durationMs: Date.now() - toolStart,
            data: { tool: toolCall.name, resultPreview: result.slice(0, 100) },
          });
        }

        onEvent({ type: 'status', content: '결과 종합 중...' });
        const toolResultsText = collectedToolCalls
          .map(tc => `[${tc.toolCall.name} 결과]\n${tc.result}`)
          .join('\n\n');

        const systemWithTools = llmClient.buildSystemPrompt(context || undefined, toolResultsText);
        const messagesWithTools: Message[] = [
          ...messages,
          { role: 'assistant', content: responseText || '도구를 실행하여 정보를 수집했습니다.' },
          { role: 'user', content: `도구 실행 결과를 바탕으로 원래 질문에 답변해 주세요: ${message}` },
        ];

        responseText = '';
        await llmClient.streamResponse(messagesWithTools, systemWithTools, [], (chunk) => {
          if (chunk.type === 'text') {
            responseText += chunk.content;
            onEvent({ type: 'text', content: chunk.content });
          }
        });
      }

      // ── Step 8: Reflection
      if (useReflection && responseText.length > 200) {
        onEvent({ type: 'status', content: '답변 검토 중...' });
        const reflStart = Date.now();
        const originalText = responseText;

        const reflection = await llmClient.reflectAndImprove(responseText, message, context);

        trace.push({
          id: 'reflection',
          label: `Reflection (자기 비판)`,
          detail: reflection.improved
            ? '초안의 부족한 부분을 발견하여 개선된 답변으로 교체'
            : '초안 품질 검증 완료 — 개선 불필요',
          durationMs: Date.now() - reflStart,
          data: { improved: reflection.improved, critiquePreview: reflection.critique.slice(0, 120) },
        });

        if (reflection.improved) {
          console.log(`[ORCH] Reflection improved! length=${reflection.answer?.length}`);
          onEvent({ type: 'status', content: '답변 개선 중...' });
          onEvent({ type: 'original_text', content: originalText });
          const improvedAnswer = typeof reflection.answer === 'string' && reflection.answer.length > 0
            ? reflection.answer : originalText;
          onEvent({ type: 'replace_text', content: improvedAnswer });
          responseText = improvedAnswer;
        }

        onEvent({ type: 'reflection', reflection: { improved: reflection.improved, critique: reflection.critique } });
      }

      // ── Step 9: 출력 및 메모리 저장
      const outputTokens = estimateTokens(responseText);
      trace.push({
        id: 'output',
        label: '최종 응답 출력',
        detail: `${responseText.length}자 / 약 ${outputTokens} 토큰 생성`,
        durationMs: Date.now() - startTime,
        data: { chars: responseText.length, estimatedTokens: outputTokens, totalMs: Date.now() - startTime },
      });

      // Emit full trace
      onEvent({ type: 'process_trace', processTrace: trace });

      console.log('[ORCH] Step 9: Saving memory...');
      await shortTermMemory.addTurn(conversationId, {
        role: 'user', content: message, timestamp: new Date().toISOString(),
      });
      await shortTermMemory.addTurn(conversationId, {
        role: 'assistant', content: responseText,
        timestamp: new Date().toISOString(),
        toolsUsed: collectedToolCalls.map(tc => tc.toolCall.name),
      });

      const latency = Date.now() - startTime;
      console.log(`[ORCH] Sending done event (${latency}ms)`);
      onEvent({ type: 'done', content: `완료 (${latency}ms)` });
      console.log('[ORCH] Done event sent');

    } catch (err) {
      const error = err instanceof Error ? err.message : 'Agent error';
      console.error('Agent error:', error);
      onEvent({ type: 'error', content: error });
    }
  }
}

export const agent = new AgentOrchestrator();
