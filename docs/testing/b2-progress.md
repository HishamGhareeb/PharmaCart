# B2 execution — 2026-09-12

The quote test first failed because procurement.ts did not exist (cf59600 retains the test). The initial integrated run exposed missing PostgreSQL UPDATE privilege for share locks. Forward migration 0008 grants UPDATE only on identifier columns so commercial fields remain read-only to the runtime. Subsequent execution passes the combined quote/approval test.

Real local OIDC plus PostgreSQL assertions: exact 2 × 12.35 total equals canonical 24.7; three concurrent approvals (two keys plus one repeated key) produce one approval, reservation, supplier intent and budget charge; same key with changed version returns 409 without another approval; another quote for the same need cannot approve again; a changed offer version returns REQUOTE_REQUIRED; ambiguous same-brand pack text is held for review and its unverified mapping cannot enter a binding quote.

Synthetic policy decisions: cash-only EGP; explicit tax-exempt/zero-fee pricing rule synthetic-cash-tax-exempt-v1; PostgreSQL exact numeric with each line rounded to two decimal places; five-minute quote expiry bounded by offer expiry; branch/currency/month budget in UTC; a different key for the same approved quote returns canonical response with 200, same-key replay retains original status. These are development policies, not verified supplier commercial terms.

No external submission occurs during approval. Outbox records and supplier intents commit with the reservation and response. Supplier state machines, receipt handling and restore/replay remain B3 work. Catalogue/map/offer setup currently uses synthetic administrative fixtures; supplier ingestion and human mapping-management UI are not delivered.
