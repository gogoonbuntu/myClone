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

// POST /api/ingest — Upload & ingest file
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
    await vectorStore.init();

    let content = '';
    if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      content = data.text;
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }

    const metadata = {
      source: source || fileName,
      sourceType,
      timestamp: new Date().toISOString(),
    };

    let chunks;
    if (ext === '.md') {
      chunks = chunkMarkdown(content, metadata);
    } else if (sourceType === 'chat' || sourceType === 'conversation') {
      chunks = chunkConversation(content, metadata);
    } else {
      chunks = semanticChunk(content, metadata);
    }

    await vectorStore.addChunks(chunks);

    // Cleanup upload
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      fileName,
      chunks: chunks.length,
      message: `${chunks.length}개의 청크가 성공적으로 인덱싱되었습니다.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ingest failed';
    res.status(500).json({ error: message });
  }
});

// GET /api/ingest/stats
router.get('/ingest/stats', async (_req: Request, res: Response) => {
  await vectorStore.init();
  const stats = await vectorStore.getStats();
  res.json(stats);
});

// Ensure uploads dir exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads', { recursive: true });
}

export default router;
