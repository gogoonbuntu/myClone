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

export interface AgentStreamEvent {
  type:
    | 'status'        // "검색 중...", "툴 실행 중..."
    | 'text'          // 실제 응답 텍스트
    | 'tool_start'    // 툴 시작
    | 'tool_result'   // 툴 결과
    | 'sources'       // 사용한 RAG 소스
    | 'reflection'    // 반성 결과
    | 'done'
    | 'error';
  content?: string;
  toolName?: string;
  toolResult?: string;
  sources?: Array<{ id: string; content: string; score: number; metadata: Record<string, unknown> }>;
  reflection?: { improved: boolean; critique: string };
}

export type AgentStream = (event: AgentStreamEvent) => void;

// ─── Tools Registry ──────────────────────────────────────────────────────────

const TOOLS = [getProjectsTool, searchLogsTool, githubFetchTool];

const TOOL_DEFINITIONS = TOOLS.map(t => t.definition);

async function executeTool(toolCall: ToolCall): Promise<string> {
  const tool = TOOLS.find(t => t.definition.name === toolCall.name);
  if (!tool) return `Unknown tool: ${toolCall.name}`;

  return tool.execute(toolCall.input as Record<string, string>);
}

// ─── Agent Orchestrator ───────────────────────────────────────────────────────

export class AgentOrchestrator {

  async run(input: AgentInput, onEvent: AgentStream): Promise<void> {
    const { conversationId, message, useReflection = true } = input;
    const startTime = Date.now();

    try {
      // ── Step 1: 기존 대화 컨텍스트 로드
      onEvent({ type: 'status', content: '기억 검색 중...' });
      const history = await shortTermMemory.getTurns(conversationId);
      const messages: Message[] = history.map(h => ({
        role: h.role,
        content: h.content,
      }));

      // ── Step 2: RAG 검색
      onEvent({ type: 'status', content: '지식 베이스 검색 중...' });
      const retrievedChunks = await retrieveContext(message);
      const context = formatContext(retrievedChunks);

      if (retrievedChunks.length > 0) {
        onEvent({ type: 'sources', sources: retrievedChunks });
      }

      // ── Step 3: 시스템 프롬프트 구성
      const systemPrompt = llmClient.buildSystemPrompt(context || undefined);

      // ── Step 4: 첫 번째 LLM 호출 (tool 포함)
      onEvent({ type: 'status', content: '응답 생성 중...' });

      messages.push({ role: 'user', content: message });

      const collectedToolCalls: Array<{ toolCall: ToolCall; result: string }> = [];
      let responseText = '';

      // Collect tool calls from stream
      const toolCallsInProgress = new Map<string, ToolCall>();

      const onChunk: StreamCallback = async (chunk) => {
        if (chunk.type === 'text') {
          responseText += chunk.content;
          onEvent({ type: 'text', content: chunk.content });
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          const tc = chunk.toolCall;
          // Only fire event if we have full input (from finalMessage)
          if (Object.keys(tc.input).length > 0) {
            toolCallsInProgress.set(tc.id, tc);
            onEvent({ type: 'tool_start', toolName: tc.name });
          }
        }
      };

      await llmClient.streamResponse(messages, systemPrompt, TOOL_DEFINITIONS, onChunk);

      // ── Step 5: 툴 실행 (tool calls detected)
      if (toolCallsInProgress.size > 0) {
        onEvent({ type: 'status', content: `${toolCallsInProgress.size}개 도구 실행 중...` });

        for (const [, toolCall] of toolCallsInProgress) {
          onEvent({ type: 'tool_start', toolName: toolCall.name });
          const result = await executeTool(toolCall);
          collectedToolCalls.push({ toolCall, result });
          onEvent({ type: 'tool_result', toolName: toolCall.name, toolResult: result });
        }

        // ── Step 6: 툴 결과를 포함한 2차 LLM 호출
        onEvent({ type: 'status', content: '결과 종합 중...' });
        const toolResultsText = collectedToolCalls
          .map(tc => `[${tc.toolCall.name} 결과]\n${tc.result}`)
          .join('\n\n');

        const systemWithTools = llmClient.buildSystemPrompt(context || undefined, toolResultsText);

        // Add assistant's partial response + tool results as context
        const messagesWithTools: Message[] = [
          ...messages,
          {
            role: 'assistant',
            content: responseText || '도구를 실행하여 정보를 수집했습니다.',
          },
          {
            role: 'user',
            content: `도구 실행 결과를 바탕으로 원래 질문에 답변해 주세요: ${message}`,
          },
        ];

        responseText = '';
        await llmClient.streamResponse(messagesWithTools, systemWithTools, [], (chunk) => {
          if (chunk.type === 'text') {
            responseText += chunk.content;
            onEvent({ type: 'text', content: chunk.content });
          }
        });
      }

      // ── Step 7: Reflection Loop
      if (useReflection && responseText.length > 200) {
        onEvent({ type: 'status', content: '답변 검토 중...' });

        const reflection = await llmClient.reflectAndImprove(
          responseText,
          message,
          context
        );

        if (reflection.improved) {
          onEvent({ type: 'status', content: '답변 개선 중...' });
          // Send the improved answer as additional text
          onEvent({ type: 'text', content: '\n\n---\n*[개선된 답변]*\n\n' + reflection.answer });
          responseText = reflection.answer;
        }

        onEvent({
          type: 'reflection',
          reflection: { improved: reflection.improved, critique: reflection.critique },
        });
      }

      // ── Step 8: 메모리 저장
      await shortTermMemory.addTurn(conversationId, {
        role: 'user',
        content: message,
        timestamp: new Date().toISOString(),
      });

      await shortTermMemory.addTurn(conversationId, {
        role: 'assistant',
        content: responseText,
        timestamp: new Date().toISOString(),
        toolsUsed: collectedToolCalls.map(tc => tc.toolCall.name),
      });

      const latency = Date.now() - startTime;
      onEvent({ type: 'done', content: `완료 (${latency}ms)` });

    } catch (err) {
      const error = err instanceof Error ? err.message : 'Agent error';
      console.error('Agent error:', error);
      onEvent({ type: 'error', content: error });
    }
  }
}

export const agent = new AgentOrchestrator();
