# B0 executable contracts: TDD evidence

## Source and scope

The journeys were derived from the B0 contract task and `docs/contracts-foundation.md`. This run implements only dependency-free executable primitives: canonical decimal validation, strict quote-approval command validation, submission/lookup result types, and a conservative follow-up decision. It does not implement an HTTP API, persistence, adapters, or adapter certification.

## User journeys

- As a contract consumer, I want exact decimal strings validated canonically so values remain exact and have one wire representation.
- As the approval service, I want a strict command containing only a positive safe `quoteVersion` so untrusted tenant or aggregate fields cannot enter the command.
- As an order worker, I want an exhaustive decision from submission and lookup evidence so an unknown external outcome is never retried blindly.

## RED and GREEN report

Validation command used for both gates:

```text
node --experimental-strip-types --test packages/contracts/test/*.test.ts
```

RED was run before production modules existed. Node executed all three test files and reported `ERR_MODULE_NOT_FOUND` for `src/approval.ts`, `src/decimal.ts`, and `src/submission.ts`: `tests 3`, `pass 0`, `fail 3`. This was the intended compile-time RED because the tests referenced the missing contract surface.

The first implementation run executed 16 tests. Fourteen passed and two failed, identifying that the decimal grammar rejected canonical positive fractions below one. After correcting that grammar, GREEN reported: `tests 16`, `pass 16`, `fail 0`, `skipped 0`, duration about 254 ms.

A review follow-up added explicit tab, trailing LF, and trailing CRLF cases. They were already GREEN on Node 24 because `$` without multiline mode did not accept those suffixes in this runtime, so there was no honest regression RED to record. The implementation nevertheless replaced `$` with `(?![\s\S])` to express strict end-of-input directly. The full suite remained GREEN.

No TDD checkpoint commits were created because the task assigns commits to the coordinator. This report preserves the RED/GREEN evidence for later squash or PR description use.

## Test specification

| # | What is guaranteed | Test target | Type | Result |
|---|---|---|---|---|
| 1 | Canonical integer/fraction strings, including `-0.5`, are accepted; numbers, exponents, negative zero, leading zeroes, all tested trailing whitespace (including LF and CRLF), and trailing fractional zeroes are rejected. | `decimal.test.ts` canonical cases | Unit | PASS |
| 2 | Decimal input is bounded to 128 characters by default and supports a validated smaller caller bound. | `decimal.test.ts` length cases | Unit | PASS |
| 3 | Nonnegative validation includes zero and positive validation excludes zero; both reject negatives and noncanonical values. | `decimal.test.ts` refinements | Unit | PASS |
| 4 | Approval accepts exactly `{ quoteVersion }` where the value is a positive safe integer. | `approval.test.ts` valid case | Unit | PASS |
| 5 | Approval rejects primitives, arrays, missing/unknown properties, non-positive, fractional, string, non-finite, and unsafe versions. | `approval.test.ts` invalid cases | Unit | PASS |
| 6 | Accepted/rejected submission results remain terminal even if lookup evidence is supplied. | `submission-decision.test.ts` terminal cases | Unit | PASS |
| 7 | Unknown without lookup reconciles; found acknowledges; retry occurs only for authoritative not-found evidence with explicit retry permission. | `submission-decision.test.ts` decision table | Unit | PASS |
| 8 | Forbidden or inconclusive lookup routes to human review rather than blind retry. | `submission-decision.test.ts` uncertainty cases | Unit | PASS |

## Coverage and gaps

Coverage command:

```text
node --experimental-strip-types --experimental-test-coverage --test packages/contracts/test/*.test.ts
```

Result: 16/16 tests passed. Node reported 100% line, branch, and function coverage for `approval.ts`, `decimal.ts`, and `submission.ts`.

Intentional gaps: these are pure boundary primitives. Runtime JSON parsing, HTTP headers and status codes, database uniqueness, authenticated tenant context, persistent idempotency, actual adapter I/O, and certification behavior remain outside this bounded B0 slice and must not be inferred from these tests.
