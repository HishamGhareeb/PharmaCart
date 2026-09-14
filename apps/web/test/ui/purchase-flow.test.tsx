/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PurchaseFlow } from '../../src/components/purchase-flow.tsx';
import { SYNTHETIC_NEED_ID, SYNTHETIC_SCOPES } from '../../src/lib/fixtures.ts';
import type { SessionView } from '../../src/lib/session.ts';

const SCOPE = SYNTHETIC_SCOPES[0]!;
const QUOTE_ID = '60000000-0000-4000-8000-000000000001';
const ORDER_ID = '61000000-0000-4000-8000-000000000001';
const LINE_ID = '62000000-0000-4000-8000-000000000001';

const NEED = { id: SYNTHETIC_NEED_ID, productRef: 'PC-SYN-PACK-0001', quantity: '2', status: 'open', version: 3 };

function quote(expiresInMs: number) {
  return {
    id: QUOTE_ID,
    version: 1,
    status: 'quoted',
    bindingStatus: 'binding',
    currency: 'EGP',
    total: '24.7',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    pricingRuleVersion: 'synthetic-cash-tax-exempt-v1',
    termsHash: 'a'.repeat(64),
    unmetLines: [],
    lines: [
      {
        needId: SYNTHETIC_NEED_ID,
        needVersion: 3,
        quantity: '2',
        unit: 'box',
        net: '24.7',
        gross: '24.7',
        discount: '0',
        tax: '0',
        fees: '0',
        offerVersion: 1,
        termsVersion: 1,
        supplierId: '10000000-0000-4000-8000-000000000003',
        identity: { brand: 'Synthetic Brand', strength: '500 mg', saleUnit: 'box' },
      },
    ],
  };
}

const ORDER = {
  id: ORDER_ID,
  state: 'acknowledged',
  externalClientRef: `pc-syn-${ORDER_ID}`,
  externalOrderId: 'syn-ext-1',
  version: 3,
  uncertainty: null,
  lines: [
    {
      id: LINE_ID,
      productIdentity: { brand: 'Synthetic Brand', saleUnit: 'box' },
      ordered: '2',
      accepted: '2',
      rejected: '0',
      shipped: '2',
      received: '1',
    },
  ],
};

type Route = { status: number; body: unknown } | (() => Promise<never>);

let routes: Map<string, Route>;
let calls: { method: string; url: string; headers: Headers; body: unknown }[];

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    subject: SCOPE.expectedSubject,
    csrfToken: 'csrf-token-value-0123456789abcdef',
    expiresAt: Date.now() + 300_000,
    scope: {
      organisationId: SCOPE.organisationId,
      branchId: SCOPE.branchId,
      organisationKind: 'pharmacy',
      role: 'pharmacy_owner',
    },
    ...overrides,
  };
}

function key(method: string, url: string): string {
  return `${method} ${new URL(url, 'http://127.0.0.1:3001').pathname}`;
}

beforeEach(() => {
  routes = new Map();
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, headers, body });
    const route = routes.get(key(method, url));
    if (typeof route === 'function') return route();
    if (!route) throw new Error(`unrouted request: ${key(method, url)}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function approvesOf(): typeof calls {
  return calls.filter((call) => call.url.includes('/approve'));
}

async function loadNeed(user: ReturnType<typeof userEvent.setup>) {
  routes.set(`GET /api/bff/needs/${SYNTHETIC_NEED_ID}`, { status: 200, body: NEED });
  await user.clear(screen.getByLabelText(/need identifier/i));
  await user.type(screen.getByLabelText(/need identifier/i), SYNTHETIC_NEED_ID);
  await user.click(screen.getByRole('button', { name: /load need/i }));
  await screen.findByText('PC-SYN-PACK-0001');
}

async function getQuote(user: ReturnType<typeof userEvent.setup>, expiresInMs = 300_000) {
  routes.set('POST /api/bff/quotes', { status: 201, body: quote(expiresInMs) });
  await user.click(screen.getByRole('button', { name: /request quote/i }));
  await screen.findByRole('region', { name: /quote/i });
}

describe('purchase flow page', () => {
  it('offers a real sign-in link and performs no background requests when signed out', async () => {
    render(<PurchaseFlow session={null} />);
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link).toHaveProperty('href', 'http://127.0.0.1:3001/auth/login');
    expect(calls).toHaveLength(0);
  });

  it('lets a signed-in user choose a known synthetic organisation and branch', async () => {
    const user = userEvent.setup();
    routes.set('POST /api/bff/scope', { status: 200, body: { session: session() } });
    render(<PurchaseFlow session={session({ scope: null, subject: null })} />);

    const select = screen.getByLabelText(/organisation and branch/i);
    expect(within(select as HTMLSelectElement).getAllByRole('option').length).toBe(SYNTHETIC_SCOPES.length);
    await user.selectOptions(select, `${SCOPE.organisationId}:${SCOPE.branchId}`);
    await user.click(screen.getByRole('button', { name: /use this scope/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ organisationId: SCOPE.organisationId, branchId: SCOPE.branchId });
    expect(calls[0]!.headers.get('x-pharmacart-csrf')).toBe('csrf-token-value-0123456789abcdef');
    expect(calls[0]!.url.startsWith('/api/bff/')).toBe(true);
  });

  it('shows the pack reference, exact quantity and version of a loaded need', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);

    const need = screen.getByRole('region', { name: /need/i });
    expect(within(need).getByText('PC-SYN-PACK-0001')).toBeTruthy();
    expect(within(need).getByText('2')).toBeTruthy();
    expect(within(need).getByText('3')).toBeTruthy();
  });

  it('explains a 404 need instead of showing an empty card', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    routes.set(`GET /api/bff/needs/${SYNTHETIC_NEED_ID}`, {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', correlationId: 'c1' } },
    });
    await user.clear(screen.getByLabelText(/need identifier/i));
    await user.type(screen.getByLabelText(/need identifier/i), SYNTHETIC_NEED_ID);
    await user.click(screen.getByRole('button', { name: /load need/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not found/i);
    expect(screen.queryByRole('region', { name: /need/i })).toBeNull();
  });

  it('tells the user to sign in again on a 401 and stops the flow', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    routes.set(`GET /api/bff/needs/${SYNTHETIC_NEED_ID}`, {
      status: 401,
      body: { error: { code: 'UNAUTHENTICATED', message: 'A valid access token is required.', correlationId: 'c1' } },
    });
    await user.clear(screen.getByLabelText(/need identifier/i));
    await user.type(screen.getByLabelText(/need identifier/i), SYNTHETIC_NEED_ID);
    await user.click(screen.getByRole('button', { name: /load need/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/sign in again/i);
  });

  it('shows quote lines, total, currency, expiry and terms', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);

    const region = screen.getByRole('region', { name: /quote/i });
    // The total and the single line both carry the same exact amount.
    expect(within(region).getAllByText(/^24\.7$/).length).toBe(2);
    expect(within(region).getByText(/EGP/)).toBeTruthy();
    expect(within(region).getByText(/synthetic-cash-tax-exempt-v1/)).toBeTruthy();
    expect(within(region).getByText(new RegExp('a'.repeat(16)))).toBeTruthy();
    expect(within(region).getByRole('table')).toBeTruthy();
    expect(within(region).getByText(/box/)).toBeTruthy();
  });

  it('never approves without an explicit click, and approves exactly once when clicked', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);
    expect(approvesOf()).toHaveLength(0);

    routes.set(`POST /api/bff/quotes/${QUOTE_ID}/approve`, {
      status: 202,
      body: { approvalId: 'approval-1', quoteId: QUOTE_ID, quoteVersion: 1, status: 'queued', orderIntentIds: [ORDER_ID] },
    });
    await user.click(screen.getByRole('button', { name: /approve/i }));

    await screen.findByText(/approval-1/);
    expect(approvesOf()).toHaveLength(1);
    expect(approvesOf()[0]!.body).toEqual({ quoteVersion: 1 });
  });

  it('re-sends an identical approval after a network failure and does not duplicate it on success', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);

    routes.set(`POST /api/bff/quotes/${QUOTE_ID}/approve`, async () => {
      throw new TypeError('Failed to fetch');
    });
    await user.click(screen.getByRole('button', { name: /^approve/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not be confirmed|retry/i);

    routes.set(`POST /api/bff/quotes/${QUOTE_ID}/approve`, {
      status: 202,
      body: { approvalId: 'approval-1', quoteId: QUOTE_ID, quoteVersion: 1, status: 'queued', orderIntentIds: [ORDER_ID] },
    });
    await user.click(screen.getByRole('button', { name: /retry approval/i }));
    await screen.findByText(/approval-1/);

    expect(approvesOf()).toHaveLength(2);
    expect(approvesOf()[0]!.body).toEqual(approvesOf()[1]!.body);
  });

  it('refuses to approve an expired quote and demands a new one', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user, -1000);

    const approve = screen.getByRole('button', { name: /approve/i });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/request a new quote/i)).toBeTruthy();
    expect(approvesOf()).toHaveLength(0);
  });

  it('reports a changed need and requires a new quote and a new approval', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);
    routes.set(`POST /api/bff/quotes/${QUOTE_ID}/approve`, {
      status: 409,
      body: { error: { code: 'REQUOTE_REQUIRED', message: 'stale', correlationId: 'c1' } },
    });
    await user.click(screen.getByRole('button', { name: /^approve/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/new quote/i);
    expect(screen.queryByText(/approval-1/)).toBeNull();
  });

  it('shows the order intent state, uncertainty and line quantities', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);
    routes.set(`POST /api/bff/quotes/${QUOTE_ID}/approve`, {
      status: 202,
      body: { approvalId: 'approval-1', quoteId: QUOTE_ID, quoteVersion: 1, status: 'queued', orderIntentIds: [ORDER_ID] },
    });
    await user.click(screen.getByRole('button', { name: /^approve/i }));
    await screen.findByText(/approval-1/);

    routes.set(`GET /api/bff/orders/${ORDER_ID}`, {
      status: 200,
      body: { ...ORDER, state: 'outcome_unknown', uncertainty: { safeToRetry: false, nextAction: 'reconciliation_required' } },
    });
    await user.click(screen.getByRole('button', { name: /load order/i }));

    const region = await screen.findByRole('region', { name: /order/i });
    expect(within(region).getByText(/outcome_unknown/)).toBeTruthy();
    expect(within(region).getByText(/reconciliation_required/)).toBeTruthy();
    expect(within(region).getByText(/not safe to retry/i)).toBeTruthy();
  });

  it('limits the receipt to the remaining shipped quantity and confirms it explicitly', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);
    routes.set(`POST /api/bff/quotes/${QUOTE_ID}/approve`, {
      status: 202,
      body: { approvalId: 'approval-1', quoteId: QUOTE_ID, quoteVersion: 1, status: 'queued', orderIntentIds: [ORDER_ID] },
    });
    await user.click(screen.getByRole('button', { name: /^approve/i }));
    await screen.findByText(/approval-1/);

    routes.set(`GET /api/bff/orders/${ORDER_ID}`, { status: 200, body: ORDER });
    await user.click(screen.getByRole('button', { name: /load order/i }));
    await screen.findByRole('region', { name: /order/i });

    const input = screen.getByLabelText(/quantity received/i) as HTMLInputElement;
    expect(input.value).toBe('1');
    expect(input.max).toBe('1');

    routes.set(`POST /api/bff/orders/${ORDER_ID}/receipts`, {
      status: 200,
      body: { id: 'receipt-1', reference: 'pc-web-receipt-abc' },
    });
    await user.click(screen.getByRole('button', { name: /confirm receipt/i }));
    await screen.findByText(/pc-web-receipt-abc/);

    const receipt = calls.find((call) => call.url.includes('/receipts'))!;
    expect(receipt.body).toEqual({ lines: [{ lineId: LINE_ID, quantity: '1' }] });
  });

  it('says nothing can be received while the order carries no supplier lines yet', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);
    routes.set(`POST /api/bff/quotes/${QUOTE_ID}/approve`, {
      status: 202,
      body: { approvalId: 'approval-1', quoteId: QUOTE_ID, quoteVersion: 1, status: 'queued', orderIntentIds: [ORDER_ID] },
    });
    await user.click(screen.getByRole('button', { name: /^approve/i }));
    await screen.findByText(/approval-1/);

    routes.set(`GET /api/bff/orders/${ORDER_ID}`, {
      status: 200,
      body: { ...ORDER, state: 'queued', externalOrderId: null, lines: [] },
    });
    await user.click(screen.getByRole('button', { name: /load order/i }));

    const region = await screen.findByRole('region', { name: /order/i });
    expect(within(region).getByText(/no supplier lines/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /confirm receipt/i })).toBeNull();
  });

  it('keeps nothing sensitive in browser storage and exposes no token in the DOM', async () => {
    const user = userEvent.setup();
    const { container } = render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(container.innerHTML).not.toMatch(/bearer|access_token|password|postgres/i);
  });

  // `1.50` is what a person types and what a number input produces, but the quote and receipt schemas
  // in packages/contracts refuse a trailing fraction zero. Sending it unchanged earns an opaque 400
  // that names a canonical decimal the form never mentioned.
  it('sends a trailing-zero quantity as the canonical decimal the API accepts', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);

    const field = screen.getByLabelText(/quantity to purchase/i);
    await user.clear(field);
    await user.type(field, '1.50');
    await getQuote(user);

    const request = calls.find((call) => call.url.endsWith('/api/bff/quotes'))!;
    expect((request.body as { quantity: string }).quantity).toBe('1.5');
  });

  it('refuses a quantity that is not a number without calling the API', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);

    const field = screen.getByLabelText(/quantity to purchase/i);
    await user.clear(field);
    await user.type(field, 'two');
    await user.click(screen.getByRole('button', { name: /request quote/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/quantity/i);
    expect(calls.filter((call) => call.url.endsWith('/api/bff/quotes'))).toHaveLength(0);
  });

  // A line the operator cleared is a line nothing arrived for, not a malformed entry. It has to be
  // left out of the receipt rather than sent as an empty quantity for the API to refuse.
  it('leaves a cleared receipt line out instead of sending an empty quantity', async () => {
    const user = userEvent.setup();
    // A distinct leading block: the form labels lines by their first eight characters.
    const secondLineId = '63000000-0000-4000-8000-000000000002';
    render(<PurchaseFlow session={session()} />);
    await loadNeed(user);
    await getQuote(user);
    routes.set(`POST /api/bff/quotes/${QUOTE_ID}/approve`, {
      status: 202,
      body: { approvalId: 'approval-1', quoteId: QUOTE_ID, quoteVersion: 1, status: 'queued', orderIntentIds: [ORDER_ID] },
    });
    await user.click(screen.getByRole('button', { name: /^approve/i }));
    await screen.findByText(/approval-1/);

    routes.set(`GET /api/bff/orders/${ORDER_ID}`, {
      status: 200,
      body: {
        ...ORDER,
        lines: [
          { ...ORDER.lines[0]!, shipped: '2', received: '0' },
          { ...ORDER.lines[0]!, id: secondLineId, shipped: '3', received: '0' },
        ],
      },
    });
    await user.click(screen.getByRole('button', { name: /load order/i }));
    await screen.findByRole('region', { name: /order/i });

    await user.clear(screen.getByLabelText(new RegExp(`quantity received for line ${secondLineId.slice(0, 8)}`, 'i')));

    routes.set(`POST /api/bff/orders/${ORDER_ID}/receipts`, {
      status: 200,
      body: { id: 'receipt-1', reference: 'pc-web-receipt-abc' },
    });
    await user.click(screen.getByRole('button', { name: /confirm receipt/i }));
    await screen.findByText(/pc-web-receipt-abc/);

    const receipt = calls.find((call) => call.url.includes('/receipts'))!;
    expect(receipt.body).toEqual({ lines: [{ lineId: LINE_ID, quantity: '2' }] });
  });

  it('is operable from the keyboard with labelled controls', async () => {
    const user = userEvent.setup();
    render(<PurchaseFlow session={session()} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/need identifier/i));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /load need/i }));

    for (const name of [/load need/i]) {
      expect(screen.getByRole('button', { name }).getAttribute('type')).toBe('submit');
    }
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(0);
  });
});
