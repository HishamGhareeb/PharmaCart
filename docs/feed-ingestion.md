# PharmaCart feed ingestion pipeline (B4)

Status: implemented, unit-tested, not driven by any worker
Scope: composing the transport guards and the adapter into one entry point that turns a dropped file into a canonical inventory event
Source input: *PharmaCart Builder Master Plan*, sections 16 to 18; acceptance criteria AC-013 and AC-015

`packages/feed-ingestion` is the only package here that is mostly composition. Everything before it was a leaf: a guard, an adapter, a reducer. This is the seam test. If the pieces did not fit, this is where it would show.

## 1. The order is the security property

Five stages run in a fixed order, exported as `INGESTION_STAGES` so a caller can see it and a test can pin it: path, read, decompression, parse, adapt.

The order is not an implementation detail. A path is bounded before anything opens it, a compressed payload is capped before it is inflated, cells are guarded before they are read as meaning, and meaning is settled before the domain sees an event. Get the order wrong and each individual guard still passes its own tests while the pipeline reads a file it should never have opened.

The reader is injected rather than called. `ingestDelimitedFeed` takes a `FeedReader` and the path guard runs before it is invoked, so the ordering is enforced by the shape of the API instead of by a comment. The test for this asserts something a normal success-path test cannot: given a traversal path, the reader records zero calls. Refusing to open the file is the behaviour, not refusing to use its contents.

## 2. Every rejection names its stage

A rejection carries the stage, the underlying reason from whichever guard produced it, and a short detail. An operator gets "rejected at decompression, output_too_large" rather than a generic parse failure, which is the difference between fixing the export job and guessing at it.

The tests walk one hostile input per stage and assert both the stage and the reason, which is also how the pipeline's ordering claim stays honest over time. If a later change let a decompression bomb reach the parser, the bomb test would report the wrong stage rather than silently still passing.

## 3. What composition revealed

Building this exposed a real gap in a package that was already green.

Source codes arriving from a feed are identities, and they were passing through `inspectUntrustedCell`, which guards against spreadsheet formula payloads, but never through `inspectIdentifierText`, which guards against everything in `packages/text-identity`. A vendor code containing a right-to-left override or Arabic-Indic digits would have become a canonical product identity.

The fix belongs in the adapter rather than the pipeline, because anything producing canonical identities should carry the guard, including a caller that uses the adapter directly. `adaptInventoryObservations` now refuses such a code as `unsafe_identifier`, and the pipeline inherits it. This is exactly the class of defect that survives unit tests on individual packages and dies on first composition.

## 4. Boundary

AC-013 and AC-015 both remain NOT RUN, and this narrows the gap without closing it. There is now a real ingestion path for hostile input to meet, which is what AC-013 asks for, but nothing drives it: no worker watches a directory, no durable inbox records what was accepted, and no evidence is retained. AC-015 additionally needs the same comparison across the database-view and JSON transports on stored projections, which means running through persistence rather than through a function.

The pipeline covers the delimited-file transport only. The JSON and database-view readers exist in `packages/transport-adapters` and converge on the same adapter, so composing them is mechanical, but it is not written.

Nothing here handles multi-part snapshots, which the domain already models, or decides the envelope. Event identity, snapshot identity and sequence are supplied by the caller, and whatever calls this must derive them from the transport in a way that survives replay, which is the durable inbox's job rather than the pipeline's.
