import { buildTenantApi } from './tenant-api.ts';
import { createRuntimePool } from '../../../packages/db/src/runtime.ts';
import { createAccessTokenVerifier } from '../../../packages/auth/src/verify-access-token.ts';

const pool=await createRuntimePool();
const app = buildTenantApi(pool,createAccessTokenVerifier({issuer:'http://127.0.0.1:55433',audience:'pharmacart-api',jwksUri:'http://127.0.0.1:55433/jwks'}));
app.addHook('onClose',async()=>{await pool.end();});
await app.listen({ host: '127.0.0.1', port: 3000 });
process.stdout.write('PharmaCart API: http://127.0.0.1:3000\n');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
