import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { PurchaseFlow } from '../../components/purchase-flow.tsx';
import { SESSION_COOKIE } from '../../lib/config.ts';
import { getWebRuntime } from '../../lib/runtime.ts';
import { toSessionView } from '../../lib/session.ts';

export const dynamic = 'force-dynamic';

export default async function PurchasePage() {
  const runtime = getWebRuntime();
  const store = await cookies();
  const session = runtime.sessions.get(store.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/');

  // Only the browser-facing view crosses to the client component; the access token never does.
  return <PurchaseFlow session={toSessionView(session)} />;
}
