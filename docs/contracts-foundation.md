# PharmaCart contract foundation (B0-B3)

Status: proposed canonical contract for the synthetic procurement loop  
Scope: identity context, catalogue mapping, offers, needs, quotes, approval, order submission, and outcome reconciliation  
Source input: *PharmaCart Builder Master Plan*, PDF pages 6-16 (document pages 5-15)  

This document fixes the contract semantics needed to build and test B0-B3. OpenAPI and JSON Schema are the executable sources of truth once created; generated TypeScript and C# models must carry the source-schema hash. All examples here use synthetic organisations, products, accounts, and orders.

## 1. Contract-wide rules

### 1.1 Wire format

- Media type is `application/json`; UTF-8 is required.
- Commands reject unknown properties (`additionalProperties: false`). Read models may gain documented additive fields only in a new compatible schema revision.
- Identifiers are lowercase canonical UUID strings unless explicitly described as source identifiers. Source identifiers are opaque strings: trim neither whitespace nor leading zeroes unless an adapter's certified normalization rule says so.
- Instants use RFC 3339 UTC form with `Z`, for example `2026-09-11T10:00:00Z`. Schedules use a separate IANA time-zone name.
- Mutable aggregates expose a positive integer `version`. A successful mutation increments it by exactly one. Commands name the expected version in the body or `If-Match`; mismatches return `409 VERSION_CONFLICT`.
- Collection pagination uses an opaque `cursor`, defaults to 50 records, and allows at most 200.
- Every response includes `X-Correlation-Id`. A valid client-supplied value may be retained; otherwise the server creates one. Event records copy it to `correlationId`.

### 1.2 Exact decimals

Every money, price, quantity, conversion, percentage, tax, fee, and total crosses an API boundary as a JSON string. JSON numbers and exponential notation are invalid.

Canonical decimal grammar:

```text
^-?(0|[1-9][0-9]*)(\.[0-9]+)?$
```

Additional canonicalization rules:

- no leading `+`, leading zeroes, exponent, grouping separator, surrounding whitespace, or trailing decimal point;
- no negative zero (`-0`, `-0.0`) and no trailing fractional zeroes (`12.340`); use `12.34`;
- zero is `"0"`;
- domain fields that represent quantities or monetary amounts additionally require `>= 0`; unit prices require `> 0` when present;
- currency is ISO 4217 uppercase and is mandatory beside money;
- storage uses exact decimal/numeric types. Calculations never use IEEE-754 binary floating point;
- each pricing rule version defines intermediate precision and rounding mode. A binding quote stores every rounded component and the rule version. EGP UI display may show two places, but the API does not pad canonical values (`"12.5"`, not `"12.50"`).

`DecimalString` is the grammar-only scalar. Narrower schemas such as `NonNegativeDecimalString` and `PositiveDecimalString` add the domain constraint.

### 1.3 Errors

```json
{
  "error": {
    "code": "QUOTE_EXPIRED",
    "message": "This offer expired. Refresh the quote before approving.",
    "correlationId": "6f4a508d-c8d2-48b7-90e6-9253b78c88d7",
    "details": { "quoteId": "d3e0ea83-0d28-46ee-b2f5-a830b8fd6ff0" }
  }
}
```

Stable status mapping: missing or invalid identity `401`; known identity lacking permission `403`; inaccessible resource `404`; request/version/idempotency conflict `409`; domain validation `422`; body too large `413`; rate or tenant limit `429`. Responses never expose stack traces, credentials, raw supplier responses, or another tenant's existence.

## 2. Authenticated tenant context

The server never accepts `organisationId`, `pharmacyOrgId`, `supplierOrgId`, `membershipId`, or branch authority from a command body as proof of scope. Resource identifiers may identify the object being requested, but authorization derives independently.

For a human request, middleware validates the OIDC/BFF session and loads an active membership on every request. It constructs:

```ts
type TenantContext = {
  principalKind: 'member';
  userSubject: string;
  membershipId: UUID;
  organisationId: UUID;
  organisationKind: 'pharmacy' | 'supplier';
  role: 'pharmacy_owner' | 'purchaser' | 'receiver' |
        'supplier_operator' | 'supplier_administrator' | 'support';
  allowedBranchIds: UUID[];
  membershipVersion: number;
  correlationId: UUID;
};
```

If a user belongs to more than one organisation, the selected organisation comes from a signed session context or an explicit request header whose value must match an active membership. It is a selector, never authorization. Membership revocation or branch-scope changes take effect on the next request.

For a connector request, validated installation credentials yield `principalKind: 'connector'`, the installation ID, owner organisation, allowed branch IDs, and scopes. Payload values cannot override these fields.

At transaction start the API sets transaction-local PostgreSQL context from `TenantContext`. The application authorizes the service operation and RLS provides a second boundary. The runtime database role must not own protected tables, be superuser, or have `BYPASSRLS`. Shared orders require explicit policies for each participating organisation and branch. Pool-reuse tests must prove that context disappears after commit, rollback, and error.

## 3. Canonical entities

All entities include `id`, `createdAt`, and `updatedAt`; mutable entities include `version`.

### 3.1 Identity and commercial scope

| Entity | Canonical fields | Invariants |
|---|---|---|
| `Organisation` | `kind`, `name`, `verificationStatus` | Kind is `pharmacy` or `supplier`; only verified pharmacies can approve purchases. |
| `Branch` | `organisationId`, `name`, `timezone`, `externalRef?` | External ref unique within organisation when present. |
| `Membership` | `organisationId`, `userSubject`, `role`, `allowedBranchIds`, `status` | Unique organisation/user; revocation is audited. |
| `SupplierRelationship` | `pharmacyOrgId`, `supplierOrgId`, `accountRef`, `allowedPharmacyBranchIds`, `status`, `termsVersion`, `sharingPermissions` | Active, verified binding required for offer access and ordering. Account ref is opaque. |
| `ConnectorInstallation` | `ownerOrganisationId`, `adapterKey`, `adapterVersion`, `externalVersion`, `capabilityManifest`, `secretRef`, `allowedBranchIds`, `scopes`, `status` | Secret value is never returned; identity and scopes are installation-bound. |

Private tables carry their owning organisation in composite foreign keys. A pharmacy-supplier order is shared only between the two bound organisations and authorized branches.

### 3.2 Verified commercial-pack identity

`Product` means one commercial sale pack, not a drug concept or treatment:

```ts
type Product = {
  id: UUID;
  brand: string;
  manufacturer: string;
  strength: string;
  dosageForm: string;
  packSize: { value: PositiveDecimalString; unit: string };
  saleUnit: string;
  baseUnit: string;
  verifiedIdentifiers: Array<{
    scheme: string;
    value: string;
    verificationStatus: 'verified';
    evidenceRef: string;
    verifiedAt: Instant;
  }>;
  identityStatus: 'verified' | 'under_review' | 'quarantined';
};
```

An identifier alone cannot authorize a mapping. Automatic use requires all of:

1. a verified identifier match;
2. matching brand/manufacturer context where supplied;
3. exact strength and dosage form;
4. exact pack size and sale unit, or a separately approved conversion;
5. an active `SourceProductMap` version for that installation, source code, and source unit.

`SourceProductMap` stores `installationId`, opaque `sourceCode`, original `sourceDescription`, `sourceUnit`, `productId`, `conversion`, `status`, `mappingVersion`, reviewer/evidence references, and decision time. `conversion` is `{ numerator, denominator, sourceUnit, targetUnit }` using positive canonical decimal strings. It must be explicit, versioned, and supported by both source and destination. Mapping changes create a new version; historical quote and order lines retain the map version and normalized identity snapshot they used. Unknown or ambiguous codes are quarantined and cannot enter an automatic binding quote.

No contract field represents therapeutic substitution. Suggestions may be review evidence only and cannot approve a match, change stock, or create an order.

### 3.3 Procurement entities

| Entity | Required fields | Core invariant |
|---|---|---|
| `Need` | pharmacy org, branch, product, requested quantity/unit, stable source ref, status, version | Stable `(pharmacy, sourceRef)` prevents duplicate shortages. Product must be verified for quoting. |
| `Offer` | supplier org, relationship, product, sale unit, available quantity or unknown, unit price or unknown, currency, price basis, terms version, validity, observation ref, version | Visible only through the eligible account relationship; unknown stays unknown. |
| `Quote` | pharmacy org, branch, version, currency, expiry, binding status, exact total, terms hash, pricing rule version, status | A calculated version is immutable. Earliest offer expiry bounds quote expiry. Client totals are ignored/rejected. |
| `QuoteLine` | quote/version, product identity snapshot, requested/quoted quantity, supplier, offer/version, source-map/version, unit conversion, exact cost breakdown, fulfillment state | Captures every identity and commercial input needed to explain and reproduce the line. |
| `BudgetReservation` | pharmacy scope, period, amount/currency, quote/version, status | Created atomically with approval; released at most once. Unknown submissions remain reserved. |
| `Approval` | quote/version, actor membership, approved time, policy version, request hash, idempotency key | At most one successful approval per quote version. |
| `OrderIntent` | pharmacy, supplier, branch, quote/version, external client ref, state, version | Unique `(quoteId, quoteVersion, supplierOrgId)`; external ref survives every attempt. |
| `SubmissionAttempt` | intent, attempt number, request hash, started time, completed time?, outcome, response ref? | Immutable evidence. A crash after send starts yields `unknown`, never an automatic retry decision. |
| `OrderLine` | intent, quote line, product identity snapshot, ordered, accepted, rejected, cancelled, shipped, received, returned | Every quantity is exact and nonnegative; line constraints below apply. |

For an order line: `accepted + rejected <= ordered`; `cancelled <= accepted`; `shipped <= accepted - cancelled`; `received <= shipped`; `returned <= received`. Partial states are first-class. Parent order state is a derived summary and cannot erase line differences.

## 4. Synthetic B0-B3 loop

### B0: contract and identity fixtures

Create synthetic pharmacy/supplier organisations, memberships, branches, one verified relationship, synthetic connector capability manifests (not certified), 30 representative commercial packs, and mappings that include exact, ambiguous, missing-conversion, and changed-version cases. Contract tests reject decimals as numbers, tenant IDs in commands, leading-zero source-code normalization, and unverified pack mappings.

### B1: ingest eligible data

Inventory and offer envelopes derive installation and organisation from connector authentication. Durable inbox persistence precedes `202 Accepted`. Processing status is separate. Quotes may use only processed, current projections with an explicit freshness/confidence policy. Acknowledged ingestion alone is not quotable stock.

### B2: create a server quote

`POST /v1/quotes` accepts branch selector, need IDs/versions, requested quantities, and supported constraints. The service resolves the branch against `TenantContext`, verified product maps, active supplier relationships, eligible offers, freshness, and terms. It returns an immutable quote version with exact component strings, unmet lines, expiry, and either `binding` or `indicative`. Missing tax/fee rules, unknown price, unsupported conversion, unverified pack, or unsupported terms block binding approval.

### B3: approve and submit asynchronously

Approval transaction A locks quote and budget scope; rechecks membership, branch, quote version, expiry, offer freshness, terms, and binding status; creates the reservation, approval, one supplier intent each, and outbox rows; then commits once. The response is `202 Accepted` with intent IDs. No external supplier call occurs in this transaction.

Workers submit each durable intent using its stable `externalClientRef`. Before I/O they append a `SubmissionAttempt`. They classify the result as accepted, rejected, or unknown and store only redacted response evidence. Unknown starts reconciliation; it never becomes rejected merely due to timeout.

## 5. API contracts

### 5.1 Quote creation

```http
POST /v1/quotes
```

```json
{
  "branchId": "69deff0e-01f0-4dfe-8d85-8bb0aa685117",
  "lines": [{
    "needId": "9e187047-0063-49c8-a10b-258239e88e4e",
    "needVersion": 3,
    "quantity": "12",
    "unit": "box"
  }],
  "constraints": { "supplierIds": [], "paymentTerm": "cash" }
}
```

The response contains `id`, `version`, `status`, `bindingStatus`, `currency`, `expiresAt`, `pricingRuleVersion`, `termsHash`, `lines`, `unmetLines`, and `total`. Each line includes the immutable product identity snapshot, mapping version, offer version, quantity/unit, conversion, and cost components (`gross`, `discount`, `tax`, `fees`, `net`) as exact decimal strings. Server recalculation is authoritative.

### 5.2 Approval idempotency

```http
POST /v1/quotes/{quoteId}/approve
Idempotency-Key: approve-demo-0001
```

```json
{ "quoteVersion": 4 }
```

The idempotency record is keyed by `(callerOrganisationId, operation='approve_quote', idempotencyKey)` and stores the canonical request hash plus final HTTP status/body in the same database transaction as the approval. The canonical hash includes path quote ID, quote version, and any future command fields; it excludes transport headers except the caller scope and operation already present in the key.

- First valid request: atomically creates approval, reservation, intents, outbox records, and stored response; returns `202`.
- Same scoped key and same request hash: returns the stored status/body, including identical IDs, without rechecking or duplicating effects.
- Same scoped key with a different hash: `409 IDEMPOTENCY_KEY_REUSED`.
- Different key for a quote version already approved: returns the canonical existing approval/intents (recommended `200`) or a stable conflict. This behavior must be fixed before OpenAPI publication; it must never create duplicates.
- Concurrent requests serialize on the idempotency/quote uniqueness constraints. A losing transaction reads the committed result.
- Expiry of cached response data never relaxes unique approval and quote/supplier intent constraints.

Successful response:

```json
{
  "approvalId": "27566206-1e0b-461b-b394-a58752ca18c1",
  "quoteId": "d3e0ea83-0d28-46ee-b2f5-a830b8fd6ff0",
  "quoteVersion": 4,
  "status": "queued",
  "orderIntentIds": ["3ab84b54-2115-47f3-a63f-43660720149c"]
}
```

### 5.3 Order read model and uncertainty

`GET /v1/orders/{id}` is available only to a participating organisation and allowed branch. It reports intent state, line quantities, supplier reference if known, attempts as redacted evidence, and an uncertainty block:

```json
{
  "state": "outcome_unknown",
  "externalClientRef": "pc-syn-01J7D4K2B8P0",
  "uncertainty": {
    "since": "2026-09-11T10:05:30Z",
    "reason": "transport_timeout_after_send",
    "reconciliationRef": "rec-syn-0007",
    "nextAction": "lookup_pending",
    "safeToRetry": false
  }
}
```

Clients must display an uncertain state and cannot present success, rejection, or a retry button unless the server supplies an allowed next action.

### 5.4 Adapter submission and lookup

```ts
type SubmitResult =
  | { kind: 'accepted'; externalOrderId: string; acknowledgement: LineAcknowledgement[] }
  | { kind: 'rejected'; code: string; message: string; acknowledgement?: LineAcknowledgement[] }
  | { kind: 'unknown'; reconciliationRef: string };

type OrderLookup =
  | { kind: 'found'; externalOrderId: string; acknowledgement: LineAcknowledgement[] }
  | { kind: 'not_found'; authoritativeAt: Instant; retryPermitted: boolean }
  | { kind: 'inconclusive'; reconciliationRef: string };
```

The capability manifest states external idempotency support, lookup support, lookup key, and the precise condition under which `not_found` is authoritative. Submission decision table:

| Evidence after an attempt | Next state/action |
|---|---|
| Accepted with external order ID | `acknowledged`; no resubmit. |
| Explicit domain rejection | `rejected`; release reservation once per policy. |
| Timeout, disconnect, malformed response, or crash after possible send | `outcome_unknown`; keep reservation. |
| Unknown + lookup finds order | `acknowledged`; link evidence. |
| Unknown + authoritative not-found and manifest permits retry | enqueue retry using the same external client ref/idempotency key. |
| Unknown + non-authoritative not-found or inconclusive lookup | `human_review`; no automatic mutation. |

An adapter must never switch transport after uncertainty. Unsupported operations return `CAPABILITY_UNSUPPORTED`, never an empty success object.

## 6. State machines and transactional events

Quote states: `draft -> quoted -> approved`; an expired quote becomes `expired`; changed material inputs produce a new version requiring a new approval.

Intent states:

```text
queued -> submitting -> acknowledged
                     -> rejected
                     -> outcome_unknown -> acknowledged
                                        -> rejected
                                        -> retry_queued -> submitting
                                        -> human_review
```

Only explicit adapter evidence or authorized human reconciliation can leave `human_review`. Cancellation remains `cancellation_requested` until supplier confirmation.

Outbox events are committed facts with `eventId`, `schemaVersion`, `eventType`, `aggregateId`, `aggregateVersion`, organisation scope, `occurredAt`, `correlationId`, `causationId`, and a non-sensitive payload. B0-B3 requires `QuoteApproved`, `OrderSubmissionRequested`, `OrderOutcomeUnknown`, `OrderAcknowledged`, and `OrderRejected`. Consumers deduplicate by event ID; aggregate-version checks prevent stale writers from overwriting newer state.

## 7. Minimum contract verification

Contract tests must prove:

- malformed/noncanonical decimal strings and all JSON numeric decimals are rejected;
- server totals equal persisted exact component arithmetic under the named rule version;
- cross-tenant IDs return `404` and cannot change transaction-local scope;
- membership revocation and branch-scope change apply on the next request;
- a connection-pool session cannot inherit tenant context;
- only active verified product/map versions enter a binding quote;
- leading-zero source identifiers round-trip unchanged;
- concurrent same-key approvals return one approval/reservation/intent set;
- same idempotency key with a changed body returns `409`;
- different keys cannot bypass quote/version and quote/supplier uniqueness;
- a simulated crash after supplier receipt produces `outcome_unknown`, preserves the budget reservation, and does not blindly retry;
- lookup permits resubmission only under the certified authoritative-not-found rule;
- partial line acknowledgement preserves valid quantity constraints and derived parent status.

## 8. Open decisions before executable schemas

1. Choose the decimal library, database precision/scale limits per quantity and pricing field, and the named rounding mode for the first pricing rule. The wire canonicalization above is fixed regardless of library.
2. Decide whether a second idempotency key presented for an already-approved quote returns `200` with the canonical result or `409 ALREADY_APPROVED`; same-key replay remains the stored original response.
3. Define quote expiry defaults and freshness thresholds per synthetic adapter. The plan proposes five minutes bounded by earliest offer expiry, but this needs acceptance criteria.
4. Define budget scope and period boundaries, including branch versus organisation scope and the IANA time zone used for a day.
5. Define the authoritative lookup window for each certified adapter. Until certified, unknown submissions require human review and cannot auto-retry.
6. Decide whether `sourceProductMap.conversion` uses a reduced rational pair only or also stores an explanatory decimal; arithmetic must remain exact.
7. Fix supported B1 pricing terms (tax status, fees, minimum order, cash/credit) and identify which missing values make a quote indicative.
8. Choose retention periods for idempotency response bodies, raw ingestion envelopes, attempt evidence, and audit records while retaining durable uniqueness keys.
9. Define who may perform human reconciliation, required evidence, and whether step-up authentication is mandatory.
10. Confirm whether supplier partial rejection releases a proportional reservation before terminal basket reconciliation or only at a later policy checkpoint.

