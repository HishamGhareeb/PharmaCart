import { defineConfig } from 'vitest/config';

// `next build` rewrites tsconfig's `jsx` setting, so the test transform pins the automatic runtime
// here instead of depending on it. Vite 8 transforms with oxc.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    // Component tests opt into jsdom per file; the URL matches the app's fixed local origin so that
    // relative links resolve exactly as they do in the browser.
    environmentOptions: { jsdom: { url: 'http://127.0.0.1:3001/' } },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    restoreMocks: true,
  },
});
