import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: '나의 AI — 내 경험과 지식을 아는 AI',
  description: '내 프로젝트, 경험, 메모를 학습하고 마치 내가 직접 답하듯 추론하는 개인 AI 에이전트. RAG + Groq + Gemini 기반.',
  keywords: ['AI', '개인 AI', 'RAG', 'Personal Assistant', 'LLM', 'Groq', 'Gemini'],
  authors: [{ name: '나의 AI' }],
  openGraph: {
    title: '나의 AI — 내 경험과 지식을 아는 AI',
    description: '내 경험 기반으로 추론하는 개인 AI 에이전트',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" className={inter.variable}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
