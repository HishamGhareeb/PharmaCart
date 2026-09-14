import { getWebRuntime } from '../../../../../../lib/runtime.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return getWebRuntime().router.approveQuote(request, id);
}
