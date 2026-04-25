import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { agent, type AgentStreamEvent } from '../agent/orchestrator';
import { shortTermMemory } from '../memory/shortTerm';
import { llmClient } from '../llm/client';

const router = Router();

// POST /api/chat — 실시간 NDJSON 스트리밍
// 각 이벤트를 생성 즉시 클라이언트로 flush해 첫 응답을 최대한 빠르게 전달
router.post('/chat', async (req: Request, res: Response) => {
  const { message, conversationId, useReflection } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const convId = conversationId || uuidv4();
  console.log(`💬 Chat request: "${message.slice(0, 50)}" (conv: ${convId.slice(0, 8)})`);

  // ── 스트리밍 헤더 설정 및 즉시 전송 ──────────────────────────────────────
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 버퍼링 비활성화
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // 헤더를 즉시 클라이언트로 전송

  // 이벤트를 즉시 write하는 헬퍼
  const writeEvent = (event: string, data: unknown) => {
    try {
      res.write(JSON.stringify({ event, data }) + '\n');
    } catch (e) {
      console.error('[STREAM] write error:', e);
    }
  };

  // init 이벤트 즉시 전송
  writeEvent('init', { conversationId: convId });

  const onEvent = (event: AgentStreamEvent) => {
    switch (event.type) {
      case 'status':
        writeEvent('status', { message: event.content });
        break;
      case 'text':
        writeEvent('text', { delta: event.content });
        break;
      case 'original_text':
        writeEvent('original_text', { content: event.content });
        break;
      case 'replace_text':
        writeEvent('replace_text', { content: event.content });
        break;
      case 'tool_start':
        writeEvent('tool_start', { tool: event.toolName });
        break;
      case 'tool_result':
        writeEvent('tool_result', { tool: event.toolName, result: event.toolResult });
        break;
      case 'sources':
        writeEvent('sources', {
          sources: event.sources?.map(s => ({
            id: s.id,
            content: s.content.slice(0, 200) + (s.content.length > 200 ? '...' : ''),
            score: s.score,
            source: s.metadata.source,
            category: s.metadata.category,
          })),
        });
        break;
      case 'reflection':
        writeEvent('reflection', event.reflection);
        break;
      case 'process_trace':
        writeEvent('process_trace', { steps: event.processTrace });
        break;
      case 'done':
        writeEvent('done', { latency: event.content, provider: llmClient.getLastUsedProvider() });
        break;
      case 'error':
        writeEvent('error', { message: event.content });
        break;
    }
  };

  try {
    await agent.run(
      { conversationId: convId, message, useReflection: useReflection ?? true },
      onEvent
    );
  } catch (err) {
    console.error('Agent run error:', err);
    writeEvent('error', { message: `서버 오류: ${err instanceof Error ? err.message : '알 수 없는 오류'}` });
  }

  res.end();
});

// DELETE /api/chat/:conversationId
router.delete('/chat/:conversationId', async (req: Request, res: Response) => {
  const conversationId = req.params.conversationId as string;
  await shortTermMemory.clearConversation(conversationId);
  res.json({ success: true, message: 'Conversation cleared' });
});

// GET /api/chat/:conversationId/history
router.get('/chat/:conversationId/history', async (req: Request, res: Response) => {
  const conversationId = req.params.conversationId as string;
  const turns = await shortTermMemory.getTurns(conversationId);
  res.json({ conversationId, turns });
});

export default router;
