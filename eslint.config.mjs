import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '**/generated/**', 'coverage/**', 'tmp/**'] },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['packages/**/*.ts', 'packages/**/*.mjs', 'apps/**/*.ts', 'eslint.config.mjs'] })),
);
