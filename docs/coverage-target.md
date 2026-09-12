# PharmaCart coverage target derivation (B1)

Status: implemented, unit-tested, not reading history from anywhere
Scope: turning a history of stock observations into the target quantity a branch should hold, and refusing when the history cannot carry that weight
Source input: *PharmaCart Builder Master Plan*, sections 16 and 21

`packages/need-derivation` takes a coverage target as given, and its own boundary section called deriving one from consumption the obvious next thing and a place where a wrong model quietly costs money in both directions. This is that step.

It is the most opinionated package in the set, because a target is a forecast and a forecast is a judgement. The design bias throughout is to refuse rather than to produce a number nobody should trust.

## 1. Consumption is not the fall in stock

Stock falls when things are sold and rises when things are delivered, so consumption over an interval is the opening stock plus everything received during it, minus the closing stock.

Omitting receipts turns every delivery into apparent negative demand. A pharmacy that received fifty boxes mid-interval and ended higher than it started would look like it consumed nothing, and the derived target would collapse toward zero on the products that move fastest.

If consumption still comes out negative after receipts are added back, stock appeared that nobody recorded. That is a data defect, not a demand signal, and it is refused as `negative_consumption` rather than clamped to zero.

## 2. A stockout censors demand, it does not measure it

This is the point of the package.

Once a shelf is empty the pharmacy stops selling because it has nothing left, not because nobody wanted any. The fall in stock across such an interval is a lower bound on demand, not a reading of it. Average those intervals in and the rate comes out too low, the target too small, and the shelf empties again, which produces more censored intervals and drives the estimate down further. The error compounds in the direction of the failure it is supposed to prevent.

Intervals that began or ended empty are therefore excluded from the rate and counted separately. The test that matters compares the two answers on one history: using only clean intervals gives a daily rate of eight, while averaging everything gives three and a third. A system built the naive way would have set a target less than half of what the branch actually needs.

When every interval is censored there is no usable signal at all, and the derivation refuses rather than returning the lower bound as if it were an estimate.

Censoring is detected from the endpoints, which is what the data supports. A branch that ran out and was restocked entirely between two observations is invisible here, and that limitation is real rather than theoretical for a weekly feed.

## 3. The rate and the target

The target is the daily rate multiplied by the days it must cover: lead time plus review period plus a declared safety margin. Safety stock is expressed in days rather than derived from demand variability, because a statistical safety stock needs a square root and a distributional assumption, and neither belongs in exact decimal arithmetic or in a model nobody has validated on this market.

Division cannot be exact, so the scale is declared by the caller and the remainder rounds half away from zero. The final target rounds up to a whole unit, since part of a box cannot be ordered and rounding a target down is the same error as censoring.

Every derivation reports the daily rate, the observed days, the coverage days, and how many intervals were used and censored. A target that cannot be argued with is a target that gets overridden by a spreadsheet.

## 4. Boundary

No acceptance criterion covers this, which matches the ranking package and is worth the same note: two of the things that decide how much a pharmacy spends have no gate in front of them.

Nothing reads history from the database. The derivation takes observations and receipts as arguments, and whoever loads them must take both from one consistent view, because a receipt missing from the window it belongs to shows up as negative consumption and refuses the whole product.

The model is deliberately crude. It assumes demand is roughly stationary over the observed window, which is wrong for seasonal products, for a branch that has just opened, and around Ramadan, when Egyptian pharmacy demand shifts in ways a flat average will not see. It has no trend term, no seasonality, and no outlier handling, so one unusual fortnight moves the target and stays in it.

Safety days, lead time and review period are all supplied rather than learned, and lead time in particular is knowable from the order history once orders exist. Until then a wrong lead time silently scales every target.

## 5. Public types, as of the commercial policy hardening

`CoverageRefusalReason` gains `invalid_receipt_time` and `negative_quantity`.

Every observation and every receipt is validated before any interval is used or censored. A receipt whose timestamp cannot be read is now a named refusal rather than a silent skip, and a malformed quantity is caught even when the receipt falls outside every observation window, where the old window filter would have discarded it unread.

```ts
deriveCoverageTarget('SKU-1', observations, [{ receivedAt: 'not-a-time', quantity: '10', unit: 'box' }], policy)
// { kind: 'refused', reason: 'invalid_receipt_time' }
```

The policy is validated as a whole rather than field by field. Each of lead time, review period and safety days must be a non-negative safe integer no greater than 3650, and their sum must also be a positive safe integer no greater than 3650. Two individually valid values that overflow when added are refused as `invalid_policy`.
