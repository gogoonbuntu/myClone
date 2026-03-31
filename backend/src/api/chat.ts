import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { agent, type AgentStreamEvent } from '../agent/orchestrator';
import { shortTermMemory } from '../memory/shortTerm';

const router = Router();

// POST /api/chat — SSE Streaming
router.post('/chat', async (req: Request, res: Response) => {
  const { message, conversationId, useReflection } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const convId = conversationId || uuidv4();

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send conversation ID first
  sendSSE(res, 'init', { conversationId: convId });

  const onEvent = (event: AgentStreamEvent) => {
    if (res.writableEnded) return;

    switch (event.type) {
      case 'status':
        sendSSE(res, 'status', { message: event.content });
        break;
      case 'text':
        sendSSE(res, 'text', { delta: event.content });
        break;
      case 'tool_start':
        sendSSE(res, 'tool_start', { tool: event.toolName });
        break;
      case 'tool_result':
        sendSSE(res, 'tool_result', { tool: event.toolName, result: event.toolResult });
        break;
      case 'sources':
        sendSSE(res, 'sources', {
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
        sendSSE(res, 'reflection', event.reflection);
        break;
      case 'done':
        sendSSE(res, 'done', { latency: event.content });
        res.end();
        break;
      case 'error':
        sendSSE(res, 'error', { message: event.content });
        res.end();
        break;
    }
  };

  // Handle client disconnect
  req.on('close', () => {
    res.end();
  });

  await agent.run(
    { conversationId: convId, message, useReflection: useReflection ?? true },
    onEvent
  );
});

// DELETE /api/chat/:conversationId — Clear conversation
router.delete('/chat/:conversationId', async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  await shortTermMemory.clearConversation(conversationId);
  res.json({ success: true, message: 'Conversation cleared' });
});

// GET /api/chat/:conversationId/history
router.get('/chat/:conversationId/history', async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  const turns = await shortTermMemory.getTurns(conversationId);
  res.json({ conversationId, turns });
});

function sendSSE(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default router;
