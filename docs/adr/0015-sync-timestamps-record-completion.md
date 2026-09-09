# Sync timestamps record completion, never progress

A source's `last_synced_at` answers "when did this source last finish importing". Until #108, the sync executor also cleared it to null when a real sync started, so every reader saw "never synced" while a sync ran. The dashboard card, the CLI overview, and the first-sync wizard all read that null as a fact about history, and the wizard used it to decide whether a user had ever completed an import. A returning user who reloaded during a later sync therefore got the first-sync flow back.

## Decision

- `last_synced_at` on the source and on the source sync state means the last successful sync completion and nothing else. The executor writes it once, at completion, and leaves it untouched at sync start, on progress, on failure, and on a credit stop. Replays never write it.
- "A sync is running" is a fact about the job, not about the source. Readers that need it use the job's status (`latestSync.status` on the overview, the job endpoint), never a null timestamp.
- No progress write may clear a completion timestamp. A required progress field that has no true value mid-run is omitted from the write, not set to null.

## Consequences

During a running, paused, or failed sync the overview keeps showing the previous completion time, and readers decide "has ever synced" from that value alone. The first-sync wizard shows only while no source has a completion time (#108, D03 and D10).

The mid-run null was an artifact: the original repository contract required a value on every progress write (initial commit, then `e942431be9`), so the writer passed null. Commit `43cdc5a4c5` made an omitted field mean "leave untouched" for replays; #108 T05a extended that to real syncs. Nothing read the mid-run null as a signal, so no behavior other than the false "never synced" display changed.

## Considered options

A separate set-once "first completed sync" column was rejected: it needs a migration, leaves the false null in place, and duplicates a fact the completion timestamp already carries once it stops being cleared. Deriving "has ever synced" from imported transaction counts was rejected because it infers a fact from rows (ADR 0012) and misreads an empty but synced source.
