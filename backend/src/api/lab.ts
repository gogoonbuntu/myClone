import { Router, Request, Response } from 'express';
import { llmClient, type Message, type StreamCallback } from '../llm/client';
import { retrieveContext, keywordSearch, formatContext } from '../rag/pipeline';
import { shortTermMemory } from '../memory/shortTerm';
import { longTermMemory } from '../memory/longTerm';

const router = Router();

// ─── Experiment 1: Keyword vs Vector vs Hybrid Search ────────────────────────

router.post('/lab/search', async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const l1Start = Date.now();
    const l1Results = await keywordSearch(query, 5);
    const l1Time = Date.now() - l1Start;

    const l2Start = Date.now();
    const l2Results = await retrieveContext(query, 5);
    const l2Time = Date.now() - l2Start;

    // L3: Hybrid (RRF)
    const l3Start = Date.now();
    const keyR = await keywordSearch(query, 10);
    const vecR = await retrieveContext(query, 10);
    const K = 60;
    const scoreMap = new Map<string, { content: string; score: number; source: string }>();
    keyR.forEach((r, i) => {
      const rrf = 1 / (K + i + 1);
      const ex = scoreMap.get(r.id);
      scoreMap.set(r.id, { content: r.content, score: (ex?.score || 0) + rrf, source: r.metadata.source });
    });
    vecR.forEach((r, i) => {
      const rrf = 1 / (K + i + 1);
      const ex = scoreMap.get(r.id);
      scoreMap.set(r.id, { content: ex?.content || r.content, score: (ex?.score || 0) + rrf, source: ex?.source || r.metadata.source });
    });
    const hybridResults = [...scoreMap.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    const l3Time = Date.now() - l3Start;

    const fmt = (r: { content: string; score: number; source: string }) => ({
      content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      score: Math.round(r.score * 100),
      source: r.source,
    });

    res.json({
      query,
      l1: { label: 'L1: 키워드 매칭', method: 'string.includes()', results: l1Results.map(r => fmt({ content: r.content, score: r.score, source: r.metadata.source })), count: l1Results.length, latency: l1Time },
      l2: { label: 'L2: 벡터 유사도', method: 'embedding + cosine similarity', results: l2Results.map(r => fmt({ content: r.content, score: r.score, source: r.metadata.source })), count: l2Results.length, latency: l2Time },
      l3: { label: 'L3: 하이브리드', method: 'Reciprocal Rank Fusion', results: hybridResults.map(fmt), count: hybridResults.length, latency: l3Time },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
  }
});

// ─── Experiment 2: Stateless vs Memory ───────────────────────────────────────

router.post('/lab/memory', async (req: Request, res: Response) => {
  const { query, conversationId = 'lab-memory-test' } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  try {
    const context = formatContext(await retrieveContext(query));
    const systemPrompt = llmClient.buildSystemPrompt(context || undefined);

    send('status', { level: 'l1', message: 'L1 생성 중 (히스토리 없음)...' });
    let l1Text = '';
    const l1Start = Date.now();
    const l1cb: StreamCallback = (chunk) => { if (chunk.type === 'text' && chunk.content) { l1Text += chunk.content; send('text', { level: 'l1', content: chunk.content }); } };
    await llmClient.streamResponse([{ role: 'user', content: query }], systemPrompt, [], l1cb);
    send('done', { level: 'l1', latency: Date.now() - l1Start });

    send('status', { level: 'l2', message: 'L2 생성 중 (대화 히스토리 포함)...' });
    const history = await shortTermMemory.getTurns(conversationId);
    const messages: Message[] = [...history.map(h => ({ role: h.role, content: h.content })), { role: 'user' as const, content: query }];
    let l2Text = '';
    const l2Start = Date.now();
    const l2cb: StreamCallback = (chunk) => { if (chunk.type === 'text' && chunk.content) { l2Text += chunk.content; send('text', { level: 'l2', content: chunk.content }); } };
    await llmClient.streamResponse(messages, systemPrompt, [], l2cb);
    send('done', { level: 'l2', latency: Date.now() - l2Start });

    await shortTermMemory.addTurn(conversationId, { role: 'user', content: query, timestamp: new Date().toISOString() });
    await shortTermMemory.addTurn(conversationId, { role: 'assistant', content: l2Text, timestamp: new Date().toISOString() });
    send('history', { turnCount: history.length + 2 });
    send('end', {});
  } catch (err) { send('error', { message: err instanceof Error ? err.message : 'Failed' }); }
  res.end();
});

// ─── Experiment 3: No Long-term vs Long-term Memory ──────────────────────────

router.post('/lab/longterm', async (req: Request, res: Response) => {
  const { query, conversationId = 'lab-longterm-test' } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  try {
    const ragContext = formatContext(await retrieveContext(query));

    send('status', { level: 'l1', message: 'L1 생성 중 (RAG만 사용)...' });
    let l1Text = '';
    const l1Start = Date.now();
    const l1cb: StreamCallback = (chunk) => { if (chunk.type === 'text' && chunk.content) { l1Text += chunk.content; send('text', { level: 'l1', content: chunk.content }); } };
    await llmClient.streamResponse([{ role: 'user', content: query }], llmClient.buildSystemPrompt(ragContext || undefined), [], l1cb);
    send('done', { level: 'l1', latency: Date.now() - l1Start });

    send('status', { level: 'l2', message: 'L2 생성 중 (RAG + 장기 기억)...' });
    const pastMemories = await longTermMemory.recall(query);
    let fullContext = ragContext || '';
    if (pastMemories.length > 0) {
      fullContext += '\n\n## 과거 대화에서 관련된 기억\n' + pastMemories.join('\n\n');
      send('memories', { count: pastMemories.length, previews: pastMemories.map(m => m.slice(0, 100)) });
    }
    let l2Text = '';
    const l2Start = Date.now();
    const l2cb: StreamCallback = (chunk) => { if (chunk.type === 'text' && chunk.content) { l2Text += chunk.content; send('text', { level: 'l2', content: chunk.content }); } };
    await llmClient.streamResponse([{ role: 'user', content: query }], llmClient.buildSystemPrompt(fullContext || undefined), [], l2cb);
    send('done', { level: 'l2', latency: Date.now() - l2Start });

    await longTermMemory.storeConversation(conversationId + '-' + Date.now(), [{ role: 'user', content: query }, { role: 'assistant', content: l2Text }]);
    send('end', {});
  } catch (err) { send('error', { message: err instanceof Error ? err.message : 'Failed' }); }
  res.end();
});

// ─── Experiment 4: No Reflection vs Reflection ───────────────────────────────

router.post('/lab/reflection', async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  try {
    const context = formatContext(await retrieveContext(query));
    const systemPrompt = llmClient.buildSystemPrompt(context || undefined);

    send('status', { level: 'l1', message: 'L1 생성 중 (Reflection 없음)...' });
    let l1Text = '';
    const l1Start = Date.now();
    const l1cb: StreamCallback = (chunk) => { if (chunk.type === 'text' && chunk.content) { l1Text += chunk.content; send('text', { level: 'l1', content: chunk.content }); } };
    await llmClient.streamResponse([{ role: 'user', content: query }], systemPrompt, [], l1cb);
    send('done', { level: 'l1', latency: Date.now() - l1Start });

    send('status', { level: 'l2', message: 'L2 생성 중 (1차 답변)...' });
    let l2Draft = '';
    const l2Start = Date.now();
    const l2cb: StreamCallback = (chunk) => { if (chunk.type === 'text' && chunk.content) { l2Draft += chunk.content; send('text', { level: 'l2', content: chunk.content }); } };
    await llmClient.streamResponse([{ role: 'user', content: query }], systemPrompt, [], l2cb);

    send('status', { level: 'l2', message: '자기 비판 중...' });
    const reflection = await llmClient.reflectAndImprove(l2Draft, query, context);
    if (reflection.improved && reflection.answer) {
      send('reflection', { level: 'l2', critique: reflection.critique, improved: true });
      send('improved', { level: 'l2', content: reflection.answer });
    } else {
      send('reflection', { level: 'l2', critique: reflection.critique || '개선 불필요', improved: false });
    }
    send('done', { level: 'l2', latency: Date.now() - l2Start });
    send('end', {});
  } catch (err) { send('error', { message: err instanceof Error ? err.message : 'Failed' }); }
  res.end();
});

// ─── Experiment 5: LLM 비교 (Groq vs Gemini) ────────────────────────────────

router.post('/lab/llm', async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  try {
    const context = formatContext(await retrieveContext(query));
    const systemPrompt = llmClient.buildSystemPrompt(context || undefined);

    send('status', { level: 'l1', message: 'Groq (Llama 3.3 70B) 생성 중...' });
    let groqText = '';
    const groqStart = Date.now();
    const groqCb: StreamCallback = (chunk) => { if (chunk.type === 'text' && chunk.content) { groqText += chunk.content; send('text', { level: 'l1', content: chunk.content }); } };
    await llmClient.streamWithProvider('groq', [{ role: 'user', content: query }], systemPrompt, groqCb);
    send('done', { level: 'l1', latency: Date.now() - groqStart, provider: 'groq' });

    send('status', { level: 'l2', message: 'Gemini (2.0 Flash) 생성 중...' });
    let geminiText = '';
    const geminiStart = Date.now();
    const geminiCb: StreamCallback = (chunk) => { if (chunk.type === 'text' && chunk.content) { geminiText += chunk.content; send('text', { level: 'l2', content: chunk.content }); } };
    await llmClient.streamWithProvider('google', [{ role: 'user', content: query }], systemPrompt, geminiCb);
    send('done', { level: 'l2', latency: Date.now() - geminiStart, provider: 'google' });

    send('end', {});
  } catch (err) { send('error', { message: err instanceof Error ? err.message : 'Failed' }); }
  res.end();
});

// ─── Lab Stats ───────────────────────────────────────────────────────────────

router.get('/lab/stats', async (_req: Request, res: Response) => {
  const ltStats = await longTermMemory.getStats();
  res.json({ longTermMemories: ltStats.count });
});

export default router;
