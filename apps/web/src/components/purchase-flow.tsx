'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { canonicalQuantity, remainingQuantity } from '../lib/decimal.ts';
import {
  SYNTHETIC_NEED_ID,
  SYNTHETIC_SALE_UNIT,
  SYNTHETIC_SCOPES,
  SYNTHETIC_SUPPLIERS,
  scopeLabel,
} from '../lib/fixtures.ts';
import type { SessionView } from '../lib/session.ts';

/**
 * The operator-facing purchase loop.
 *
 * Everything on this page is an explicit action. No effect ever approves, re-approves or receipts on
 * mount, refresh or reconnect, and no token or scope secret is held in the browser: the only client
 * state is what the server just returned plus this session's CSRF token.
 */

type ErrorBody = { error?: { code?: string; message?: string; correlationId?: string | null } };
type CallResult = { status: number; body: unknown };

type Need = { id: string; productRef: string; quantity: string; status: string; version: number };

type QuoteLine = {
  needId: string;
  needVersion: number;
  quantity: string;
  unit: string;
  net: string;
  supplierId: string;
  offerVersion: number;
  termsVersion: number;
  identity?: { brand?: string; strength?: string; dosageForm?: string } | null;
};

type Quote = {
  id: string;
  version: number;
  status: string;
  bindingStatus: string;
  currency: string;
  total: string;
  expiresAt: string;
  pricingRuleVersion: string;
  termsHash: string;
  lines: QuoteLine[];
  unmetLines: unknown[];
};

type Approval = {
  approvalId: string;
  quoteId: string;
  quoteVersion: number;
  status: string;
  orderIntentIds: string[];
};

type OrderLine = {
  id: string;
  productIdentity?: { brand?: string } | null;
  ordered: string;
  accepted: string;
  rejected: string;
  shipped: string;
  received: string;
};

type Order = {
  id: string;
  state: string;
  externalClientRef: string;
  externalOrderId: string | null;
  version: number;
  uncertainty: { safeToRetry: boolean; nextAction: string } | null;
  lines: OrderLine[];
};

const STALE_CODES = new Set(['REQUOTE_REQUIRED', 'NEED_CHANGED', 'VERSION_CONFLICT', 'QUOTE_EXPIRED']);

async function callBff(path: string, init: RequestInit & { csrfToken?: string } = {}): Promise<CallResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.csrfToken) headers['x-pharmacart-csrf'] = init.csrfToken;
  try {
    const response = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  } catch {
    // Status 0 means this attempt produced no answer at all: the command outcome is unknown.
    return { status: 0, body: null };
  }
}

function describeFailure(result: CallResult, subject: string): string {
  if (result.status === 0) {
    return `The ${subject} could not be confirmed because the local API could not be reached. Nothing here was changed by that attempt; retry the same action when the API is back.`;
  }
  if (result.status === 401) {
    return 'This local session has expired or was ended. Please sign in again before continuing.';
  }
  const envelope = (result.body ?? {}) as ErrorBody;
  const code = envelope.error?.code;
  const message = envelope.error?.message;
  if (result.status === 403) {
    return `${message ?? 'That action is not permitted.'} This synthetic user may not have the required membership or role for the chosen scope.`;
  }
  if (code && STALE_CODES.has(code)) {
    return 'The offer or the need changed, so this quote can no longer be approved. Request a new quote and approve the new one yourself.';
  }
  return message ?? `The ${subject} failed with status ${result.status}.`;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

export function PurchaseFlow({ session: initialSession }: { session: SessionView | null }) {
  const [session, setSession] = useState<SessionView | null>(initialSession);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [scopeKey, setScopeKey] = useState(
    `${SYNTHETIC_SCOPES[0]!.organisationId}:${SYNTHETIC_SCOPES[0]!.branchId}`,
  );
  const [needIdInput, setNeedIdInput] = useState(SYNTHETIC_NEED_ID);
  const [need, setNeed] = useState<Need | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [supplierKey, setSupplierKey] = useState(SYNTHETIC_SUPPLIERS[0]!.key);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalRetry, setApprovalRetry] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [receiptQuantities, setReceiptQuantities] = useState<Record<string, string>>({});
  const [receiptReference, setReceiptReference] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const deadline = quote ? Date.parse(quote.expiresAt) : Number.NaN;
  const evaluatedAt = Math.max(Date.now(), tick);
  const quoteExpired = Number.isFinite(deadline) ? deadline <= evaluatedAt : false;

  // One timer that fires exactly when a live quote goes stale, so the approve control cannot stay
  // enabled past the expiry the API will enforce. No polling and no background commands.
  useEffect(() => {
    if (!quote || !Number.isFinite(deadline) || deadline <= Date.now()) return undefined;
    const timer = setTimeout(() => setTick(Date.now()), deadline - Date.now() + 250);
    return () => clearTimeout(timer);
  }, [quote, deadline]);

  const csrfToken = session?.csrfToken ?? '';

  function begin(action: string) {
    setBusy(action);
    setError(null);
  }

  async function submitScope(event: FormEvent) {
    event.preventDefault();
    const [organisationId, branchId] = scopeKey.split(':');
    begin('scope');
    const result = await callBff('/api/bff/scope', {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ organisationId, branchId }),
    });
    setBusy(null);
    if (result.status !== 200) {
      setError(describeFailure(result, 'scope selection'));
      return;
    }
    setSession((result.body as { session: SessionView }).session);
    setNotice('Scope confirmed against the local API.');
  }

  async function submitNeed(event: FormEvent) {
    event.preventDefault();
    begin('need');
    const result = await callBff(`/api/bff/needs/${encodeURIComponent(needIdInput.trim())}`);
    setBusy(null);
    if (result.status !== 200) {
      setNeed(null);
      setQuote(null);
      setError(describeFailure(result, 'need lookup'));
      return;
    }
    setNeed(result.body as Need);
    setQuote(null);
    setApproval(null);
    setOrder(null);
    setNotice(null);
  }

  async function submitQuote(event: FormEvent) {
    event.preventDefault();
    if (!need) return;
    // Canonical form is what the API's schema accepts; `1.50` and `2.0` are not, and are what people
    // type. Rewrite them here so the refusal the operator sees is about their number, not its shape.
    const canonical = canonicalQuantity(quantity);
    if (canonical === null || canonical === '0') {
      setError('Enter the quantity to purchase as a positive decimal number, for example 2 or 1.5.');
      return;
    }
    begin('quote');
    const result = await callBff('/api/bff/quotes', {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({
        needId: need.id,
        needVersion: need.version,
        quantity: canonical,
        supplierKey,
      }),
    });
    setBusy(null);
    if (result.status !== 201) {
      setQuote(null);
      setError(describeFailure(result, 'quote request'));
      return;
    }
    setQuote(result.body as Quote);
    setApproval(null);
    setApprovalRetry(false);
    setOrder(null);
    setNotice(null);
  }

  /** Only ever reached from a direct click on the approve control. */
  async function approve() {
    if (!quote || quoteExpired) return;
    begin('approve');
    const result = await callBff(`/api/bff/quotes/${encodeURIComponent(quote.id)}/approve`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ quoteVersion: quote.version }),
    });
    setBusy(null);
    if (result.status !== 202 && result.status !== 200) {
      setApprovalRetry(result.status === 0);
      setError(describeFailure(result, 'approval'));
      return;
    }
    setApprovalRetry(false);
    setApproval(result.body as Approval);
    setNotice('The approval was accepted. Dispatch to the synthetic supplier is handled by the backend worker.');
  }

  async function loadOrder(orderId: string) {
    begin('order');
    const result = await callBff(`/api/bff/orders/${encodeURIComponent(orderId)}`);
    setBusy(null);
    if (result.status !== 200) {
      setOrder(null);
      setError(describeFailure(result, 'order lookup'));
      return;
    }
    const loaded = result.body as Order;
    setOrder(loaded);
    setReceiptQuantities(
      Object.fromEntries(
        loaded.lines.map((line) => [line.id, remainingQuantity(line.shipped, line.received) ?? '0']),
      ),
    );
    setReceiptReference(null);
  }

  async function submitReceipt(event: FormEvent) {
    event.preventDefault();
    if (!order) return;
    const lines: { lineId: string; quantity: string }[] = [];
    for (const line of order.lines) {
      // A cleared field means nothing arrived for that line, which is a line to leave out rather
      // than an empty quantity to send. A zero is the same statement written differently.
      const typed = (receiptQuantities[line.id] ?? '').trim();
      if (typed === '') continue;
      const canonical = canonicalQuantity(typed);
      if (canonical === null) {
        setError(
          `Enter the quantity received for line ${shortId(line.id)} as a positive decimal number, or clear it.`,
        );
        return;
      }
      if (canonical !== '0') lines.push({ lineId: line.id, quantity: canonical });
    }
    if (lines.length === 0) {
      setError('Enter at least one received quantity before confirming a receipt.');
      return;
    }
    begin('receipt');
    const result = await callBff(`/api/bff/orders/${encodeURIComponent(order.id)}/receipts`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ lines }),
    });
    setBusy(null);
    if (result.status !== 200) {
      setError(describeFailure(result, 'receipt'));
      return;
    }
    setReceiptReference((result.body as { reference: string }).reference);
    setNotice('The receipt was recorded. Reload the order to see the updated received quantities.');
  }

  if (!session) {
    return (
      <main className="page">
        <h1>PharmaCart local purchase loop</h1>
        <p>
          This is a local synthetic environment. Sign in with the local development identity provider to
          continue; no real pharmacy, supplier or payment system is involved.
        </p>
        <p>
          <a className="primary-link" href="/auth/login">
            Sign in with the local identity provider
          </a>
        </p>
      </main>
    );
  }

  const scope = session.scope;

  return (
    <main className="page">
      <h1>PharmaCart local purchase loop</h1>
      <p className="lede">
        Synthetic data only. Quotes are cash, tax exempt and priced in the seeded currency, and every
        purchase step below needs an explicit action from you.
      </p>

      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {scope ? (
        <section aria-labelledby="scope-heading" className="card">
          <h2 id="scope-heading">Active scope</h2>
          <dl>
            <dt>Signed in as</dt>
            <dd>{session.subject ?? 'unknown subject'}</dd>
            <dt>Organisation and branch</dt>
            <dd>{scopeLabel(scope.organisationId, scope.branchId)}</dd>
            <dt>Role</dt>
            <dd>{scope.role}</dd>
          </dl>
        </section>
      ) : (
        <div className="card">
          <h2>Choose a synthetic scope</h2>
          <form onSubmit={submitScope}>
            <label htmlFor="scope-select">Synthetic organisation and branch</label>
            <select
              id="scope-select"
              value={scopeKey}
              onChange={(event) => setScopeKey(event.target.value)}
            >
              {SYNTHETIC_SCOPES.map((option) => (
                <option key={option.key} value={`${option.organisationId}:${option.branchId}`}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="hint">
              The API has no organisation listing endpoint, so these are the seeded synthetic pairs from
              the local seed script. Membership is still checked by the API.
            </p>
            <button type="submit" disabled={busy === 'scope'}>
              Use this scope
            </button>
          </form>
        </div>
      )}

      {scope ? (
        <div className="card">
          <h2>Find a need</h2>
          <form onSubmit={submitNeed}>
            <label htmlFor="need-id">Need identifier (UUID)</label>
            <input
              id="need-id"
              name="needId"
              value={needIdInput}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setNeedIdInput(event.target.value)}
            />
            <p className="hint">
              There is no need listing endpoint, so a need is loaded by its identifier. The seeded
              synthetic need is pre-filled.
            </p>
            <button type="submit" disabled={busy === 'need'}>
              Load need
            </button>
          </form>
        </div>
      ) : null}

      {need ? (
        <section aria-labelledby="need-heading" className="card">
          <h2 id="need-heading">Need</h2>
          <dl>
            <dt>Identifier</dt>
            <dd className="mono">{need.id}</dd>
            <dt>Pack reference</dt>
            <dd className="mono">{need.productRef}</dd>
            <dt>Exact outstanding quantity</dt>
            <dd>{need.quantity}</dd>
            <dt>Status</dt>
            <dd>{need.status}</dd>
            <dt>Version</dt>
            <dd>{need.version}</dd>
          </dl>
        </section>
      ) : null}

      {need ? (
        <div className="card">
          <h2>Purchase request</h2>
          <form onSubmit={submitQuote}>
            <label htmlFor="quote-quantity">Quantity to purchase, in {SYNTHETIC_SALE_UNIT} units</label>
            <input
              id="quote-quantity"
              name="quantity"
              inputMode="decimal"
              value={quantity}
              autoComplete="off"
              onChange={(event) => setQuantity(event.target.value)}
            />
            <label htmlFor="supplier-select">Supplier constraint</label>
            <select
              id="supplier-select"
              value={supplierKey}
              onChange={(event) => setSupplierKey(event.target.value)}
            >
              {SYNTHETIC_SUPPLIERS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="hint">
              The seeded catalogue carries a single sale unit, so this request is fixed to that unit and
              to cash payment terms. The API exposes no unit or supplier listing to choose from.
            </p>
            <button type="submit" disabled={busy === 'quote'}>
              Request quote
            </button>
          </form>
        </div>
      ) : null}

      {quote ? (
        <section aria-labelledby="quote-heading" className="card">
          <h2 id="quote-heading">Quote</h2>
          <table>
            <caption>Quoted lines</caption>
            <thead>
              <tr>
                <th scope="col">Pack</th>
                <th scope="col">Quantity</th>
                <th scope="col">Unit</th>
                <th scope="col">Net</th>
                <th scope="col">Offer version</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map((line) => (
                <tr key={line.needId}>
                  <td>{[line.identity?.brand, line.identity?.strength].filter(Boolean).join(' ') || line.needId}</td>
                  <td>{line.quantity}</td>
                  <td>{line.unit}</td>
                  <td>{line.net}</td>
                  <td>{line.offerVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl>
            <dt>Total</dt>
            <dd>{quote.total}</dd>
            <dt>Currency</dt>
            <dd>{quote.currency}</dd>
            <dt>Expires at</dt>
            <dd>
              <time dateTime={quote.expiresAt}>{quote.expiresAt}</time>
            </dd>
            <dt>Binding status</dt>
            <dd>{quote.bindingStatus}</dd>
            <dt>Pricing rule</dt>
            <dd>{quote.pricingRuleVersion}</dd>
            <dt>Terms hash</dt>
            <dd className="mono wrap">{quote.termsHash}</dd>
            <dt>Unmet lines</dt>
            <dd>{quote.unmetLines.length}</dd>
          </dl>
          {quoteExpired ? (
            <p className="warning">
              This quote has expired. Request a new quote, review it, and approve the new one yourself.
            </p>
          ) : (
            <p className="hint">
              Approving places a real order intent against the synthetic supplier backend. It is never
              done automatically, and reloading this page will not repeat it.
            </p>
          )}
          <button type="button" onClick={approve} disabled={quoteExpired || busy === 'approve'}>
            {approvalRetry ? 'Retry approval' : 'Approve and place order'}
          </button>
        </section>
      ) : null}

      {approval ? (
        <div className="card">
          <h2>Approval</h2>
          <dl>
            <dt>Approval identifier</dt>
            <dd className="mono">{approval.approvalId}</dd>
            <dt>Approved quote version</dt>
            <dd>{approval.quoteVersion}</dd>
            <dt>Status</dt>
            <dd>{approval.status}</dd>
          </dl>
          <ul className="actions">
            {approval.orderIntentIds.map((intentId) => (
              <li key={intentId}>
                <button type="button" onClick={() => loadOrder(intentId)} disabled={busy === 'order'}>
                  Load order {shortId(intentId)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {order ? (
        <section aria-labelledby="order-heading" className="card">
          <h2 id="order-heading">Order intent</h2>
          <dl>
            <dt>Identifier</dt>
            <dd className="mono">{order.id}</dd>
            <dt>State</dt>
            <dd>{order.state}</dd>
            <dt>Client reference</dt>
            <dd className="mono">{order.externalClientRef}</dd>
            <dt>External order identifier</dt>
            <dd className="mono">{order.externalOrderId ?? 'none yet'}</dd>
            <dt>Version</dt>
            <dd>{order.version}</dd>
          </dl>
          {order.uncertainty ? (
            <p className="warning">
              The external outcome is uncertain: {order.uncertainty.safeToRetry ? 'safe to retry' : 'not safe to retry'}.
              Next action reported by the API: {order.uncertainty.nextAction}.
            </p>
          ) : (
            <p className="hint">The API reports no outstanding uncertainty for this order intent.</p>
          )}

          {order.lines.length === 0 ? (
            <p className="hint">
              This order intent has no supplier lines yet, so there is nothing to receive. Lines appear
              once the backend worker has submitted the intent to the synthetic supplier.
            </p>
          ) : (
            <form onSubmit={submitReceipt}>
              <table>
                <caption>Order lines and quantities</caption>
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Ordered</th>
                    <th scope="col">Accepted</th>
                    <th scope="col">Rejected</th>
                    <th scope="col">Shipped</th>
                    <th scope="col">Received</th>
                    <th scope="col">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => {
                    const remaining = remainingQuantity(line.shipped, line.received) ?? '0';
                    return (
                      <tr key={line.id}>
                        <td className="mono">{shortId(line.id)}</td>
                        <td>{line.ordered}</td>
                        <td>{line.accepted}</td>
                        <td>{line.rejected}</td>
                        <td>{line.shipped}</td>
                        <td>{line.received}</td>
                        <td>{remaining}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {order.lines.map((line) => {
                const remaining = remainingQuantity(line.shipped, line.received) ?? '0';
                return (
                  <div key={line.id} className="field">
                    <label htmlFor={`receipt-${line.id}`}>
                      Quantity received for line {shortId(line.id)} (at most {remaining})
                    </label>
                    <input
                      id={`receipt-${line.id}`}
                      type="number"
                      min="0"
                      max={remaining}
                      step="any"
                      value={receiptQuantities[line.id] ?? ''}
                      onChange={(event) =>
                        setReceiptQuantities((current) => ({ ...current, [line.id]: event.target.value }))
                      }
                    />
                  </div>
                );
              })}
              <p className="hint">
                Confirming records what actually arrived. Repeating the same quantities reuses the same
                receipt reference, so a retry cannot double count stock.
              </p>
              <button type="submit" disabled={busy === 'receipt'}>
                Confirm receipt
              </button>
            </form>
          )}

          {receiptReference ? (
            <p className="notice">
              Receipt recorded with stable reference <span className="mono">{receiptReference}</span>.
            </p>
          ) : null}
        </section>
      ) : null}

      <footer className="page-footer">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            await callBff('/api/bff/logout', { method: 'POST', csrfToken });
            window.location.assign('/');
          }}
        >
          <button type="submit">Sign out</button>
        </form>
      </footer>
    </main>
  );
}
