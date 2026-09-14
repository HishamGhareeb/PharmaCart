import type { NextConfig } from 'next';

// Local synthetic development server only. There is no deployment or production configuration here:
// the session store and BFF runtime refuse to start when NODE_ENV is production (see src/lib/runtime.ts).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root to this directory. Without it Turbopack walks up to the repository root
  // lockfile and treats the whole monorepo as the app's root.
  turbopack: { root: __dirname },
  // Every response is same-origin only; the browser never receives tokens or database credentials.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
