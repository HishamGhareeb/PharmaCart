# PharmaCart alert episodes and quiet hours (B5)

Status: implemented, unit-tested, no delivery channel attached
Scope: collapsing repeated alert signals into episodes, scheduling delivery around a local quiet window, and redacting what leaves the system
Source input: *PharmaCart Builder Master Plan*, sections 22 and 34; acceptance criterion AC-017

`packages/alerting` is a pure reducer plus a scheduler. It has no transport, no push provider and no clock of its own: every function takes the instant it should reason about as an argument, which is what makes quiet hours and episode behaviour testable without waiting for a Tuesday night.

## 1. Episodes, not notifications

A shortage does not happen once. The same condition re-observes on every inventory snapshot, and a system that notifies per observation wakes a pharmacist eleven times for one problem.

An episode opens on the first signal for a given installation and condition key, and every later signal while it is open is coalesced: the signal count and last-seen time advance, and no second delivery is scheduled. Resolving the condition closes the episode, and a later signal opens a genuinely new one with its own delivery. One problem, one push, for as long as it is the same problem.

Signal identity is deduplicated the same way the inventory reducer deduplicates events. A replayed signal identity carrying identical content is a duplicate and changes nothing, which keeps the reducer safe behind an at-least-once queue. The same identity carrying different content is refused as `conflicting_signal` rather than silently overwriting, because a changed body under a reused identity means an upstream defect, not a retry.

Severity escalates within an episode. A `critical` signal arriving inside an open `actionable` episode raises the episode severity and still does not push again. Re-delivering on escalation is a policy question that needs a rule about how far severity must climb and how often, and inventing one here would be inventing a product decision.

## 2. Quiet hours as local wall-clock, resolved forward

The quiet window is expressed in local wall-clock minutes with an IANA time zone, so a policy of 22:00 to 07:00 means the same thing in Cairo in January and in September even though the offset differs. Windows that cross midnight are supported, since almost every real one does.

Deferral deliberately avoids the usual approach of mapping a local wall-clock time back to an instant. That reverse mapping has no answer during a daylight saving gap and two answers during an overlap, and getting it wrong means either a lost notification or a duplicated one. Instead the scheduler walks forward minute by minute from the signal instant and returns the first instant that is not quiet, converting each candidate through `Intl` so the platform's own time zone data resolves every transition. The search is capped at 48 hours.

The property that matters is asserted directly: the instant a deferral returns is itself outside the quiet window. A spring-forward case is covered where the window ends at a local time that does not exist that day, and delivery correctly lands at the first minute that does.

A severity listed in `bypassSeverities` passes straight through the window without rescheduling. A policy whose window covers the whole day is reported as `no_window_found` rather than delivered anyway, and the episode is still recorded, so a do-not-disturb configuration suppresses the push without losing the alert.

## 3. What leaves the system

The delivery payload carries an episode identifier, an installation identifier, a severity-derived title and a fixed instruction to open the application. It carries no product name, no quantity, no branch name and no free text from the signal.

This is enforced by construction rather than by filtering. The payload type has four fields and the redaction function builds them from the episode alone, so a sensitive value cannot be forwarded by a later edit that adds a field to the signal. The test serialises a real payload and asserts that none of the sensitive strings from the originating signal appear anywhere in it.

The reason is not only privacy at the lock screen, though that is the stated requirement. Stock shortages are commercially sensitive: a notification preview that names what a pharmacy has run out of leaks purchasing intent to anyone who glances at the phone.

## 4. Boundary

AC-017 remains NOT RUN. The criterion names a notification test using a controllable clock and a fake delivery sink, retaining episode count, scheduled delivery and redacted payload assertions. Two of those three exist here as unit assertions, but there is no delivery sink because there is no notification channel, and no client to receive one.

The scheduler decides when a delivery should happen and records it. Nothing dispatches it, retries it, or reconciles a delivery whose outcome is unknown. When a channel is added it must reuse the outbox and unknown-outcome discipline the order path already has, since a push provider that accepts and then times out is the same problem as a supplier that does.

Episode state lives in memory in this reducer. Persistence, per-user policy resolution and the relationship between an installation and the people who should be notified all belong to the database layer and do not exist yet.

## 5. Delivery

Status: implemented against a synthetic sink; database layer written and not yet executed. This section supersedes the statements in section 4 that nothing persists or dispatches an episode. AC-017 remains NOT RUN. Review findings, tests and commands: `docs/testing/synthetic-alert-delivery.md`.

`packages/notifications` holds the pure decisions and the file-backed development sink; `packages/db/src/notifications.ts` and migration `0019_notification_delivery.sql` hold persistence and dispatch. The reducer in this package still makes every episode, quiet-hours and redaction decision. Delivery does not persist its in-memory state: it reads the one open episode a signal can coalesce into, under a per-installation lock, and hands the reducer just that.

- **One episode, one push, in the database.** A partial unique index allows one open episode per installation and condition, the outbox allows one row per episode, and a unique index on send attempts allows one send per outbox row. `resolveAlertEpisode` closes an episode so a recurrence opens a new one with its own delivery.
- **Quiet hours survive a restart.** A deferred delivery is a `pending` outbox row with its `deliver_at`; a worker that starts later claims it at or after that instant with `FOR UPDATE SKIP LOCKED`, and re-evaluates the window at dispatch rather than trusting scheduling time.
- **Unknown outcomes use the order path's discipline.** The sink owns the delivery identity and answers lookups. Every first send is preceded by a lookup and by a committed send attempt. A send that fails or times out leaves the row `outcome_unknown`; it is settled by lookup or escalated to `manual_review`, never resent. A live lease is never reconciled, and dispatch stays paused after a restart until nothing unsettled remains.
- **Everything is bounded and recorded.** Sink calls have deadlines, lock waits have `lock_timeout`, deferrals and failed lookups have limits, recovery works in batches, and every lookup and send is a row in `notification_delivery_attempt`.
- **The redaction here is the allowlist there.** A payload may carry only the titles and body this reducer produces, read from the reducer itself; the outbox `CHECK` refuses anything else, including a JSON null in place of an identifier.
- **Tenant isolation.** All six tables force row level security, and child rows reference their parent by identifier and tenant scope together, because a foreign key check ignores row level security.

Still absent: a real channel, recipients, a scheduler, an operator surface for `held` and `manual_review` rows, and a caller. The inventory path does not yet call `acceptAlertSignal`.
