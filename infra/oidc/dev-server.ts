import { createLocalOidcProvider } from './provider.ts';

const provider = await createLocalOidcProvider();
const server = provider.listen(55433, '127.0.0.1', () => {
  process.stdout.write('Synthetic OIDC: http://127.0.0.1:55433\n');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
