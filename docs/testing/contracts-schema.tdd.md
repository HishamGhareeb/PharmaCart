# B0 contract schemas and generation: TDD evidence

## Scope and journeys

This bounded slice extends `docs/contracts-foundation.md` and the executable contract primitives. It does not implement an HTTP API, persistence, connector certification, or network I/O.

- As a contract maintainer, I want draft 2020-12 JSON Schemas to be canonical sources so wire shapes are reviewable and language-neutral.
- As a TypeScript consumer, I want deterministic generated types with a source hash so schema drift fails verification.
- As an order worker, I want strict validation of untrusted adapter results and trusted capabilities to authorize retry so a network response cannot cause a duplicate order.

## RED/GREEN evidence

RED command:

```text
node --experimental-strip-types --test packages/contracts/test/*.test.ts
```

Before implementation, Node reported three failing test-file targets. The schema tests failed with `ENOENT` for `schema/decimal.schema.json` and `generated/contracts.ts`; the submission test failed because `validateOrderLookup` was not exported. Existing decimal and approval tests remained green. This is the intended RED for the missing schema/generation/validation behavior.

After adding the schemas, deterministic generator and verifier, generated artifact, runtime validators, and capability-gated decision logic, the same command reported `tests 21`, `pass 21`, `fail 0`, `skipped 0`.

No checkpoint commits were created because the coordinator owns commits. This report preserves the evidence for a later commit or PR description.

## Guarantees

| # | Guarantee | Test target | Result |
|---|---|---|---|
| 1 | Decimal, approval, submit-result, and order-lookup schemas declare JSON Schema draft 2020-12. | `schema-generation.test.ts` | PASS |
| 2 | Commands and every discriminated response variant reject unknown properties. | Schema inspection plus strict runtime validator tests | PASS |
| 3 | Generated TypeScript is byte-for-byte reproducible from canonicalized, sorted schema inputs and contains their SHA-256 hash. | `verify-contracts.ts`; `schema-generation.test.ts` | PASS |
| 4 | Existing public contract types now originate in `generated/contracts.ts`, while runtime modules re-export them and retain their existing import surface. | Strict `tsc --noEmit` | PASS |
| 5 | Untrusted submit and lookup objects reject wrong discriminants, missing fields, wrong field types, empty/bounded identifiers, and injected properties. | `submission-decision.test.ts` | PASS |
| 6 | `not_found` plus the deprecated network `retryPermitted: true` cannot authorize a retry by itself. | `network retry permission cannot authorize retry without trusted capability` | PASS |
| 7 | Retry occurs only when the result is unknown, lookup is `not_found`, and separately supplied trusted capabilities assert both authoritative lookup support and retry permission. | `retry requires both authoritative not-found evidence and adapter permission` | PASS |
| 8 | Missing or insufficient trusted capability defaults to human review. | `submission-decision.test.ts` decision table | PASS |

## Verification and coverage

Commands run:

```text
node --experimental-strip-types packages/contracts/scripts/verify-contracts.ts
npx tsc --noEmit
node --experimental-strip-types --experimental-test-coverage --test-coverage-exclude=**/test/** --test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80 --test packages/contracts/test/*.test.ts
```

Results: generated contracts verified; strict TypeScript emitted no errors; 21/21 tests passed. Aggregate coverage was 96.17% lines, 93.14% branches, and 100% functions. The uncovered verifier branch is its deliberate stale-artifact failure path; semantic failure cases for contract values are exercised through representative bad inputs rather than duplicating every equivalent field branch.

## Dependencies and limits

Generation and runtime validation use only Node 24 built-ins; no additional dependency is required for this slice. The repository's TypeScript 5.9.3 and `@types/node` 24.10.1 validate the artifacts. Ajv 8.20.0 is available for later general schema compilation, but these narrow validators intentionally have no runtime dependency and are tested against the same bounds and strict-property semantics as the source schemas.

The `retryPermitted` lookup property remains required and deprecated for compatibility with the established wire/type surface. Runtime decision logic deliberately ignores it as authorization. Trusted `SubmissionCapabilities` must come from authenticated installation configuration, not from the adapter response body.
