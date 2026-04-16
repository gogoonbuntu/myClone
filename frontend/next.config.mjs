import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Point to monorepo root to avoid lockfile conflict warnings
  outputFileTracingRoot: path.join(__dirname, '..'),
  // Allow images from any domain for user avatars
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
};

export default nextConfig;
