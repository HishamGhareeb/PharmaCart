import tseslint from 'typescript-eslint';

// Nested lint for the web app only. The root ESLint run must ignore apps/web (see docs/testing/local-web-loop.md).
export default tseslint.config(
  { ignores: ['node_modules/**', '.next/**', 'next-env.d.ts'] },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx', '*.ts', 'eslint.config.mjs'],
  })),
);
