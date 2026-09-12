# PharmaCart replay-safe feed identity (B4)

Status: implemented, unit-tested, not driven by a watcher
Scope: deriving the event, snapshot and partition identities a dropped feed becomes, so re-reading it is a duplicate rather than a second delivery
Source input: *PharmaCart Builder Master Plan*, sections 16 and 21; acceptance criterion AC-003 at the transport edge

`packages/feed-ingestion` takes its envelope from the caller. That was a hand-wave, and this package removes it. Event identity is where replay safety actually lives, and leaving it to whatever code happens to call the pipeline meant leaving the system's most important idempotency property undefined.

## 1. The failure being prevented

A watcher reads a file, hands the rows to the domain, then the process dies before it records that the file was done. On restart it reads the same file again.

If the second read produces a new event identity, the pharmacy's stock is counted twice and a shortage disappears that was never resolved. This is not an exotic case. It is the ordinary consequence of a crash, a redeploy, or an operator re-dropping an export they were not sure had landed.

The inventory reducer already handles it correctly if it is given the chance: an event whose identity it has seen, carrying identical content, is reported as a duplicate and changes nothing. The whole job here is to make sure the second read presents the same identity.

## 2. Identity is a function of the feed and nothing else

Every identifier is derived by hashing facts that come from the export itself. Nothing reads the local clock, generates a random value, or counts.

- **Sequence** comes from the export's own timestamp, as whole seconds. Using the local clock would assign a fresh sequence on every re-read, creating a new snapshot each time.
- **Snapshot identity** hashes installation, batch key and sequence, so every partition of one export lands in one snapshot and a later export is a different one.
- **Partition identity** hashes the partition key, typically the file name within the batch.
- **Event identity** hashes all of the above together with a content digest.

The content digest is taken over canonical rows, sorted, after adaptation. This is deliberate and it matters: the same stock exported twice with different line endings, a byte order mark, or a different row order produces one digest and therefore one event. Hashing raw bytes would have made those cosmetic differences into distinct events, which is the same double-count by a different route.

The tests pin each of these separately, including that a changed quantity produces a new event without disturbing the snapshot or partition it belongs to.

## 3. Stale exports are refused, equal ones are not

Derivation takes the last accepted sequence for the installation and refuses anything older as `stale_export`. A feed that has been sitting in a folder since yesterday cannot overwrite this morning's stock.

An export whose sequence equals the watermark is allowed through. That is the re-read case, and refusing it here would defeat the point: the reducer needs to see the event to recognise it as a duplicate. Refusing at the edge and deduplicating at the domain are different jobs, and only the domain can tell a duplicate from a conflict.

## 4. Boundary

This narrows AC-003 without satisfying it. The criterion requires that replaying one inventory event produces one inbox identity and one projection update, with no duplicate need or alert, evidenced through a real durable inbox. The replay property is demonstrated here against the in-memory reducer only. There is no inbox, nothing persists the accepted watermark, and nothing watches a directory.

The watermark is passed in rather than stored. Whatever calls this must read the last accepted sequence for the installation from the database inside the same transaction that accepts the event, or two concurrent readers can both pass a stale check.

Sequence resolution is one second. Two exports from the same installation within the same second collapse to one sequence and would be treated as one snapshot, which is wrong if their contents differ. A vendor emitting sub-second exports needs an explicit counter in the batch key instead, and the current design would silently mis-handle it rather than refusing.

Finally, this trusts the export timestamp the feed carries. A vendor system with a wrong clock produces wrong sequences, and a vendor that emits no timestamp cannot use this at all. Both are adapter-certification questions rather than code ones.
