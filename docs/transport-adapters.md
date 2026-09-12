# PharmaCart transport adapters and equivalence (B4)

Status: implemented, unit-tested, not yet wired into ingestion
Scope: the versioned adapter layer that turns transport-specific inventory input into one canonical snapshot event
Source input: *PharmaCart Builder Master Plan*, sections 16 to 18 and 34; acceptance criterion AC-015

`packages/transport-adapters` is the middle layer of the three-layer connector model. Transports read bytes or rows, the adapter normalises them against a declared contract, and the domain receives a canonical `InventorySnapshotEvent`. It depends on `packages/transport-safety` for field guarding and on `packages/contracts` for decimal validity. It performs no I/O and imports no vendor code.

## 1. Why equivalence is a design property, not a test result

AC-015 requires that equivalent stock expressed through every supported transport yields the same canonical projection. The cheap way to pursue that is to implement a mapping per transport and then test that the three agree. That is a trap: three independent mappings agree until one is edited, and the test only proves agreement on the fixtures written that day.

This package instead makes the three transports structurally incapable of disagreeing. Each transport does one narrow job, extracting `{ sourceCode, quantity, unit }` triples in their original spelling, and every transport then passes them through the same `adaptInventoryObservations`. Normalisation, validation, ordering and event construction exist once. Equivalence follows from convergence, and the cross-transport suite verifies that the convergence is real rather than establishing it.

## 2. The canonical decimal problem

The contract's canonical decimal grammar forbids redundant zeros, so `12.500` is not a canonical string and `12.5` is. This is the single largest source of accidental transport disagreement, because the same stock position is legitimately written `12.5` by an API, `12.5000` by a numeric database column, and `12.500` by a spreadsheet export.

`canonicaliseDecimal` resolves that at the string level. It strips leading zeros from the whole part and trailing zeros from the fraction, collapses every spelling of zero including `-0.000`, and accepts the unambiguous shorthand `.5` and `12.` that spreadsheet exports produce. It never converts through a number, so `1234567890123456789012345.000000001` survives intact where any floating-point path would destroy it.

It refuses what cannot be read safely: thousands separators, spaces, a leading `+`, exponent notation and hexadecimal. Grouping separators matter most here. `1,234` is one thousand two hundred and thirty four in one locale and slightly over one in another, and a procurement system that guesses is a procurement system that orders the wrong quantity. Every accepted result is re-checked against the contract validator before it is returned.

## 3. Declared contracts, never inferred rules

`InventoryAdapterContract` carries an adapter identity, a revision, a source-code normalisation mode, and a unit alias table. Nothing about a vendor's data is inferred.

Source codes are opaque identifiers, so the contract must name the normalisation explicitly. `exact` preserves the string exactly as the vendor sent it, `trim` removes surrounding whitespace, and `trim_upper` also folds case. Leading zeros are never stripped from a source code under any mode, because `007` and `7` are different products in a catalogue even though they are the same number.

Units resolve only through the declared alias table, matched case-insensitively after trimming. An unrecognised token is refused rather than guessed. The adapter normalises the unit label and never converts a quantity between units, because box-to-strip conversion changes purchase meaning and requires a versioned agreement that does not exist yet. A feed that reports boxes produces an event that says boxes.

Rows are sorted by normalised source code before the event is built, so transport row order cannot change the event. Duplicate source codes are detected after normalisation, which catches the collision where `sku-1` and `SKU-1` are distinct in a file and identical under `trim_upper`.

## 4. The three transports

**JSON API.** Canonical field names, because this is the surface PharmaCart defines rather than one a vendor imposes. A JSON number is refused outright, including an integer, since the contract states that quantities cross the boundary as strings.

**On-premise database view.** A vendor column map, with unmapped columns ignored. String values pass through. A `number` is accepted only when it is a safe integer, converted with `String`, which is lossless and covers the ordinary case of an integer stock column. A fractional number is refused, which forces the operator to expose the column as text or as a numeric type the driver returns as a string. That is deliberate friction in exchange for never rounding a quantity.

**Delimited file.** Bytes in, not a string, so encoding is settled at the edge. UTF-8 is decoded strictly, a byte order mark is stripped, and the parser follows RFC 4180 for quoted fields containing delimiters, newlines and doubled quotes. The delimiter is configurable for tab-separated exports. Header names are matched by the same column map as the database view, so column order in the file is irrelevant. Ragged rows are refused rather than padded, since a short row means a misaligned value rather than a missing one. Every data cell passes through the spreadsheet guard from `packages/transport-safety` at the parse edge, so a formula payload is refused before the adapter sees it.

## 5. What the equivalence suite actually asserts

`test/transport-equivalence.test.ts` expresses one stock position three ways and deliberately varies everything that should not matter: row order, column order, column names, unit spelling, quantity spelling, padding around source codes, line endings, a byte order mark, and a quoted field containing a comma. It asserts that all three produce a deep-equal canonical event, then feeds each through the real domain reducer and asserts deep-equal projections including unit, snapshot identity, sequence and staleness.

The suite also asserts the negative case. A stock set that differs only in a unit produces a different event and a different projection, so the equality assertions cannot pass vacuously.

## 6. Boundary

AC-015 remains NOT RUN. The criterion names a cross-transport contract suite over a real ingestion path, and nothing here is wired to one; these are unit tests over pure functions. The criterion moves when the transports are driven by the durable inbox and the comparison runs on stored projections.

Three limits are deliberate. Unit conversion is absent by design and must stay absent until a versioned pack agreement exists. The delimited transport handles a single header row and no multi-part file assembly, which belongs to the snapshot partition logic already in the domain. The database view transport takes rows that someone else has already fetched, because query execution, credentials and least-privilege access belong to the Windows service described in the plan and not to a pure adapter.

Freshness is carried by the domain's snapshot sequence, not by the adapter. An adapter that stamped its own observation time would let a slow transport overwrite newer stock, which is exactly the failure AC-004 exists to prevent.
