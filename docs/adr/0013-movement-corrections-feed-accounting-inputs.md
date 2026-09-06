# Movement corrections change accounting inputs, not tax conclusions

## Status

Accepted product boundary; implementation pending. The maintainer confirmed this scope on 2026-09-06 while defining **#150 — feat(tax): apply audited user overrides to transaction calculations**. The first delivery PR publishes this ADR and its domain contracts before implementation depends on it.

## Decision

A principal may correct the valuation or supported factual classification of one recorded token movement. The correction preserves provider evidence, applies only to the owning principal, and supplies effective inputs to the accounting engine. Treatment codes remain engine results; users do not write taxable/exempt conclusions or change accounting methods through this capability.

Asset identity and inclusion remain the asset-wide overrides in ADR 0011. A movement correction never changes those decisions, token quantities, occurrence times, ownership, or reconciliation approval. A corrected price cannot unblock an excluded asset or manufacture a missing acquisition, transfer approval, or legally decisive fact.

### Identity and history

The producer records a stable movement identity from its actual source record and explicit component identity. It is independent of a derived leg UUID, the selected economic asset, the price, and the effective classification. A durable movement target survives deletion and recreation of derived rows. Readers follow recorded links under ADR 0012; they never find targets by amounts, sibling rows, or current list positions. A target that disappears or changes structural meaning stays in history and needs attention; the correction is never moved to a replacement movement by guessing.

Price and classification have independent append-only streams per principal and movement target. Reuse ADR 0011's create/replace/withdraw semantics, authenticated actor, required reason, inspected system revision, expected stream leaf, and atomic conflict checks. Reuse the existing source replay scheduling and covering-run rules rather than creating another job system. Asset-wide target semantics are not reused as the identity of a single movement.

Current system facts, the inspected facts retained with each correction, active user input, and effective facts remain separate. Later provider changes do not erase an override. Structural changes that prevent safe application are explicit blockers, not permission to apply the correction elsewhere. Source/principal deletion cannot cascade away correction history.

### Valuation and calculation

Price input is either a unit price or a total value for the selected movement, never an ambiguous transaction-wide amount. Preserve the input mode, exact amount, currency, and inspected quantity. The input currency is the calculation's reporting currency in this first version; residence and interface locale do not determine it. Foreign-currency entry and conversion are separate work.

An applicable active price correction takes precedence over provider consideration and market quotes for that movement. Its evidence remains user supplied: it is never represented as provider-observed consideration or a market quote. The engine consumes a typed user valuation fact without knowing about users, persistence, or override history management. Without a price correction, existing valuation selection is unchanged.

A factual correction changes a supported acquisition or disposition cause while preserving ownership direction and recorded movement structure. Engine validation and jurisdiction rules still run. Classifying a receipt as an airdrop, gift, or generic staking reward can leave it blocked where the engine needs additional facts. A movement label cannot create an approved transfer between owned sources.

The existing factual-ledger loader is the application boundary. It reads correction history in the calculation's repeatable-read snapshot, applies effective inputs, and records which correction records and exact effective values the run consumed. Runs with different correction histories have different input revisions even when amounts happen to be equal. A current override is never shown as applied to an older run that did not consume it. Failed application leaves explicit partial/updating/failed status and does not delete history or stop unrelated valid source activity.

## Considered options

Direct tax-result replacements were excluded: the confirmed product scope is to correct inputs and let the engine derive the result. Reusing an asset-wide target for a transaction price was rejected because it would affect unrelated occurrences. Attaching corrections to regenerated leg IDs or reconstructing movement identity during reads was rejected because replay can change those rows. A parallel replay or calculation scheduler was rejected because the existing lifecycle already owns retries, follow-ups, and run coverage.
