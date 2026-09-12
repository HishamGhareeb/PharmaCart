# PharmaCart offline draft safety (B5)

Status: implemented, unit-tested, no client attached
Scope: what happens to a purchase draft approved on a device that was offline while the server moved
Source input: *PharmaCart Builder Master Plan*, sections 25 and 34; acceptance criterion AC-012

`packages/offline-draft` decides whether a draft may still be submitted after a reconnect, and what a fresh approval must bind to if it may not. It is a pure pair of functions with no storage, no network and no clock of its own.

## 1. Approval binds to a state, not to an intention

The failure this package exists to prevent is quiet. A purchaser approves an order on a phone, the phone loses signal, and while it is offline the supplier's terms change or the quote is repriced. When the phone reconnects, the natural implementation flushes its queue and the order goes out against terms nobody agreed to.

So an approval is treated as a commitment to a specific set of facts rather than a general willingness to buy. It records the terms version, the quote version and the exact total it was given. On reconnect those are compared against what the server reports now, and any drift voids the approval and demands a human.

The reasons are reported together rather than one at a time, because a purchaser deciding whether to re-approve wants to know that the terms changed *and* the total moved, not to discover the second fact after acting on the first.

## 2. The guard is structural

`reconcileOfflineDraft` returns one of three shapes, and only `submittable` carries the idempotency key. A draft that needs re-approval does not expose a key at all, so there is no value a caller could pass to the submit endpoint even by mistake. The test asserts the property directly: after a terms change the result has no `idempotencyKey` property.

`releaseForSubmission` is the single point where a submission may be authorised, and it refuses anything that is not `submittable`. This is what makes "zero submit calls before user action" enforceable rather than a convention a client is trusted to follow.

Authorisation is evaluated before approval. A purchaser whose membership was revoked while offline is blocked, never merely reprompted, because prompting implies that approving again would work.

## 3. Idempotency keys derive from bound facts

A re-approval must not reuse the previous key. The command's body has changed, and the contract returns `409 VERSION_CONFLICT` for a reused key with a changed body, which would leave the purchaser stuck with no way to proceed.

The key is therefore derived by hashing the facts the approval binds: draft, installation, relationship, quote identity, quote version, total and terms version. It deliberately excludes who approved and when.

That exclusion buys two properties. A retry after a lost response presents the same key and the server collapses it into the existing intent, so a flaky connection cannot produce two orders. Two people approving the same draft in the same state also present the same key, which is the client-side half of the guarantee AC-005 makes on the server: simultaneous approval yields one intent and one budget reservation, not two purchases.

Any change to a bound fact produces a different key, so re-approval after a price move is a new command rather than a conflicting version of an old one.

## 4. Boundary

AC-012 remains NOT RUN. The criterion names a client end-to-end test that controls connectivity and server terms version, then asserts refreshed terms, an approval prompt and zero submit calls before user action. None of the four clients exists, so there is nothing to drive connectivity against and no prompt to observe. What exists here is the decision the client must obey, tested as pure functions.

Three things are deliberately outside this package. It does not fetch the server view; deciding what is authoritative after a reconnect belongs to the sync layer. It does not store drafts or queue submissions, which belongs to the durable queue described for the Windows service and to whatever the mobile client uses. It does not decide when a quote should be re-quoted rather than re-approved, which is the server's freshness rule under AC-008.

The package also assumes the server view it is handed is current. A stale view would let a draft look submittable when it is not, so the caller must treat a reconnect refresh as a prerequisite rather than an optimisation.
