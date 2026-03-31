#!/usr/bin/env tsx
/**
 * PKA Knowledge Ingestion CLI
 * 사용법: npm run ingest -- --source ./data/notes --type note
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

import { vectorStore } from '../rag/pipeline';
import { semanticChunk, chunkMarkdown, chunkConversation } from './chunker';

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
};

const sourcePath = getArg('--source') || getArg('-s');
const sourceType = getArg('--type') || getArg('-t') || 'note';
const verbose = args.includes('--verbose') || args.includes('-v');

async function ingestFile(filePath: string, type: string): Promise<number> {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath, ext);

  let content = '';
  if (ext === '.pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    content = data.text;
  } else if (['.txt', '.md', '.json'].includes(ext)) {
    content = fs.readFileSync(filePath, 'utf-8');
    if (ext === '.json') {
      try {
        const parsed = JSON.parse(content);
        content = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
      } catch {}
    }
  } else {
    console.warn(`⏭️  Skipping unsupported file: ${filePath}`);
    return 0;
  }

  const metadata = {
    source: fileName,
    sourceType: type,
    filePath,
    timestamp: new Date().toISOString(),
  };

  let chunks;
  if (ext === '.md') {
    chunks = chunkMarkdown(content, metadata);
  } else if (type === 'chat' || type === 'conversation') {
    chunks = chunkConversation(content, metadata);
  } else {
    chunks = semanticChunk(content, metadata);
  }

  await vectorStore.addChunks(chunks);

  if (verbose) {
    console.log(`  ✅ ${fileName}${ext} → ${chunks.length} chunks`);
  }

  return chunks.length;
}

async function ingestDirectory(dirPath: string, type: string): Promise<void> {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  let totalChunks = 0;
  let totalFiles = 0;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await ingestDirectory(fullPath, type);
    } else if (entry.isFile()) {
      const count = await ingestFile(fullPath, type);
      if (count > 0) {
        totalFiles++;
        totalChunks += count;
      }
    }
  }

  console.log(`📁 ${dirPath}: ${totalFiles} files, ${totalChunks} chunks`);
}

async function main() {
  if (!sourcePath) {
    console.error(`
Usage: npm run ingest -- --source <path> [--type <type>] [--verbose]

Types: chat | project | resume | note | code
Examples:
  npm run ingest -- --source ./data/chats --type chat
  npm run ingest -- --source ./data/resume.pdf --type resume
  npm run ingest -- --source ./data/notes --type note -v
    `);
    process.exit(1);
  }

  console.log(`\n🧠 PKA Knowledge Ingestion`);
  console.log(`📂 Source: ${sourcePath}`);
  console.log(`📑 Type: ${sourceType}\n`);

  await vectorStore.init();

  const fullPath = path.resolve(sourcePath);

  if (!fs.existsSync(fullPath)) {
    console.error(`❌ Path not found: ${fullPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(fullPath);

  if (stat.isDirectory()) {
    await ingestDirectory(fullPath, sourceType);
  } else {
    const count = await ingestFile(fullPath, sourceType);
    console.log(`✅ ${path.basename(fullPath)} → ${count} chunks`);
  }

  const stats = await vectorStore.getStats();
  console.log(`\n📊 Total vectors in knowledge base: ${stats.count}`);
  console.log('✅ Ingestion complete!\n');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
