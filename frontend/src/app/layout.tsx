import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PKA — Personal Knowledge AI Agent',
  description: '나의 경험, 사고방식, 기술 스택을 학습하고 맥락 기반으로 추론하는 개인 AI 에이전트',
  keywords: ['AI', 'Knowledge Agent', 'RAG', 'Personal Assistant', 'LLM'],
  authors: [{ name: 'PKA Team' }],
  openGraph: {
    title: 'PKA — Personal Knowledge AI Agent',
    description: '경험 기반으로 추론하는 개인 AI 에이전트',
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
