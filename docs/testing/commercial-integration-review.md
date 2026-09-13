# Commercial branch integration review

Reviewed branch: claude/ranking-sort-and-filters at 04b6a89. Status: not merged, pending correctness fixes. The four owned package suites were run read-only from their original worktree: 123 tests passed, zero failures. This result does not override the findings below.

## Reproduced defects

With a need of five boxes and one offer containing three available boxes, passing the same offer twice returns complete=true and two allocations (three plus two) against the same offer identity. Available stock has been counted twice. An offer with minimumOrderQuantity=-1 is also accepted. Coordinator reproduction used invented identities and quantities only; output is retained in ignored tmp/commercial-review-reproduction.txt.

Before integration, a bounded Claude task must add failing regression tests and refuse ambiguous duplicate offers/standings, reject negative minima, and provide a deterministic offer-identity tie rule. Allocation must not assume two offers from the same supplier describe independent stock pools. The task is queued for the next available lane; no eleventh builder is started while ten are active.

## Integration review self-evaluation

Scope: review and preservation of the verified runtime while the next lanes build. Overall 4.0/5.

| Axis | Score | Evidence and improvement |
| --- | --- | --- |
| Accuracy | 4 | Runtime checkpoint has 365 passing tests; separate commercial review reproduced two defects despite 123 passing package tests. Independent adversarial review remains useful before release. |
| Completeness | 4 | Reviewed the allocator and ranking boundary and held the branch back. The queued corrections and full combined verification remain outstanding. |
| Clarity | 4 | STATUS and RELEASE-GATE distinguish implemented slices, package tests and full acceptance. Older historical reports must be read with their revision dates. |
| Actionability | 4 | A scoped fix prompt and synthetic reproduction are ready; lane reuse waits for capacity rather than overlapping ownership. |
| Conciseness | 4 | Current status is short; detailed output stays in evidence files. Repeated polling updates should remain tied to changed results. |

Priority improvements: correct duplicate stock accounting; verify receipt inclusion across feed/need/writeback lanes; run release acceptance on the combined revision. A user should agree that blocking unsafe integration is necessary; these scores do not rate the unfinished project as deployment-ready.
