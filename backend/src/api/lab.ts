import { Router, Request, Response } from 'express';
import { llmClient, type Message } from '../llm/client';
import { retrieveContext, keywordSearch, formatContext } from '../rag/pipeline';
import { shortTermMemory } from '../memory/shortTerm';
import { longTermMemory } from '../memory/longTerm';

const router = Router();

// ─── Experiment 1: Vector Search vs Keyword Search ───────────────────────────

router.post('/lab/search', async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    // L1: Keyword search
    const l1Start = Date.now();
    const l1Results = await keywordSearch(query, 5);
    const l1Time = Date.now() - l1Start;

    // L2: Vector (embedding) search
    const l2Start = Date.now();
    const l2Results = await retrieveContext(query, 5);
    const l2Time = Date.now() - l2Start;

    res.json({
      query,
      l1: {
        label: 'L1: 키워드 매칭',
        method: 'string.includes() — 단어가 포함되면 매칭',
        results: l1Results.map(r => ({
          content: r.content.slice(0, 200) + '...',
          score: Math.round(r.score * 100),
          source: r.metadata.source,
        })),
        count: l1Results.length,
        latency: l1Time,
      },
      l2: {
        label: 'L2: 벡터 유사도',
        method: 'embedding → cosine similarity — 의미가 비슷하면 매칭',
        results: l2Results.map(r => ({
          content: r.content.slice(0, 200) + '...',
          score: Math.round(r.score * 100),
          source: r.metadata.source,
        })),
        count: l2Results.length,
        latency: l2Time,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
  }
});

// ─── Experiment 2: Stateless vs Memory ───────────────────────────────────────

router.post('/lab/memory', async (req: Request, res: Response) => {
  const { query, conversationId = 'lab-memory-test' } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const context = formatContext(await retrieveContext(query));
    const systemPrompt = llmClient.buildSystemPrompt(context || undefined);

    // ── L1: Stateless (no history)
    send('status', { level: 'l1', message: 'L1 생성 중 (히스토리 없음)...' });
    let l1Text = '';
    const l1Start = Date.now();
    await llmClient.streamResponse(
      [{ role: 'user', content: query }],
      systemPrompt,
      [],
      (chunk) => {
        if (chunk.type === 'text' && chunk.content) {
          l1Text += chunk.content;
          send('text', { level: 'l1', content: chunk.content });
        }
      }
    );
    send('done', { level: 'l1', latency: Date.now() - l1Start });

    // ── L2: With conversation history
    send('status', { level: 'l2', message: 'L2 생성 중 (대화 히스토리 포함)...' });
    const history = await shortTermMemory.getTurns(conversationId);
    const messages: Message[] = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user' as const, content: query },
    ];

    let l2Text = '';
    const l2Start = Date.now();
    await llmClient.streamResponse(
      messages,
      systemPrompt,
      [],
      (chunk) => {
        if (chunk.type === 'text' && chunk.content) {
          l2Text += chunk.content;
          send('text', { level: 'l2', content: chunk.content });
        }
      }
    );
    send('done', { level: 'l2', latency: Date.now() - l2Start });

    // Save this turn for future L2 context
    await shortTermMemory.addTurn(conversationId, {
      role: 'user', content: query, timestamp: new Date().toISOString(),
    });
    await shortTermMemory.addTurn(conversationId, {
      role: 'assistant', content: l2Text, timestamp: new Date().toISOString(),
    });

    send('history', { turnCount: history.length + 2 });
    send('end', {});
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : 'Memory test failed' });
  }

  res.end();
});

// ─── Experiment 3: No Long-term vs Long-term Memory ──────────────────────────

router.post('/lab/longterm', async (req: Request, res: Response) => {
  const { query, conversationId = 'lab-longterm-test' } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const ragContext = formatContext(await retrieveContext(query));

    // ── L1: RAG only (no long-term memory)
    send('status', { level: 'l1', message: 'L1 생성 중 (RAG만 사용)...' });
    const l1System = llmClient.buildSystemPrompt(ragContext || undefined);
    let l1Text = '';
    const l1Start = Date.now();
    await llmClient.streamResponse(
      [{ role: 'user', content: query }],
      l1System,
      [],
      (chunk) => {
        if (chunk.type === 'text' && chunk.content) {
          l1Text += chunk.content;
          send('text', { level: 'l1', content: chunk.content });
        }
      }
    );
    send('done', { level: 'l1', latency: Date.now() - l1Start });

    // ── L2: RAG + Long-term memory recall
    send('status', { level: 'l2', message: 'L2 생성 중 (RAG + 장기 기억)...' });
    const pastMemories = await longTermMemory.recall(query);

    let fullContext = ragContext || '';
    if (pastMemories.length > 0) {
      fullContext += '\n\n## 과거 대화에서 관련된 기억\n' + pastMemories.join('\n\n');
      send('memories', { count: pastMemories.length, previews: pastMemories.map(m => m.slice(0, 100)) });
    }

    const l2System = llmClient.buildSystemPrompt(fullContext || undefined);
    let l2Text = '';
    const l2Start = Date.now();
    await llmClient.streamResponse(
      [{ role: 'user', content: query }],
      l2System,
      [],
      (chunk) => {
        if (chunk.type === 'text' && chunk.content) {
          l2Text += chunk.content;
          send('text', { level: 'l2', content: chunk.content });
        }
      }
    );
    send('done', { level: 'l2', latency: Date.now() - l2Start });

    // Save this conversation to long-term memory for future
    await longTermMemory.storeConversation(conversationId + '-' + Date.now(), [
      { role: 'user', content: query },
      { role: 'assistant', content: l2Text },
    ]);

    send('end', {});
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : 'Longterm test failed' });
  }

  res.end();
});

// ─── Experiment 4: No Reflection vs Reflection ───────────────────────────────

router.post('/lab/reflection', async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const context = formatContext(await retrieveContext(query));
    const systemPrompt = llmClient.buildSystemPrompt(context || undefined);

    // ── L1: Direct response (no reflection)
    send('status', { level: 'l1', message: 'L1 생성 중 (Reflection 없음)...' });
    let l1Text = '';
    const l1Start = Date.now();
    await llmClient.streamResponse(
      [{ role: 'user', content: query }],
      systemPrompt,
      [],
      (chunk) => {
        if (chunk.type === 'text' && chunk.content) {
          l1Text += chunk.content;
          send('text', { level: 'l1', content: chunk.content });
        }
      }
    );
    send('done', { level: 'l1', latency: Date.now() - l1Start });

    // ── L2: Response + Reflection + Improvement
    send('status', { level: 'l2', message: 'L2 생성 중 (1차 답변)...' });
    let l2Draft = '';
    const l2Start = Date.now();
    await llmClient.streamResponse(
      [{ role: 'user', content: query }],
      systemPrompt,
      [],
      (chunk) => {
        if (chunk.type === 'text' && chunk.content) {
          l2Draft += chunk.content;
          send('text', { level: 'l2', content: chunk.content });
        }
      }
    );

    // Reflection step
    send('status', { level: 'l2', message: '자기 비판 중...' });
    const reflection = await llmClient.reflectAndImprove(l2Draft, query, context);

    if (reflection.improved && reflection.answer) {
      send('reflection', {
        level: 'l2',
        critique: reflection.critique,
        improved: true,
      });
      // Clear and send improved answer
      send('improved', { level: 'l2', content: reflection.answer });
    } else {
      send('reflection', {
        level: 'l2',
        critique: reflection.critique || '개선 불필요 — 초안이 충분히 좋습니다.',
        improved: false,
      });
    }

    send('done', { level: 'l2', latency: Date.now() - l2Start });
    send('end', {});
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : 'Reflection test failed' });
  }

  res.end();
});

// ─── Lab Stats ───────────────────────────────────────────────────────────────

router.get('/lab/stats', async (_req: Request, res: Response) => {
  const ltStats = await longTermMemory.getStats();
  res.json({ longTermMemories: ltStats.count });
});

export default router;
