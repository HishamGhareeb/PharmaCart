# B3 synthetic submission and recovery evidence

Date: 2026-09-12. This is partial implementation evidence, not an acceptance PASS.

RED checkpoint: ad17630 records supplier/receipt/restore tests before their implementation. GREEN: npm run test:coverage passed 96 tests, including 19 PostgreSQL integration tests, with 94.92% line, 84.14% branch and 91.98% function coverage. The retained output is b3-coverage.txt.

The supplier integration exercises timeout after acceptance, lookup reconciliation without duplicate submission, partial quantities, authenticated order/receipt requests, receipt replay and changed-payload refusal, and settlement into spent budget. A real pg_dump/pg_restore of disposable pharmacart_test rolls the database back to before submission while retaining the independent fake supplier file ledger. Dispatch starts paused; lookup finds the existing external order using stable identities. Unavailable lookup prevents dispatch.

Setup applied ten migrations, created restricted runtime configuration, and seeded invented data. Re-seeding preserves existing workflow state. Build and default reconciliation-only worker commands passed. Type checking, lint and generated-contract verification passed. No real supplier calls or external receipt writebacks occur.

A checkout changed new migration line endings and the hash ledger correctly refused them. Restoring the original LF bytes resolved verification; the ledger was not changed. .gitattributes now fixes repository text to LF.

Limits: synthetic one-shot worker, no durable scheduler, no client UI, no supplier certification, no delivered writeback, and no completed AC-006/009/010/014 gate. See STATUS.md for procurement follow-ups.
