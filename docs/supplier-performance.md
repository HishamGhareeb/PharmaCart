# PharmaCart supplier performance derivation

Status: implemented, unit-tested, not reading order history from anywhere
Scope: turning completed orders into the fulfilment rate and lead time that ranking and coverage targets currently take on faith
Source input: *PharmaCart Builder Master Plan*, sections 19 to 21

Two packages consume numbers they do not compute. `supply-ranking` takes a fulfilment rate on the supplier standing and ranks by it. `coverage-target` takes a lead time and multiplies every target by it. Both are supplied by whoever calls them, which means both are currently guesses.

This package derives them from order history, and spends most of its effort on what not to count.

## 1. An unknown outcome is not a failure

The order path already treats "outcome unknown" as a first-class state: the submission may or may not have reached the supplier, and reconciliation has not yet said which. Scoring those orders is the tempting mistake.

Counting an unknown outcome as a failure punishes a supplier for our lost acknowledgement, and a neutral ranking that quietly penalises suppliers for our own infrastructure faults is not neutral. Counting it as a success hides a real failure. Both are worse than excluding it, so unknown-outcome orders are removed from the sample and their count is reported, and an operator can see the estimate rests on fewer orders than were placed.

Orders the pharmacy cancelled are excluded for the same reason: the supplier did nothing wrong. A supplier rejection is not excluded. That is a fulfilment failure and it counts as nothing delivered.

Short deliveries count proportionally rather than as a pass or a fail, because eight boxes of ten is a materially different outcome from zero and from ten.

## 2. A sample floor, because one good order is not excellence

A supplier with a single completed order that went well has a fulfilment rate of one. Published into a ranking that sorts on merit, that puts an unmeasured supplier at the top on the strength of one data point.

Derivation refuses below a declared minimum of completed orders rather than emitting a rate, and callers must treat the refusal as unrated rather than substituting a default. A default of one repeats the bug; a default of zero makes a new supplier unorderable and freezes the incumbent in place.

## 3. Lead time knows when it is understated

Orders still in flight are excluded from the lead-time average, which biases the result downward. Fast orders complete first and are counted; slow ones are still outstanding and are not. Measuring only what has finished always makes a supplier look quicker than it is.

Rather than pretend otherwise, the derivation compares the longest outstanding order against the average it just computed. If something has already been waiting longer than the supplier's supposed lead time, `leadTimeUnderstated` is set. The estimate is a lower bound and says so.

Doing this properly is survival analysis, which is out of scope here. Detecting the bias is cheap, honest, and enough to stop a target being scaled by a number nobody flagged.

## 4. Boundary

No acceptance criterion covers this, which is now the third such package alongside ranking and coverage targets. Everything deciding how much a pharmacy spends and who it buys from sits outside AC-001 to AC-018.

Nothing reads order history. The derivation takes records as arguments and takes `asOf` as an argument rather than reading a clock, so it is deterministic and testable, and whoever calls it must pass a consistent view.

Three limits are real. There is no recency weighting, so a supplier that was unreliable a year ago and dependable since carries its old record at full weight forever. There is no seasonality, so a distributor that struggles only in one month looks mildly bad all year. And the deepest issue is selection: fulfilment is only observed for orders actually placed, and orders are placed with suppliers already favoured, so a supplier ranked down stops accumulating evidence and cannot climb back. A ranking that feeds its own inputs needs deliberate exploration, and nothing here provides it.

## 5. Public types, as of the commercial policy hardening

`PerformanceRefusalReason` gains `negative_quantity` and `delivered_exceeds_ordered`.

Every record is validated before any of them are excluded, so a malformed order can no longer hide behind an outcome that would have dropped it unread. A negative ordered quantity on an unknown-outcome order is now a refusal, where previously the exclusion ran first and the defect was never seen.

```ts
// refused: 'negative_quantity', even though this outcome is excluded from scoring
{ orderId: 'o-3', orderedQuantity: '-5', outcome: { kind: 'unknown' } }
// refused: 'delivered_exceeds_ordered'
{ orderedQuantity: '10', outcome: { kind: 'delivered', deliveredQuantity: '11', deliveredAt } }
```

Elapsed time now accumulates as integer milliseconds and converts to days once, through exact division. This fixes a real defect rather than adding a guard: the previous code summed fractional days in floating point and rendered the total with `String()`, which emits exponential notation below `1e-6`, and the exact-decimal parser correctly refused it. An order delivered less than a tenth of a second after placement therefore failed the whole derivation with `unreadable_amount`.

The understated-lead-time comparison is likewise exact, comparing the longest outstanding elapsed time against the mean without dividing.
