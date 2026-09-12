# PharmaCart need derivation (B1)

Status: implemented, unit-tested, not reading from the database
Scope: turning an inventory projection and a coverage target into the shortages worth buying, and refusing to guess the rest
Source input: *PharmaCart Builder Master Plan*, sections 16 and 21; acceptance criterion AC-004

The schema already carries both halves of this. Migration 0006 adds `inventory_target` with a target quantity per source code, and a `need` table exists that quotes reference by identity and version. Nothing derives one from the other. `packages/need-derivation` is that step: the first sentence of the product, where a pharmacy hitting a shortage becomes something the system can act on.

## 1. Three numbers, and the third is the one people forget

A shortfall is the target minus what is held, and what is held is on-hand **plus what is already on order**.

Omitting open commitments is the classic double-order bug. A pharmacy orders twenty boxes on Monday, the stock feed still shows five on Tuesday because nothing has arrived, and a system that compares target against on-hand alone orders twenty more. By the time both land, the pharmacy has paid for forty boxes of something it needed twenty of, and the money is gone from a working-capital position that was tight enough to make the shortage matter in the first place.

Commitments are summed per source code and subtracted before the comparison, and a need reports on-hand, on-order and target alongside the shortfall so the arithmetic can be shown rather than recomputed.

## 2. Two absences that are not zero

This is where the safety line sits, and it is the same line AC-004 draws.

**A product with no observation is unknown, not empty.** If the feed did not carry a row for a product, that may mean the shelf is bare or it may mean the export omitted it. Reading absence as zero orders a full target of something that might be fully stocked. The derivation withholds it as `no_observation` instead.

**A stale observation is not current stock.** The inventory reducer marks projection rows stale when a newer snapshot has begun but not completed. Ordering against stock known to be out of date is how a pharmacy over-buys, so a stale row is withheld rather than acted on.

Neither is silently dropped. Both appear in `withheld` with a reason, so a human can see that the system wanted to look at a product and could not, which is a different message from the system having looked and found nothing wrong.

## 3. Withholding is the default, and it is explained

Every target resolves to either a need or a withholding reason, and the reasons are named: no observation, stale observation, unit mismatch, unreadable amount, covered.

Unit mismatch is a withholding rather than a conversion, matching the rule the transport adapters and the ranking already follow. A target in boxes and an observation in strips cannot be compared without a versioned pack agreement, and inventing one here would quietly change how much gets bought.

Every quantity goes through exact decimal arithmetic. A target of `0.6` against on-hand `0.1` and on-order `0.2` gives a shortfall of exactly `0.3`, where a float path gives `0.29999999999999993`. Anything unreadable is withheld rather than coerced.

Output is sorted by source code, so the same inputs always produce the same needs in the same order and a diff between two runs means something changed.

## 4. Boundary

AC-004 remains NOT RUN. The criterion requires a snapshot integration test that stages a completed snapshot, ingests one partition without completion, and asserts projection quantity and freshness through a real database. This package consumes a projection rather than producing one; it honours staleness, it does not compute it.

Nothing reads `inventory_target` or writes `need`. The derivation is pure and takes its three inputs as arguments, so whatever calls it must load the targets, the projection and the open commitments from the same consistent snapshot. Reading them from three separate transactions would reintroduce the double-order bug this package exists to prevent.

What counts as an open commitment is also left to the caller, and the definition matters more than it looks. An order submitted but not acknowledged, an order acknowledged but not delivered, and an order whose outcome is unknown are three different states, and only the last is genuinely ambiguous. Treating an unknown-outcome order as not committed will double-order; treating it as committed will under-order. The order path already models that state, and the caller must decide deliberately rather than by accident.

Finally, coverage targets are taken as given. Nothing here derives a target from consumption history, which is the obvious next thing and a place where a wrong model quietly costs money in both directions.

## 5. Public types, as of the commercial policy hardening

`deriveNeeds` now returns a discriminated union. Ambiguous input is rejected outright rather than resolved, because a source code appearing twice among positions has no single on-hand quantity and silently keeping the last arrival would make the answer depend on row order.

```ts
type NeedDerivation =
  | { kind: 'derived'; needs: readonly DerivedNeed[]; withheld: readonly WithheldPosition[] }
  | { kind: 'rejected'; reason: 'duplicate_target' | 'duplicate_position' | 'duplicate_commitment'; sourceCode: string }

const result = deriveNeeds(targets, positions, commitments)
if (result.kind === 'rejected') { /* an input defect, not a stock condition */ }
```

`OpenCommitment` now carries a required `commitmentId`, so two records claiming one identity are rejected while two genuinely distinct orders for the same product still sum:

```ts
{ commitmentId: 'ord-91', sourceCode: 'SKU-1', quantity: '6', unit: 'box' }
```

`WithholdingReason` gains `negative_quantity`, raised when a target, an on-hand figure or a commitment is below zero. It stays a withholding rather than a rejection because it spoils one product, not the whole input.

**What counts as an open commitment is still the caller's decision and is deliberately not encoded here.** An order submitted but unacknowledged, one acknowledged but undelivered, and one whose outcome is unknown are three different states. Passing unknown-outcome orders as commitments under-orders; omitting them double-orders. The caller passes the commitments it means.
