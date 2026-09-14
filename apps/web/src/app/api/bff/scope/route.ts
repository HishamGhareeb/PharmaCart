import { getWebRuntime } from '../../../../lib/runtime.ts';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return getWebRuntime().router.selectScope(request);
}
