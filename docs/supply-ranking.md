# PharmaCart neutral supply ranking

Status: implemented, unit-tested, not called by the quote path
Scope: deciding which eligible suppliers can fulfil a need line, in what order, and being able to say why
Source input: *PharmaCart Builder Master Plan*, sections 19 and 20; the neutrality and disclosed-sponsorship commitment

`packages/supply-ranking` answers the question the quote command currently assumes has already been answered. `QuoteCommand` in `packages/db/src/procurement.ts` takes `constraints.supplierIds`, so something upstream must decide which suppliers belong in that list. This package is that decision, kept pure and separate from pricing and persistence.

It is not an optimiser. It ranks whole-line fulfilment by a single supplier and does not split a line across several, which is a different problem with different failure modes.

## 1. Neutrality has to be a property, not a promise

The plan commits to neutral ranking with disclosed sponsorship. That is only meaningful if sponsorship provably cannot move an offer up the list.

So `sponsored` is carried into the result as a disclosure and takes no part in the sort. The ordering reads only `RANKING_CRITERIA`, in that order: line total, lead time, fulfilment rate, then supplier identity as a deterministic tiebreak. Two tests pin it. Flipping which of two otherwise identical offers is sponsored leaves the order unchanged, and a sponsored offer at a higher price stays below a cheaper one.

A ranking that let a paid placement outrank a cheaper or faster offer would not be neutral whatever it was called. Writing the criteria as an exported, ordered list makes the claim auditable rather than rhetorical, and the same list drives the explanation below.

## 2. Explainability falls out of the ordering

Every ranked offer carries the values that placed it: line total, lead time, fulfilment rate, and whether it is sponsored. It also carries `differsFromLeaderAt`, the first criterion on which it parts from the top-ranked offer, or null when it is the leader or ties on everything.

That is a complete explanation of placement without prose. An offer ranked third because it costs more says `line_total`; one ranked second only because it takes a week longer says `lead_time_days`. A purchaser can see which lever moved, and an auditor can recompute it.

## 3. Exclusion is named, never silent

Eligibility is a hard gate evaluated before any ordering, and every excluded offer is returned with a reason rather than dropped: no supplier standing, inactive relationship, terms not accepted, product mismatch, unit mismatch, unreadable amount, insufficient stock, below minimum order.

Unit mismatch is an exclusion rather than a conversion, matching the rule the transport adapters follow. Converting boxes to strips changes purchase meaning and needs a versioned pack agreement that does not exist.

When nothing qualifies the result is an empty ranking, never a relaxed second pass. A procurement system that quietly loosens its own gates to return something is worse than one that returns nothing, because the caller cannot tell which happened.

## 4. Money never touches a float

`exact-decimal.ts` carries values as BigInt mantissas with an explicit scale. Comparison aligns scales before comparing; multiplication multiplies mantissas and sums scales, then canonicalises by stripping redundant zeros.

This is not defensive decoration. `0.1` multiplied by `0.2` is `0.02` here and `0.020000000000000004` through a double, and `9007199254740993` and `9007199254740994` are indistinguishable once either passes through one. Line totals and stock comparisons both run through it, so no ordering decision is ever made on a rounded value.

An operand that cannot be read exactly returns undefined rather than a guess, and the ranking turns that into an `unreadable_amount` exclusion. Sorting an unreadable price arbitrarily is how the wrong supplier wins.

## 5. Boundary

No acceptance criterion covers this. Ranking is not among AC-001 to AC-018, which is itself worth noting: the plan's stated differentiator has no acceptance test behind it. If neutrality is a commercial promise, it deserves one.

Nothing calls this yet. Wiring it to produce `constraints.supplierIds` for the quote command is the obvious next step and touches the procurement path, which is codex's.

The ranking criteria are hard-coded in a fixed order. Making them configurable per pharmacy would be a real feature and a real hazard, since a configurable ranking is one a sponsor can lobby to reshape; any such change should keep the criteria list exported and disclosed.

Fulfilment rate is taken as given on the supplier standing. Nothing here computes it, and a rate derived from too few orders would rank a new supplier on noise. Whatever populates it needs a confidence floor.

Finally, the whole package assumes several connected suppliers with comparable offers for the same product. That assumption is commercial, not technical, and it is currently unmet.

## 6. Public types, as of the commercial policy hardening

Performance is now a state rather than a number, so an unrated supplier never receives a manufactured rate:

```ts
type SupplierPerformanceRating =
  | { kind: 'rated'; fulfilmentRate: string }
  | { kind: 'unrated' }

type SupplierStanding = {
  supplierId: string
  relationshipStatus: 'active' | 'suspended' | 'revoked'
  acceptedTermsVersion: number
  performance: SupplierPerformanceRating
}
```

`rankEligibleSupply` returns a discriminated union, and the ranking discloses `unratedCount` alongside `sponsoredCount`:

```ts
type SupplyRankingResult =
  | { kind: 'ranked'; ranking: SupplyRanking }
  | { kind: 'refused'; reason: 'invalid_need' | 'mixed_rating_comparison'; detail: string }
```

`ExclusionReason` gains `negative_price`, `invalid_lead_time` and `invalid_rating`. A need whose quantity is not a positive exact decimal is refused as `invalid_need`, since nothing can be priced against it.

### Mixed rated and unrated comparison is refused, and why

Comparing rates only when both candidates are rated, and otherwise falling back to supplier identity, is not transitive. Given three offers tied on line total and lead time where A is rated 0.5, B is unrated and C is rated 0.9, identity orders A before B and B before C while rate orders C before A. A sort built on a cyclic comparator is input-order dependent, which would destroy the permutation stability this package guarantees.

Before sorting, eligible offers are grouped by line total and lead time. If any group holds both a rated and an unrated supplier, the ranking refuses with `mixed_rating_comparison` and names the group. Groups that are wholly rated or wholly unrated sort normally, so the ordinary case, where price or lead time separates suppliers, is unaffected.

**This leaves a product decision open.** Unrated suppliers could rank last within a tie, first as deliberate information buying, or be interleaved at a fixed exploration rate. Only the last addresses the selection bias recorded in `docs/supplier-performance.md`, where a supplier ranked down stops accumulating evidence and can never climb back. The refusal makes the gap visible rather than hiding it inside a sort.
