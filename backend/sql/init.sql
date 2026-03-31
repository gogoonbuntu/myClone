-- PKA PostgreSQL Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Knowledge sources metadata
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'chat', 'project', 'resume', 'note', 'code'
  file_path TEXT,
  url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Chunks (embedding references)
CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  chroma_id TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  category TEXT,
  token_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  chunks_used UUID[],
  tools_used JSONB DEFAULT '[]',
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects metadata
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  tech_stack TEXT[],
  github_url TEXT,
  status TEXT DEFAULT 'active',
  start_date DATE,
  end_date DATE,
  complexity_score INTEGER CHECK (complexity_score BETWEEN 1 AND 10),
  lessons_learned TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- Sample project data
INSERT INTO projects (name, description, tech_stack, status, complexity_score, lessons_learned) VALUES
('Personal Knowledge AI Agent', 'AI agent that answers questions based on personal knowledge and experience', ARRAY['TypeScript', 'Next.js', 'ChromaDB', 'Redis', 'Claude API'], 'active', 9, 'RAG pipeline design and persona-based prompting are crucial for quality'),
('E-Commerce Platform', 'Full-stack e-commerce with real-time inventory', ARRAY['React', 'Node.js', 'PostgreSQL', 'Redis', 'Stripe'], 'completed', 7, 'Caching strategy had major impact on performance'),
('ML Pipeline', 'Automated ML training and deployment pipeline', ARRAY['Python', 'FastAPI', 'Docker', 'Kubernetes', 'MLflow'], 'completed', 8, 'Model versioning and reproducibility are non-negotiable')
ON CONFLICT DO NOTHING;
