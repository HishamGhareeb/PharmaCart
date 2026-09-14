# PharmaCart neutral supply ranking

Status: implemented, unit-tested, not called by the quote path
Scope: deciding which eligible suppliers can fulfil a need line, in what order, and being able to say why
Source input: *PharmaCart Builder Master Plan*, sections 19 and 20; the neutrality and disclosed-sponsorship commitment

`packages/supply-ranking` answers the question the quote command currently assumes has already been answered. `QuoteCommand` in `packages/db/src/procurement.ts` takes `constraints.supplierIds`, so something upstream must decide which suppliers belong in that list. This package is that decision, kept pure and separate from pricing and persistence.

It is not an optimiser. It ranks whole-line fulfilment by a single supplier and does not split a line across several, which is a different problem with different failure modes.

## 1. Neutrality has to be a property, not a promise

The plan commits to neutral ranking with disclosed sponsorship. That is only meaningful if sponsorship provably cannot move an offer up the list.

So `sponsored` is carried into the result as a disclosure and takes no part in the sort. The ordering reads only `RANKING_CRITERIA`, in that order: line total, lead time, fulfilment rate, then supplier identity and offer identity as deterministic tiebreaks. Two tests pin it. Flipping which of two otherwise identical offers is sponsored leaves the order unchanged, and a sponsored offer at a higher price stays below a cheaper one.

A ranking that let a paid placement outrank a cheaper or faster offer would not be neutral whatever it was called. Writing the criteria as an exported, ordered list makes the claim auditable rather than rhetorical, and the same list drives the explanation below.

## 2. Explainability falls out of the ordering

Every ranked offer carries the values that placed it: line total, lead time, fulfilment rate, and whether it is sponsored. It also carries `differsFromLeaderAt`, the first criterion on which it parts from the top-ranked offer, or null when it is the leader or ties on everything.

That is a complete explanation of placement without prose. An offer ranked third because it costs more says `line_total`; one ranked second only because it takes a week longer says `lead_time_days`. A purchaser can see which lever moved, and an auditor can recompute it.

## 3. Exclusion is named, never silent

Eligibility is a hard gate evaluated before any ordering, and every excluded offer is returned with a reason rather than dropped: no supplier standing, inactive relationship, terms not accepted, product mismatch, unit mismatch, unreadable amount, insufficient stock, below minimum order, invalid minimum order.

Malformed input is refused outright rather than excluded per offer, because it makes the whole list untrustworthy rather than one row ineligible: `duplicate_offer` for a repeated offer identifier and `duplicate_supplier_standing` for a repeated supplier standing. Section 9 covers both.

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
  | { kind: 'refused'; reason: RankingRefusalReason; detail: string }

type RankingRefusalReason =
  | 'invalid_need' | 'invalid_filter' | 'duplicate_offer'
  | 'duplicate_supplier_standing' | 'mixed_rating_comparison'
  | 'recommended_sort_undefined'
```

`ExclusionReason` gains `negative_price`, `invalid_lead_time` and `invalid_rating`. A need whose quantity is not a positive exact decimal is refused as `invalid_need`, since nothing can be priced against it.

### Mixed rated and unrated comparison is refused, and why

Comparing rates only when both candidates are rated, and otherwise falling back to supplier identity, is not transitive. Given three offers tied on line total and lead time where A is rated 0.5, B is unrated and C is rated 0.9, identity orders A before B and B before C while rate orders C before A. A sort built on a cyclic comparator is input-order dependent, which would destroy the permutation stability this package guarantees.

Before sorting, eligible offers are grouped by line total and lead time. If any group holds both a rated and an unrated supplier, the ranking refuses with `mixed_rating_comparison` and names the group. Groups that are wholly rated or wholly unrated sort normally, so the ordinary case, where price or lead time separates suppliers, is unaffected.

**This leaves a product decision open.** Unrated suppliers could rank last within a tie, first as deliberate information buying, or be interleaved at a fixed exploration rate. Only the last addresses the selection bias recorded in `docs/supplier-performance.md`, where a supplier ranked down stops accumulating evidence and can never climb back. The refusal makes the gap visible rather than hiding it inside a sort.

## 7. Sort modes and filters

The pharmacy chooses how its own supply is ordered. `rankEligibleSupply` takes an optional fourth argument:

```ts
rankEligibleSupply(need, offers, standings, {
  sortMode: 'price' | 'lead_time' | 'rating' | 'available_quantity' | 'recommended',
  filters: { maxLeadTimeDays?, maxUnitPrice?, minFulfilmentRate?, minAvailableQuantity?, excludeSponsored? },
})
```

Omitting it sorts by price, which is what the package did before modes existed. Each mode is a declared precedence exported as `SORT_CRITERIA`, so a screen can show what it sorted by rather than asserting that it was fair. Sponsorship appears in none of them.

**A pharmacist-chosen sort does not threaten neutrality; a platform-chosen default is where neutrality is won or lost.** That is why `recommended` is refused as `recommended_sort_undefined` rather than implemented. Its weights would encode a position on what makes a good supplier, and a default that a supplier can pay to influence is the exact mechanism a marketplace uses to sell placement. If it is built, three properties keep the claim intact: the weights are shown on screen, sponsorship is never an input, and the weights are identical for every pharmacy.

**Filtering is not exclusion and is reported separately.** An offer removed by the pharmacy's own ceiling appears in `filtered` with a `filtered_*` reason; an offer that was never eligible appears in `excluded` with its eligibility reason. A purchaser can then tell "your price cap removed two" from "two suppliers cannot sell you this at all", which are different problems with different fixes. Eligibility is evaluated first, so an ineligible offer is never reported as merely filtered.

`minFulfilmentRate` removes unrated suppliers along with low-rated ones, since an unrated supplier cannot meet a floor. That is a filter decision, not the ranking-policy decision, and it does not presume where unrated suppliers would sort.

### Available quantity is the weakest criterion here

Sorting by it ranks headroom, not capability: eligibility already refuses any offer that cannot cover the whole line, so every ranked offer can already fill the order.

More importantly it is the only criterion the supplier states and nobody verifies. A price is checked against the invoice and a lead time against the delivery, but stated availability is confirmed only once an order is placed, so inflating it is free and sorts the inflater to the top. Fulfilment rate catches that eventually, and only after a pharmacy has been let down. Prefer `minAvailableQuantity` as a filter over `available_quantity` as a primary sort, and treat a supplier whose stated availability never matches what arrives as a fulfilment problem rather than a ranking one.

### What this still does not do

Ranking assumes one supplier fills the whole line. When no single supplier holds enough, every offer is excluded as `insufficient_stock` and the pharmacy is told nothing is available, even where two suppliers together could cover it comfortably. Splitting a line across suppliers is a different problem with its own failure modes, and it is unbuilt.

## 8. Filling one need from several suppliers

`allocateAcrossSuppliers` closes the gap the sort modes exposed. Under the whole-line rule, a need of 100 boxes against suppliers holding 60, 50 and 30 excludes all three as `insufficient_stock` and tells the pharmacy nothing is available, when any two of them together cover it comfortably.

```ts
const result = allocateAcrossSuppliers(need, offers, standings, { sortMode: 'price' })
// { kind: 'allocated', allocation: { lines: [ { supplierId: 'sup-a', quantity: '60' },
//                                             { supplierId: 'sup-b', quantity: '40' } ],
//                                    allocated: '100', unfilled: '0', complete: true } }
```

Splitting stays a deliberate call rather than an automatic fallback, because each extra supplier is another delivery, another invoice and another relationship. `rankEligibleSupply` keeps its whole-line default; the allocator asks for `coverage: 'partial'`, which admits any supplier that can contribute something rather than only those that can cover everything.

**Allocation is greedy in whatever order the ranking produced.** It inherits the pharmacy's own choice of what to optimise and stays explainable: each supplier is offered as much as it can still usefully contribute, in rank order, until the need is met. Sorted by price with no binding minimum order quantities that is also the cheapest achievable split, since the cheapest units are taken first. Where a minimum order quantity binds it is explainable but not provably optimal, and it makes no attempt to minimise how many suppliers are involved.

**A short fill is stated, never disguised.** `allocated`, `unfilled` and `complete` are all reported, because an allocation that quietly ordered what it could find would look identical to one that succeeded. Two reasons a supplier contributes nothing are distinguished: `need_already_met` for one the allocator never had to reach, and `remainder_below_minimum` for one whose remaining share fell under its own minimum order quantity. Neither is an exclusion, because both offers were perfectly eligible.

**A split arrives when its slowest supplier arrives.** `effectiveLeadTimeDays` reports the maximum across allocated lines rather than the leader's, so a cheap split cannot quietly cost a week nobody agreed to. Sorting by lead time instead of price buys a faster split at a higher total, and the two results make that trade visible rather than assumed.

### Still open

The allocator never over-orders to satisfy a minimum order quantity, so a supplier whose minimum exceeds the remaining need is skipped and the shortfall is reported. Rounding a line up to reach a minimum would fill the need but spend money on stock nobody asked for, which is a purchasing decision rather than an allocation one.

It also has no notion of a per-delivery cost. Once suppliers charge for delivery, a two-supplier split may cost more than a single more expensive supplier, and the greedy rule cannot see that.

## 9. Offer identity, and the stock arithmetic that rests on it

Splitting a line made an assumption the earlier whole-line rule never had to: that each offer's `availableQuantity` is stock no other offer already counts. Ranking one supplier per line never adds two stock figures together, so nothing checked that adding them was sound. Five gaps followed from that, and all five are now closed. Test evidence is in `docs/testing/commercial-allocation-review.md`.

**A repeated offer is a repeated row, not repeated stock.** A feed listing one offer twice had its availability counted once per copy, so a need for 100 boxes was reported filled from a single 60-box pool. `rankEligibleSupply` refuses with `duplicate_offer` rather than deduplicating, because two copies that disagree on price or version give no basis for choosing which is authoritative.

**Two standings for one supplier are refused.** The lookup was built with `new Map(...)`, where the last entry silently wins. An active standing and a revoked one for the same supplier gave opposite answers depending on list order. `duplicate_supplier_standing` is refused even when the two entries agree, because a standings list is a lookup keyed by supplier and a list with repeats has no single meaning.

**A minimum order quantity below zero is malformed, not lenient.** Read literally it satisfies every check that exists to enforce it, so the offer passed the gate and `below_minimum_order` became unreachable. It is now excluded as `invalid_minimum_order`. A minimum of zero is still accepted, since that is the honest way to say there is no minimum.

**Offer identity is the terminal criterion of every sort.** Supplier identity cannot separate two offers held by one supplier, so a pair tied through it compared equal and their relative order was whatever the feed emitted. Every precedence in `SORT_CRITERIA` now ends `supplier_id, offer_id`, and `RANKING_CRITERIA` names it. Since duplicate identifiers are refused before the sort runs, the comparator returns zero only for an offer against itself, which makes each precedence a total order. Permutation stability was previously a property that held for the fixtures in use; it now holds for any input the function accepts.

### Stock from one supplier cannot be added to itself

Two offers from one supplier for one product may be two stock pools or one pool described twice. Nothing in the feed distinguishes them, so the allocator refuses with `ambiguous_supplier_stock` rather than summing.

The refusal is raised at the point of the second draw, not pre-emptively, because the ambiguity is the question "may these two figures be added" and that only arises when they actually are. A need of 40 filled from one of the two offers touches a single pool and allocates normally; a need of 100 spanning both is refused.

The alternative was a short fill: allocate what the first offer holds and report the rest unfilled. That is worse than refusing. `unfilled` is supposed to mean the market is short, and it would instead have meant the feed was unclear — a shortage the allocator invented, reported against a supplier that may well hold the stock.

**This is a refusal, not a resolution.** The real fix is for an offer to name the stock pool it draws on, so genuinely separate pools can be added and re-descriptions of one pool cannot. That is a feed schema change owned elsewhere. Until it exists, a supplier listing the same product twice cannot take part in a split, which is a real capability cost and is recorded here rather than hidden behind a number that looks like an answer.
