# Principal asset overrides are an append-only layer over global asset decisions

## Status

Accepted

## Context

TaxMaxi decides asset identity and calculation inclusion globally: one provider observation maps to one economic asset for everyone, and a spam or banned verdict excludes it for everyone (ADR 0002). A taxpayer must still be able to disagree for their own report. They may know that an unresolved token is legitimate, that an "excluded" airdrop belongs in their filing, or that TaxMaxi picked the wrong economic asset. Their choice must not change global data, other principals' results, or raw evidence, and an auditor must be able to see what TaxMaxi concluded and what the user replaced.

Issue #149 built this layer for identity and inclusion. Issues #150 (transaction-time prices), #151 (report disclosure), and #153 (user tasks) build on it. This ADR records the rules those specs rely on so they do not have to quote #149 task notes.

## Decision

A principal asset override is an append-only record owned by one principal that replaces one TaxMaxi conclusion for that principal's facts only.

### Two kinds, one target model

- Two override kinds exist: **identity** (which economic asset a fact belongs to) and **inclusion** (whether the asset takes part in calculation). Each kind has its own stream per target.
- The target is the **exact representation key**: blockchain, representation type, and the canonical contract address, mint address, or native identity. It does not require a global `asset_representations` row, because creating that row would assign a global owner. One exact target covers every wallet, source, and provider of that principal that reports the same representation.
- For facts with no exact chain identity, such as Coinbase custody rows, the target is the principal plus the `provider_assets` row. This **provider-asset target** is a fallback only: a fact that carries an exact representation never uses it.
- Targets are stored canonical per blockchain. EVM checksum and lowercase forms of one address are one target; case-sensitive address families stay distinct.

### What an override may and may not do

- An identity override may only select an existing economic asset. It never creates a principal-local asset, never creates or changes a global representation, and never changes a provider mapping. A fungible/NFT mismatch is rejected. Symbol, name, market-data identity, and TaxMaxi's confidence are warnings, not vetoes.
- An inclusion override may reverse a policy exclusion (spam, banned, not legitimate) or exclude an included asset. It never bypasses a technical blocker: missing decimals, malformed movement, unsupported asset type, and unresolved identity keep blocking.
- If one accounting movement in a transaction is excluded or blocked, the whole transaction produces no accounting events. Provider evidence, raw rows, and the review item stay stored. This holds at both fact seams.
- A principal may create an override only for a target that appears in source data they already own. A read of an absent target and a read of another principal's target return the same result.

### History and concurrency

- Every record stores the target, the TaxMaxi conclusion and its revision the user inspected, the replacement, the authenticated actor, the timestamp, a required user-supplied reason, and a supersession link. Operations are `create`, `replace`, and `withdraw`. `create` means no override is active, not that the stream is empty; a create after a withdrawal supersedes that withdrawal. Rows are never updated or deleted.
- Mutations use two compare-and-set checks in one serializable PostgreSQL transaction: the inspected system revision and the expected active override ID. A stale write returns a typed conflict carrying the current projection and writes nothing.
- A later global decision never deactivates a principal override. The projection exposes the current system conclusion, the active override, the effective conclusion, whether the override was made against an older system revision, and the full history, each separately.
- Hard deletion of a principal is rejected while override history exists. Anonymization and retention need a separate product and legal decision.

### Application and recomputation

- One shared decision loader applies the effective decision at both fact seams: when source data is written and when stored rows become accounting events. The two seams may not disagree. Only the economic `assetId` is replaced; the system representation ID, transaction classification, provider evidence, raw rows, and global mappings stay as they were. Fee custody inventory stays on the system asset.
- A stored asset and representation pair must match the global catalog unless an active identity override for that principal authorizes the mismatch. The database no longer enforces the pair with a composite foreign key; the write paths do.
- Accepting an override and storing its replay work happen in one PostgreSQL transaction: history rows plus one durable replay or replay follow-up per exact owned source. No queue write happens inside the transaction. Replay completion requests the existing principal recompute. Persistent replay failure leaves the calculation explicitly incomplete and never rolls back the override.
- A calculation run's input revision includes the exact override history the adapter read, in the same repeatable-read snapshot, in stable order. Two runs that read different override state can never share an input revision, even when their events are equal.
- The public recomputation status is derived, never stored: `updating` while linked replay work is pending or running or while no run covers it; `failed` when linked replay work failed; otherwise the status of the covering run. A run covers an override only when its snapshot can see the active override record and every linked replay row in its completed state. Coverage is decided by snapshot visibility, never by timestamps or by ordering opaque hashes.
- One source write reads the principal's override history once, at the start, and resolves every later decision against that in-memory snapshot. An override committed during the write does not change it; that override's own replay applies the new state afterward. A calculation racing a fact change fails with a typed stale outcome and is superseded; nothing blocks or locks.
- The accounting engine knows nothing about overrides. Fact-layer blockers produced while applying them are stored beside engine blockers in the same run blocker rows. A blocker row links an economic asset, a provider-asset row, or both.

## Considered options

- Principal-scoped columns on global provider mappings were rejected because they change global data and cannot express "the user disagrees with the global row".
- Principal-local economic assets were rejected because they split FIFO inventory and reports across identities that do not exist for anyone else.
- A stable-input gate, readiness table, or lock around recomputation was rejected. Immutable calculation runs, blocker rows, compare-and-set activation, and maintenance already answer "is this number final".

## Consequences

- Movement-specific price and factual-classification corrections reuse the history shape, compare-and-set rules, and replay scheduling. Their movement targets are distinct from these asset-wide targets; ADR 0013 defines that boundary. Direct tax-treatment overrides are outside the confirmed scope of #150 — feat(tax): apply audited user overrides to transaction calculations.
- Reports (#151) can disclose every override because each run names the override history it read.
- Facts must carry the links the loader needs; see ADR 0012.
- Two principals sharing one representation can receive different effective results from identical raw data. Tests for any fact-layer change must keep proving that isolation.
- Account deletion is blocked for principals with overrides until the retention decision is made.
