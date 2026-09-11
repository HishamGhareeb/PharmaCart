# Local development version matrix

Verified and pinned on 2026-09-11. This is a tested development baseline, not a production support claim.

| Component | Version | Pin / evidence |
| --- | --- | --- |
| Node.js | 24.19.0 | .node-version and package.json engines; local command |
| npm | 11.17.0 | package.json packageManager; local command |
| PostgreSQL | 17.10 | infra/compose.yaml image digest; local SQL version query |
| Docker Engine | 29.7.2 | local engine observation |
| TypeScript | 5.9.3 | exact devDependency and lockfile |
| Node type definitions | 24.10.1 | exact devDependency and lockfile |
| Ajv | 8.20.0 | exact devDependency; patched version selected after npm audit |
| ESLint | 10.10.0 | exact devDependency; registry-supported replacement for deprecated initial version |
| typescript-eslint | 8.70.0 | exact devDependency; registry peer range accepts ESLint 10 and TypeScript 5.9 |

Node runs erasable TypeScript directly. `tsc --noEmit` supplies independent static validation. The compiler settings follow [TypeScript's erasable syntax documentation](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html).

Additional exact pins verified from npm on 2026-09-12: Fastify 5.12.4, jose 6.2.12, oidc-provider 9.12.2, pg 8.23.0, @types/pg 8.23.1 and @types/oidc-provider 9.12.1. Install audit reports zero vulnerabilities. API and OIDC behavior were verified against installed source/types and official [Fastify server documentation](https://fastify.dev/docs/latest/Reference/Server/) and [oidc-provider](https://github.com/panva/node-oidc-provider).

pg-boss, client frameworks and .NET SDK remain pending their implementation stages. No unpinned database images are used.
