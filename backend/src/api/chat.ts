import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { agent, type AgentStreamEvent } from '../agent/orchestrator';
import { shortTermMemory } from '../memory/shortTerm';
import { llmClient } from '../llm/client';

const router = Router();

// POST /api/chat — NDJSON batch response (bypasses Express buffering issues)
// Frontend simulates streaming via typewriter animation
router.post('/chat', async (req: Request, res: Response) => {
  const { message, conversationId, useReflection } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const convId = conversationId || uuidv4();
  console.log(`💬 Chat request: "${message.slice(0, 50)}" (conv: ${convId.slice(0, 8)})`);

  // Collect all events from the agent
  const events: Array<{ event: string; data: unknown }> = [];
  events.push({ event: 'init', data: { conversationId: convId } });

  const onEvent = (event: AgentStreamEvent) => {
    switch (event.type) {
      case 'status':
        events.push({ event: 'status', data: { message: event.content } });
        break;
      case 'text':
        events.push({ event: 'text', data: { delta: event.content } });
        break;
      case 'original_text':
        events.push({ event: 'original_text', data: { content: event.content } });
        break;
      case 'replace_text':
        events.push({ event: 'replace_text', data: { content: event.content } });
        break;
      case 'tool_start':
        events.push({ event: 'tool_start', data: { tool: event.toolName } });
        break;
      case 'tool_result':
        events.push({ event: 'tool_result', data: { tool: event.toolName, result: event.toolResult } });
        break;
      case 'sources':
        events.push({ event: 'sources', data: {
          sources: event.sources?.map(s => ({
            id: s.id,
            content: s.content.slice(0, 200) + (s.content.length > 200 ? '...' : ''),
            score: s.score,
            source: s.metadata.source,
            category: s.metadata.category,
          })),
        }});
        break;
      case 'reflection':
        events.push({ event: 'reflection', data: event.reflection });
        break;
      case 'done':
        events.push({ event: 'done', data: { latency: event.content, provider: llmClient.getLastUsedProvider() } });
        break;
      case 'error':
        events.push({ event: 'error', data: { message: event.content } });
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
    events.push({ event: 'error', data: { message: `서버 오류: ${err instanceof Error ? err.message : '알 수 없는 오류'}` } });
  }

  // Send all events as NDJSON
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const body = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  res.send(body);
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
