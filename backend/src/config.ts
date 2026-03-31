import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',

  llm: {
    provider: 'google' as const,
    model: process.env.LLM_MODEL || 'gemini-2.0-flash',
    googleApiKey: process.env.GOOGLE_API_KEY || '',
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-004',
  },

  chroma: {
    host: process.env.CHROMA_HOST || 'localhost',
    port: parseInt(process.env.CHROMA_PORT || '8000'),
    authToken: process.env.CHROMA_AUTH_TOKEN || 'pka-secret-token',
    collection: process.env.CHROMA_COLLECTION || 'pka_knowledge',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || 'pka-redis-pass',
  },

  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'pka_db',
    user: process.env.POSTGRES_USER || 'pka_user',
    password: process.env.POSTGRES_PASSWORD || 'pka-pg-pass',
  },

  github: {
    token: process.env.GITHUB_TOKEN || '',
    username: process.env.GITHUB_USERNAME || '',
  },

  persona: {
    mode: (process.env.PERSONA_MODE || 'ENFP') as 'ENFP' | 'INTP',
    userName: process.env.USER_NAME || '사용자',
  },

  rag: {
    topK: 5,
    chunkSize: 512,
    chunkOverlap: 64,
    minChunkSize: 100,
  },

  memory: {
    shortTermTtl: 3600,        // 1 hour Redis TTL
    maxConversationTurns: 20,
    compressionThreshold: 10,
  },
} as const;

export type Config = typeof config;
