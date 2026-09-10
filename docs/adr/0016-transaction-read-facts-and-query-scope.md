# Transaction read facts and shared query scope

**Status:** Accepted design; not yet implemented. Specs #369 (row facts and browsing), #370 (structured filters), #129 (indexed search) and #371 (inspection and correction UI) deliver the behavior described below. This ADR does not establish that complete movement capture, query-bound cursors or coherent table/inspector projections have shipped.

A transaction row groups its stored movements. A calculation run reads accounting events and produces tax results. A fully sold purchase can have no inventory left, but its purchase value must remain visible. An override history record describes a correction; it cannot stand in for a movement that never had a correction.

## Decision — target behavior

- Capture every movement’s effective inputs, including fee movements, alongside its calculation run, with exact durable target/event links and explicit absent-event states. Read final combined corrected events, not the first correction. Preserve withheld movements without making up events or IDs. Keep accounting events and their linked valuation facts as separate engine inputs. Let the existing engine choose valuation once and carry that selected output to persistence; readers do not repeat precedence rules or derive original acquisition values from remaining lots.

- The per-movement capture answers what the calculation consumed and selected. The override-ID-keyed correction-input records answer what each correction did, including historical records. Both use the same producer facts. Never manufacture an override ID for an uncorrected movement. Persist the run and captured records atomically, and switch the visible completed projection coherently.

- A transaction row remains one stored transaction with its movements, including distinct fee movements. Fees are separated for display, not excluded from movement capture; capture their effective inputs and any corrections too. It is neither one row per movement nor necessarily a whole on-chain transaction. Unresolved or excluded provider activity without produced accounting movements stays in #153.

- Source filters use exact owned source IDs for transactions. Portfolio scope is the union of selected sources’ custody units, each counted once, preserving the existing single-source meaning. Asset/category/date/search filters affect transactions only. OR applies within source/asset/category choices; AND applies across filter groups. Counts and cursor pages share the same predicate, and cursors are bound to the query.

- Asset/category filtering and displayed calculated facts use a coherent completed projection. Current correction state and queued work may be displayed separately; an old run must not be described as already including a new correction. Attention comes from explicitly linked review/blocker records, not from assigning every row a scope-level failure.

- Old immutable runs are not backfilled or rewritten. Migrations change schema only. Deliberately recompute affected scopes outside migrations and verify writer-produced capture before enabling readers that depend on it; make unavailable captured values explicit until then.

## Expected consequences after implementation

The table and inspector will read the same recorded calculation facts. A complete movement capture is required because correction-input records cannot cover uncorrected movements. Existing review and blocker records remain sufficient for basic attention filtering. Fully consumed inventory will not erase historical row values. Source choice will retain custody-unit meaning in portfolio and exact-source meaning in transactions.

## Considered options

Deriving historical values from remaining inventory, copying the engine’s valuation selector into a reader, inventing override IDs and summing single-source portfolios in the browser were rejected: each loses or misstates a fact already owned by a producer.
