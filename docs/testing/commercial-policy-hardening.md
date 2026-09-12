# Commercial policy hardening — test evidence

Branch: `claude/commercial-policy-hardening`, based on `claude/domain-packages` at `bcf0f4f`
Worktree: isolated; the `codex/b0-b3-synthetic-loop` working directory was not touched
Date: 2026-09-12
Scope: `need-derivation`, `coverage-target`, `supplier-performance`, `supply-ranking`

## 1. Inherited baseline, measured before any change

Recorded on a clean checkout of `bcf0f4f` after `npm ci`.

| Check | Result at base | Cause |
| --- | --- | --- |
| `npm test` | 318 tests, 317 pass, **1 fail** | `packages/contracts/test/schema-generation.test.ts`: generated contracts are stale |
| `npm run typecheck` | **fail, 4 errors** | all in `packages/db/test/supplier.test.ts` |
| `npm run lint` | pass | |
| `npm run contracts:verify` | **fail** | generated contracts are stale |
| The four owned packages | 49 tests, 49 pass | |

All four typecheck errors are in one file this work never touched:

```
packages/db/test/supplier.test.ts(6,30): error TS2307: Cannot find module '../../supplier/src/fake.ts'
packages/db/test/supplier.test.ts(7,46): error TS2307: Cannot find module '../src/orders.ts'
packages/db/test/supplier.test.ts(38,31): error TS2339: Property 'id' does not exist on type '{}'
packages/db/test/supplier.test.ts(38,47): error TS2339: Property 'id' does not exist on type '{}'
```

That file was last written by `ad17630 test: capture fake supplier recovery and receipt RED`. It imports `packages/supplier/src/fake.ts` and `packages/db/src/orders.ts`, and neither path exists at `bcf0f4f`; both are uncommitted in the coordinator's working directory. The two `TS2339` errors follow from the unresolved imports. No change here can affect them.

An earlier note in this session recorded two errors rather than four. That figure came from a `tail -2` on the typecheck output and was truncated. Four is the correct inherited count.

## 2. RED evidence, run against the unmodified implementation

Each suite was written first and executed before the corresponding fix.

| Suite | Command | Result |
| --- | --- | --- |
| need-derivation | `node --experimental-strip-types --test packages/need-derivation/test/derive-needs-validation.test.ts` | 10 tests, **0 pass, 10 fail** |
| coverage-target | `node --experimental-strip-types --test packages/coverage-target/test/derive-coverage-target-validation.test.ts` | 8 tests, 3 pass, **5 fail** |
| supplier-performance | `node --experimental-strip-types --test packages/supplier-performance/test/derive-performance-validation.test.ts` | 9 tests, 6 pass, **3 fail** |
| supply-ranking | `node --experimental-strip-types --test packages/supply-ranking/test/supply-ranking-rating.test.ts` | 13 tests, **0 pass, 13 fail** |

The three suites with partial passes contain regression guards that were expected to pass before the change; those assert behaviour that must survive, not behaviour that was missing.

Representative RED assertions:

```
need-derivation   actual: undefined, expected: 'rejected'
                  actual: { needs: [], withheld: [ [Object] ] }
                  expected: { needs: [ [Object] ], withheld: [] }
coverage-target   actual: 'derived',  expected: 'refused'   (x5)
supplier-perf     actual: 'derived',  expected: 'refused'   (x2)
                  actual: 'refused',  expected: 'derived'   (sub-day lead time)
supply-ranking    actual: undefined,  expected: 'ranked' / 'refused'
```

## 3. GREEN evidence, after the fixes

| Suite | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `packages/need-derivation/test/*.test.ts` | 21 | 21 | 0 |
| `packages/coverage-target/test/*.test.ts` | 20 | 20 | 0 |
| `packages/supplier-performance/test/*.test.ts` | 22 | 22 | 0 |
| `packages/supply-ranking/test/*.test.ts` | 26 | 26 | 0 |
| All four together | **89** | **89** | **0** |

Every test that existed at `bcf0f4f` in these packages still passes; the pre-existing suites were edited only where a public type changed, never to weaken an assertion.

## 4. Whole-repository state after the change

| Check | Result | Delta against baseline |
| --- | --- | --- |
| `npm test` | 358 tests, 357 pass, 1 fail | +40 tests, same single inherited failure |
| `npm run typecheck` | fail, 4 errors | unchanged, all inherited |
| `npm run lint` | pass | unchanged |
| `npm audit` | 0 vulnerabilities | unchanged |

The one failing test is the same `schema-generation.test.ts` case as at baseline.

## 5. A real defect found, not merely a missing guard

`supplier-performance` accumulated lead time as fractional days in floating point and then converted the total with `String()`. For a total below `1e-6`, `String()` emits exponential notation, which the exact-decimal parser correctly refuses. The consequence was that an order delivered less than about a tenth of a second after it was placed made the whole derivation return `unreadable_amount`.

The RED run shows it as `actual: 'refused', expected: 'derived'`. Elapsed time is now summed as integer milliseconds and converted once through exact division, and a two-order history with one-millisecond lead times yields `0.00000001157407407407` days at scale 20.

## 6. The ranking policy decision that remains open

The assignment specified that, at the performance comparison step, rates should be compared only when both candidates are rated and the deterministic supplier-identity tiebreaker used otherwise. That rule is not transitive.

Take three offers tied on line total and lead time:

| Offer | Rating | Supplier id |
| --- | --- | --- |
| A | rated 0.5 | `sup-a` |
| B | unrated | `sup-b` |
| C | rated 0.9 | `sup-c` |

`A` before `B` by identity. `B` before `C` by identity. But `C` before `A` by rate. That is a cycle, and `Array.prototype.sort` with a cyclic comparator yields implementation-defined output that depends on input order, which would silently break the permutation stability this package is supposed to guarantee.

Following the instruction's own fallback, mixed-rating comparison is refused rather than shipped. Before sorting, eligible offers are grouped by line total and lead time; if any group holds both a rated and an unrated supplier, `rankEligibleSupply` returns `{ kind: 'refused', reason: 'mixed_rating_comparison' }` naming that group. Groups that are wholly rated or wholly unrated sort normally, so the common case, where price or lead time separates suppliers, is unaffected.

**The open decision belongs to the product, not the code.** Options include ranking unrated suppliers last within a tie, ranking them first to buy information deliberately, or interleaving them at a fixed exploration rate. The third is the only one that addresses the selection-bias problem recorded in `docs/supplier-performance.md`, where a supplier ranked down stops accumulating evidence and can never climb back. Until that is chosen, the refusal makes the gap visible instead of hiding it inside a sort.

## 7. Boundary

No acceptance criterion moves to `PASS`. This is pure-domain work with no database, no API and no client; AC-001 through AC-018 remain `NOT RUN`. Ranking, coverage targets and supplier performance still have no acceptance criterion of their own, which is recorded in their package documents.
