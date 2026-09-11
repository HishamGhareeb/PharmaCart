import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '**/generated/**', 'coverage/**', 'tmp/**', 'dist/**'] },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['packages/**/*.ts', 'packages/**/*.mjs', 'apps/**/*.ts', 'infra/**/*.ts', 'scripts/**/*.mjs', 'eslint.config.mjs'] })),
);
