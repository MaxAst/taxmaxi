# Transaction read facts and shared query scope

**Status:** Accepted and partially implemented. [#369](https://github.com/taxmaxi/taxmaxi/issues/369) delivered complete movement capture, coherent list/detail facts and stable row browsing. [#370 T01–T05](https://github.com/taxmaxi/taxmaxi/issues/370) delivered query-bound cursors, structured filter reads, shared portfolio source scope and URL query state. [#371 T01](https://github.com/taxmaxi/taxmaxi/issues/371) restored inspector shells and cursor navigation. Remaining source/filter controls belong to #370, inspector summaries and editing to #371, and indexed search to #129; this ADR does not mark those tasks complete.

A transaction row groups its stored movements. A calculation run reads accounting events and produces tax results. A fully sold purchase can have no inventory left, but its purchase value must remain visible. An override history record describes a correction; it cannot stand in for a movement that never had a correction.

## Decision

- Capture every movement’s effective inputs, including fee movements, alongside its calculation run, with exact durable target/event links and explicit absent-event states. Read final combined corrected events, not the first correction. Preserve withheld movements without making up events or IDs. Keep accounting events and their linked valuation facts as separate engine inputs. Let the existing engine choose valuation once and carry that selected output to persistence; readers do not repeat precedence rules or derive original acquisition values from remaining lots.

- The per-movement capture answers what the calculation consumed and selected. The override-ID-keyed correction-input records answer what each correction did, including historical records. Both use the same producer facts. Never manufacture an override ID for an uncorrected movement. Persist the run and captured records atomically, and switch the visible completed projection coherently.

- A transaction row remains one stored transaction with its movements, including distinct fee movements. Fees are separated for display, not excluded from movement capture; capture their effective inputs and any corrections too. It is neither one row per movement nor necessarily a whole on-chain transaction. Unresolved or excluded provider activity without produced accounting movements stays in #153.

- Source filters use exact owned source IDs for transactions. Portfolio scope is the union of selected sources’ custody units, each counted once, preserving the existing single-source meaning. Asset/category/date/search filters affect transactions only. OR applies within source/asset/category choices; AND applies across filter groups. Counts and cursor pages share the same predicate, and cursors are bound to the query.

- Asset/category filtering and displayed calculated facts use a coherent completed projection. Current correction state and queued work may be displayed separately; an old run must not be described as already including a new correction. Attention comes from explicitly linked review/blocker records, not from assigning every row a scope-level failure.

- Old immutable runs are not backfilled or rewritten. Migrations change schema only. Deliberately recompute affected scopes outside migrations and verify writer-produced capture before enabling readers that depend on it; make unavailable captured values explicit until then.

## Delivered read distinctions

The [list](https://github.com/taxmaxi/taxmaxi/pull/387) and [detail](https://github.com/taxmaxi/taxmaxi/pull/391) expose original quantities and selected values through captured run/event links and durable movement targets, even when replay replaces transaction and leg IDs. Imported transaction type and source evidence remain separate from each movement's completed effective identity. Missing or absent captures leave monetary values unavailable; a new current fact cannot fill a missing completed fact.

Provider consideration, selected valuation and tax basis have different meanings. The current capture does not record original acquisition tax basis, so readers leave it unavailable rather than substitute selected valuation. Recorded disposal allocations provide disposal basis, proceeds and gain. A transaction-level fiat amount alone does not establish a custody movement's provider consideration ([#369 T06](https://github.com/taxmaxi/taxmaxi/pull/387)); display labels retain these distinctions ([T08](https://github.com/taxmaxi/taxmaxi/pull/392)).

List, detail and attention filtering follow exact owned fee links, including a fee whose own transaction is absent or different. Unrelated sibling movement blockers do not follow that association. A transaction-wide parent blocker that the writer propagates through the recorded fee pair does contribute: it explains why the linked transaction was withheld and has no monetary result. Do not hide that causal blocker or invent association from sibling amounts or counts ([linked-fee decision](https://github.com/taxmaxi/taxmaxi/issues/369#issuecomment-5621894808), [writer proof](https://github.com/taxmaxi/taxmaxi/issues/369#issuecomment-5622221721)).

## Consequences

The list and detail API expose the same recorded calculation facts. A complete movement capture is required because correction-input records cannot cover uncorrected movements. Existing review and blocker records remain sufficient for basic attention filtering. Fully consumed inventory does not erase historical row values. Source choice retains custody-unit meaning in portfolio and exact-source meaning in transactions.

## Considered options

Deriving historical values from remaining inventory, copying the engine’s valuation selector into a reader, inventing override IDs and summing single-source portfolios in the browser were rejected: each loses or misstates a fact already owned by a producer.
