# PharmaCart installation pairing and revocation (B4)

Status: implemented, unit-tested, not enforced at any request boundary
Scope: the lifecycle of a paired on-premise installation, what each state permits, and what happens to sync when it is revoked
Source input: *PharmaCart Builder Master Plan*, sections 11, 12 and 18 and 34; acceptance criterion AC-016

`installationId` already appears throughout inventory ingestion as an opaque identifier with no lifecycle behind it. `packages/installation-lifecycle` gives it one: a state machine, a capability set per state, and a sync directive the on-premise agent can obey.

This matters more than its size suggests. The plan puts a .NET Windows service inside pharmacies, reading their databases. That service holds credentials on a machine PharmaCart does not control, and the only thing standing between a stolen laptop and a pharmacy's purchasing is whether revocation actually works.

## 1. Four states, and revocation is terminal

An installation is `pending` until pairing is confirmed, then `active`. It can be `suspended` and resumed without losing its pairing, and it can be `revoked` from any live state.

Revocation is terminal. No command moves an installation out of it, and the refusal is named `terminal_state` rather than a generic failure. Re-pairing is a separate operation that mints a **new** identity and records what it supersedes; reusing a revoked identifier is refused outright.

That rule is the point of the package. If a revoked identity could be resurrected, then every event ever queued under it becomes ambiguous, and a compromised installation could be quietly restored by the same actor who compromised it. A new identity keeps the old one's history intact and permanently dead.

## 2. What each state permits

| Status | Capabilities | Sync |
| --- | --- | --- |
| pending | read configuration | pause |
| active | read configuration, submit inventory, submit orders, acknowledge receipt | proceed |
| suspended | read configuration | pause |
| revoked | none | stop |

A suspended installation keeps `read_configuration` deliberately, so it can discover that it has been suspended and pause itself rather than hammering a rejecting endpoint. A revoked one gets nothing at all, because anything it can still call is something a stolen device can still call.

The pause-versus-stop distinction is what AC-016 asks for. Suspension is reversible and the agent keeps its durable queue; revocation is not, and the agent should stop and discard its credentials.

## 3. Authorisation reads current state, never queue time

The property AC-016 turns on: an installation revoked at nine o'clock is denied work it queued at eight. Authorisation is evaluated against current status at the moment of the request, and nothing in the decision path takes a queue timestamp.

This sits in deliberate tension with AC-011, which requires that a restarted agent lose no events. Both hold, because they are about different things. The agent's durable queue keeps its events; the server refuses to accept them. Conflating those two is how a system ends up either dropping data on a transient fault or accepting writes from a revoked device, and the split is worth stating out loud rather than discovering later.

## 4. Replay is ignored, illegality is refused

Commands arrive over an at-least-once path, so a repeated command must not be an error. Any command whose target state the installation already occupies returns `ignored` with the state unchanged. Revoking a revoked installation, suspending a suspended one, confirming an already-confirmed pairing: all satisfied intents, all quietly fine.

This is state-based, not timestamp-based. An earlier draft distinguished a replay from a fresh command by comparing timestamps, which a retry with a regenerated clock reading would have defeated. A test caught it.

A transition that is genuinely not legal from the current state, such as resuming something that was never suspended, is refused and named. So is a command timestamped before the last status change, since an audit trail that can move backwards is not one.

## 5. Boundary

AC-016 remains NOT RUN. The criterion names an integration test that revokes an established session or paired service and then asserts immediate API denial, connector health, queue state and no new writes. Nothing here is wired to a request boundary, so an API can still ignore it entirely; this is the policy, not the enforcement.

Three gaps are deliberate. Membership revocation for human users is a separate concern already partly handled in the offline draft guard, and the two should converge on one authorisation surface rather than drifting apart. Nothing here persists an installation or emits a revocation event, which belongs to the database and outbox. And the capability set is fixed in code rather than granted per installation, which is right while there is one kind of agent and wrong as soon as there are two.
