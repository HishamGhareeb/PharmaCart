# Commercial allocation review — test evidence

Branch: `claude/commercial-allocation-review`, based on `04b6a89`
Worktree: isolated at `tmp/claude-commercial-fix`; no other working directory was touched
Date: 2026-09-13
Scope: `packages/supply-ranking` only. No database, Docker, migration, API or root-level change.

Five defects were found in the ranking and allocation domain, all of them in the
same family: the code trusted that an offer list is a set of distinct, independent
things, and none of the five assumptions behind that were checked.

| # | Defect | Where | Answer |
| --- | --- | --- | --- |
| 1 | The same offer listed twice had its stock counted twice | `rankEligibleSupply` | refuse `duplicate_offer` |
| 2 | A negative minimum order quantity disabled the gate it enforces | `assessOffer` | exclude `invalid_minimum_order` |
| 3 | Two standings for one supplier let list order decide eligibility | `rankEligibleSupply` | refuse `duplicate_supplier_standing` |
| 4 | Offers tied through supplier identity ordered by feed order | `SORT_CRITERIA` | add `offer_id` as terminal criterion |
| 5 | Two offers from one supplier had their stock added together | `allocateAcrossSuppliers` | refuse `ambiguous_supplier_stock` |

## 1. Inherited baseline

Unchanged from the previous review and re-confirmed here.

| Check | Result at `04b6a89` | Cause |
| --- | --- | --- |
| `npm test` | 392 tests, 391 pass, **1 fail** | `contracts/test/schema-generation.test.ts`: generated contracts are stale |
| typecheck | **fail, 4 errors** | all in `packages/db/test/supplier.test.ts` |
| lint | pass | |
| `packages/supply-ranking/test/*.test.ts` | 60 tests, 60 pass | |

The four typecheck errors import `packages/supplier/src/fake.ts` and
`packages/db/src/orders.ts`. Neither path exists in this tree — `packages/supplier`
is not a directory and `packages/db/src` holds only `inventory.ts`,
`procurement.ts` and `runtime.ts`. Nothing in this work can affect them, and
`packages/db` is not owned here.

## 2. RED, run against the unmodified implementation

`packages/supply-ranking/test/supply-ranking-stock-identity.test.ts` was written
first and executed before any source change. All five suites failed:

```
✖ an offer repeated in the feed is not stock repeated in the warehouse
✖ a minimum order quantity below zero is malformed, not lenient
✖ two standings for one supplier have no single meaning
✖ offers tied to the last criterion are ordered by offer identity
✖ stock from one supplier cannot be added to itself
```

Fifteen of the suite's twenty-three cases failed, by name:

```
✖ refuses to rank a feed that lists the same offer twice
✖ refuses even when the copies disagree, rather than picking one
✖ refuses to allocate a need against stock counted twice
✖ names the same duplicate whatever order the copies arrive in
✖ excludes an offer whose minimum is negative
✖ never allocates against a negative minimum
✖ refuses rather than letting list order decide
✖ answers the same way whichever standing is listed last
✖ refuses to allocate against an ambiguous standing
✖ refuses a repeat even where the two entries agree
✖ orders two offers from one supplier deterministically
✖ declares offer identity as the terminal criterion of every sort
✖ names offer identity when that is all that separates an offer from the leader
✖ refuses when filling the need would draw on one supplier twice
✖ refuses rather than short-filling from the first offer alone
```

The remaining eight cases passed at RED by design. They are regression guards —
"still ranks distinct offers that merely look alike", "accepts a minimum of zero",
"still splits across offers held by different suppliers" — and assert behaviour
that had to survive the fix rather than behaviour that was missing. A suite where
every case fails cannot tell you whether the fix was too broad.

Representative RED assertions:

```
duplicate offer      actual: 'ranked',     expected: 'refused'
negative minimum     actual: [],           expected: [ { reason: 'invalid_minimum_order' } ]
duplicate standing   actual: 'ranked',     expected: 'refused'
identity tie         actual: ['o-2','o-1'] expected: ['o-1','o-2']
same-supplier stock  actual: 'allocated',  expected: 'refused'
```

The identity-tie failure is the sharpest of the five, because it fails only in one
direction. The companion case, "produces that same order for the opposite feed
order", **passed** at RED — with the offers fed in the other order the stable sort
happened to emit the right answer. One assertion alone would have been read as
working code. The pair is what shows the output was the feed's order, not the
ranking's.

## 3. GREEN, after the fixes

| Suite | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `supply-ranking-stock-identity.test.ts` | 23 | 23 | 0 |
| `packages/supply-ranking/test/*.test.ts` | **83** | **83** | **0** |

Whole repository after the change:

| Check | Result | Delta against baseline |
| --- | --- | --- |
| full test run | 415 tests, 414 pass, 1 fail | +23 tests, same single inherited failure |
| typecheck | fail, 4 errors | unchanged, all inherited, all in `packages/db` |
| lint (`packages/supply-ranking`) | pass, 0 findings | unchanged |

Nothing outside the package imports it. A search for `supply-ranking` and
`allocate-supply` across the tree matches only `package.json`'s test glob and three
documents, so the widened `RankingCriterion`, `ExclusionReason` and
`RankingRefusalReason` unions cannot break a caller. This package is still not
wired to the quote path.

## 4. Pre-existing tests were corrected, not weakened

Three fixtures shared one `offerId` across several suppliers:

```ts
[offer({ supplierId: 'sup-a' }), offer({ supplierId: 'sup-b' })]   // both 'offer-a'
```

Defect 1 makes that input refused, so those cases began failing. The fixtures were
given distinct offer identifiers rather than the duplicate check being narrowed.
Two suppliers cannot share an offer identifier in any real feed; the fixtures were
expressing something unrepresentable, and were the reason defect 4 had gone unseen
— a suite whose offers all carry the same identifier cannot detect that offer
identity was missing from the sort.

The two pins on `RANKING_CRITERIA` and `SORT_CRITERIA.price` were extended with
`offer_id`. No assertion was relaxed, deleted or made conditional.

## 5. Why each answer is a refusal rather than a repair

**A repeated offer is refused, not deduplicated.** When two copies disagree —
different price, different version — keeping either one picks a winner on no
evidence. The second RED case pins that: copies at `'10'` and `'99'` are refused
rather than resolved.

**A negative minimum is excluded, not clamped to zero.** Clamping would be a guess
that happens to be safe; the value is evidence that whatever wrote the field was
wrong, and the rest of that offer's numbers have no more claim to being right.
Zero remains accepted, because zero is the honest way to state no minimum.

**A repeated standing is refused even when the two entries agree.** Distinguishing
an agreeing duplicate from a conflicting one needs structural equality over a type
that will grow fields, and the check would quietly stop working the first time one
was added. A standings list is a lookup keyed by supplier; a list with repeats has
no single meaning regardless of what the repeats say.

**Same-supplier stock is refused at the point of the second draw, not pre-emptively.**
The ambiguity is "may these two figures be added", and that question only arises
when they actually are. Filling 40 from a supplier's first offer touches one pool
and is allowed; filling 100 across both is refused. That keeps the refusal to the
case that genuinely cannot be answered.

The alternative to the last one was a short fill — allocate 60, report 40
unfilled. That is worse than refusing, because it reports a shortage the allocator
invented and puts the blame on a supplier that may hold the stock. `unfilled` is
supposed to mean the market is short, and it would have meant the feed was unclear.

## 6. Determinism is now a property of the comparator

Before this change `compareEligibleOffers` returned `0` for two distinct offers
held by one supplier, and the result depended on `Array.prototype.sort` stability
and therefore on feed order. With `offer_id` terminal in every precedence, and
duplicate identifiers refused before the sort runs, the comparator returns `0`
only for an offer against itself. Permutation stability is no longer a property
that happens to hold for the fixtures in use; it holds for any input the function
accepts.

Duplicates are reported by smallest repeated identifier rather than by first
occurrence, so two permutations of the same malformed feed name the same record.
Three of the new cases assert the whole result is `deepEqual` across a reversed
input, which is a stronger claim than asserting the order of the ranked list.

## 7. Boundary

No acceptance criterion moves. This is pure-domain work with no database, no API
and no client; AC-001 through AC-018 remain `NOT RUN`. Ranking and allocation
still have no acceptance criterion of their own.

Two things are named here and deliberately not solved.

**`ambiguous_supplier_stock` is a refusal, not a feature.** The real fix is for an
offer to state which stock pool it draws on, so two offers from one supplier can
be added when they are genuinely separate and rejected when they are not. That is
a feed schema change and it is not owned here. Until it exists, a supplier listing
one product twice cannot take part in a split, which is a real capability cost
recorded rather than hidden.

**The mixed rated/unrated ranking policy remains open**, unchanged from
`docs/testing/commercial-policy-hardening.md` §6.
