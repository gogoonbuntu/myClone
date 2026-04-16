import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { vectorStore } from '../rag/pipeline';
import { semanticChunk, chunkMarkdown, chunkConversation } from '../rag/chunker';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: './uploads/',
    filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_, file, cb) => {
    const allowed = ['.txt', '.md', '.json', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ── Shared: content → chunks → vector store ──────────────────────────────────

async function ingestContent(
  content: string,
  source: string,
  sourceType: string,
  ext = '.txt'
): Promise<{ chunks: number; charCount: number; preview: string }> {
  await vectorStore.init();

  const metadata = {
    source,
    sourceType,
    timestamp: new Date().toISOString(),
  };

  let chunks;
  if (ext === '.md' || content.includes('# ') || content.includes('## ')) {
    chunks = chunkMarkdown(content, metadata);
  } else if (sourceType === 'chat' || sourceType === 'conversation') {
    chunks = chunkConversation(content, metadata);
  } else {
    chunks = semanticChunk(content, metadata);
  }

  await vectorStore.addChunks(chunks);

  return {
    chunks: chunks.length,
    charCount: content.length,
    preview: content.slice(0, 200).replace(/\n/g, ' ') + (content.length > 200 ? '...' : ''),
  };
}

// ── Strip HTML tags from webpage content ──────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

// ── POST /api/ingest — File upload ────────────────────────────────────────────

router.post('/ingest', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const { sourceType = 'note', source } = req.body;
  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const ext = path.extname(fileName).toLowerCase();

  try {
    let content = '';
    if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      content = data.text;
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }

    fs.unlinkSync(filePath);

    const result = await ingestContent(content, source || fileName, sourceType, ext);

    res.json({
      success: true,
      method: 'file',
      fileName,
      ...result,
      analysis: buildAnalysisSteps(content, result.chunks),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Ingest failed' });
  }
});

// ── POST /api/ingest/url — URL ingestion ──────────────────────────────────────

router.post('/ingest/url', async (req: Request, res: Response) => {
  const { url, sourceType = 'web', source } = req.body;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Only http/https URLs are supported');
    }
  } catch {
    res.status(400).json({ error: '유효하지 않은 URL입니다' });
    return;
  }

  try {
    // Fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PKA-Bot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      res.status(400).json({ error: `URL 접근 실패: HTTP ${response.status}` });
      return;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const rawText = await response.text();

    // Parse HTML or plain text
    const content = contentType.includes('text/html')
      ? stripHtml(rawText)
      : rawText;

    if (content.length < 50) {
      res.status(400).json({ error: '내용이 너무 짧습니다 (50자 미만). 로그인이 필요한 페이지는 지원되지 않습니다.' });
      return;
    }

    const sourceName = source || parsedUrl.hostname + parsedUrl.pathname;
    const result = await ingestContent(content, sourceName, sourceType, '.txt');

    res.json({
      success: true,
      method: 'url',
      url,
      domain: parsedUrl.hostname,
      ...result,
      analysis: buildAnalysisSteps(content, result.chunks),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'URL fetch failed';
    if (msg.includes('abort') || msg.includes('timeout')) {
      res.status(408).json({ error: 'URL 요청 시간 초과 (15초). 접근이 차단된 사이트일 수 있습니다.' });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ── POST /api/ingest/text — Paste/direct text ─────────────────────────────────

router.post('/ingest/text', async (req: Request, res: Response) => {
  const { text, source = '직접 입력', sourceType = 'note' } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 20) {
    res.status(400).json({ error: '텍스트가 너무 짧습니다 (최소 20자)' });
    return;
  }

  try {
    const result = await ingestContent(text.trim(), source, sourceType, '.txt');
    res.json({
      success: true,
      method: 'text',
      ...result,
      analysis: buildAnalysisSteps(text, result.chunks),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Text ingest failed' });
  }
});

// ── GET /api/ingest/stats ─────────────────────────────────────────────────────

router.get('/ingest/stats', async (_req: Request, res: Response) => {
  await vectorStore.init();
  const stats = await vectorStore.getStats();
  res.json(stats);
});

// ── GET /api/knowledge — List all stored sources with chunks ──────────────────

router.get('/knowledge', async (_req: Request, res: Response) => {
  await vectorStore.init();
  const vectors = vectorStore.getAllVectors();

  // Group by source
  const sourceMap = new Map<string, {
    source: string;
    sourceType: string;
    timestamp: string;
    chunks: Array<{ id: string; content: string; tokenCount?: number; chunkIndex?: number }>;
  }>();

  for (const v of vectors) {
    const src = (v.metadata.source as string) || 'unknown';
    if (!sourceMap.has(src)) {
      sourceMap.set(src, {
        source: src,
        sourceType: (v.metadata.sourceType as string) || 'note',
        timestamp: (v.metadata.timestamp as string) || '',
        chunks: [],
      });
    }
    sourceMap.get(src)!.chunks.push({
      id: v.id,
      content: v.content,
      tokenCount: v.metadata.tokenCount as number | undefined,
      chunkIndex: v.metadata.chunkIndex as number | undefined,
    });
  }

  const sources = Array.from(sourceMap.values()).sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp)
  );

  res.json({
    totalVectors: vectors.length,
    totalSources: sources.length,
    sources,
  });
});

// ── DELETE /api/knowledge/:source — Delete all chunks for a source ────────────

router.delete('/knowledge/:source', async (req: Request, res: Response) => {
  const source = decodeURIComponent(String(req.params.source));
  await vectorStore.init();
  const before = await vectorStore.getStats();
  await vectorStore.deleteBySource(source);
  const after = await vectorStore.getStats();
  res.json({
    success: true,
    source,
    deleted: before.count - after.count,
    remaining: after.count,
  });
});

// ── Analysis steps builder ────────────────────────────────────────────────────

function buildAnalysisSteps(content: string, chunkCount: number) {
  const charCount = content.length;
  const tokenEst = Math.ceil(charCount / 4);

  return [
    { step: 1, label: '내용 읽기', detail: `${charCount.toLocaleString()}자 / 약 ${tokenEst.toLocaleString()} 토큰 감지` },
    { step: 2, label: '의미 단위 청킹', detail: `${chunkCount}개 청크로 분할 (단순 토큰 분할이 아닌 의미 단위 기준)` },
    { step: 3, label: 'AI 임베딩 생성', detail: `Google text-embedding-004로 각 청크를 768차원 벡터로 변환` },
    { step: 4, label: '벡터 DB 저장', detail: `ChromaDB에 ${chunkCount}개 벡터 저장 완료 — 질문 시 코사인 유사도로 검색` },
  ];
}

// ── Ensure uploads dir ────────────────────────────────────────────────────────

if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads', { recursive: true });
}

export default router;
