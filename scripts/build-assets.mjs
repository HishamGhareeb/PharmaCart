import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/packages/contracts', { recursive: true });
await cp('packages/contracts/openapi.json', 'dist/packages/contracts/openapi.json');
process.stdout.write('Compiled application and OpenAPI assets ready in dist.\n');
