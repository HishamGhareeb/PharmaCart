import { getWebRuntime } from '../../../../lib/runtime.ts';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return getWebRuntime().router.readSession(request);
}
