import express from 'express';
import cors from 'cors';
import { config } from './config';
import chatRouter from './api/chat';
import ingestRouter from './api/ingest';

const app = express();

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    persona: config.persona.mode,
    llm: config.llm.model,
    timestamp: new Date().toISOString(),
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api', chatRouter);
app.use('/api', ingestRouter);

// ─── Memory routes ───────────────────────────────────────────────────────────
app.get('/api/memory/stats', async (_req, res) => {
  const { vectorStore } = await import('./rag/pipeline');
  await vectorStore.init();
  const stats = await vectorStore.getStats();
  res.json(stats);
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   PKA Backend Server                     ║
║   http://localhost:${config.port}                 ║
║   LLM: ${config.llm.model.padEnd(32)}║
║   Persona: ${config.persona.mode.padEnd(29)}║
╚══════════════════════════════════════════╝
  `);
});

export default app;
