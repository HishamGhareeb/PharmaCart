import { buildApp } from './app.ts';

const app = buildApp();
await app.listen({ host: '127.0.0.1', port: 3000 });
process.stdout.write('PharmaCart API: http://127.0.0.1:3000\n');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
