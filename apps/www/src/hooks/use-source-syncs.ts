import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"
import {
  TaxMaxiError,
  getTaxMaxiCreditRequired,
  isTaxMaxiUnauthorizedError,
  type SourceSyncJob,
  type SourceSyncJobInput,
  type SourceSyncStart,
} from "taxmaxi"

import {
  getSourceSyncDisplayProgress,
  type SourceSyncIslandItem,
  type SourceSyncMode,
  type SourceSyncStatus,
} from "#/components/source-sync-island"
import type { Account, AccountId, SourceSyncSeed } from "#/lib/dashboard-types"

type ActiveSourceSync = SourceSyncIslandItem & {
  sourceId: AccountId
  jobId?: string
}

/** The part of an item a job read needs: which item to update and which job to ask for. */
type PolledSourceSync = Pick<ActiveSourceSync, "id" | "sourceId"> & { jobId: string }

type UseSourceSyncsOptions = {
  accountsById: ReadonlyMap<AccountId, Account>
  getSourceSyncJob?: (input: SourceSyncJobInput) => Promise<SourceSyncJob>
  onCompleted?: (sourceId: AccountId) => void | Promise<void>
  onUnauthorized?: () => void | Promise<void>
  /**
   * Jobs the server already knows about, from the source overviews loaded
   * with the page. Applied once per mount so the island reconnects to a sync
   * that was running before a reload.
   */
  seeds?: ReadonlyArray<SourceSyncSeed>
  startSourceSync?: (sourceId: AccountId) => Promise<SourceSyncStart>
  startSourceReplay?: (sourceId: AccountId) => Promise<SourceSyncStart>
}

const SOURCE_SYNC_POLL_INTERVAL_MS = 500
const COMPLETED_SYNC_DISMISS_DELAY_MS = 2800
const MAX_CONSECUTIVE_POLL_FAILURES = 3
const NO_SEEDS: ReadonlyArray<SourceSyncSeed> = []

export function useSourceSyncs({
  accountsById,
  getSourceSyncJob,
  onCompleted,
  onUnauthorized,
  seeds = NO_SEEDS,
  startSourceReplay,
  startSourceSync,
}: UseSourceSyncsOptions) {
  const [activeSyncs, setActiveSyncs] = useState<ReadonlyArray<ActiveSourceSync>>([])
  const completionTimeoutsRef = useRef(new Map<string, number>())
  const completedNotificationsRef = useRef(new Set<string>())
  const pollFailureCountsRef = useRef(new Map<string, number>())
  const seededRef = useRef(false)
  const syncingSourceIds = useMemo(
    () =>
      new Set(
        activeSyncs
          .filter((sync) => sync.status === "queued" || sync.status === "running")
          .map((sync) => sync.sourceId)
      ),
    [activeSyncs]
  )

  // Sync and replay share one start flow: both return the same job shape and
  // are polled identically afterwards. Only the request that starts them
  // differs, so the mode is stamped here and carried through polling.
  const startSyncJob = useCallback(
    async (
      source: Account,
      start: (sourceId: AccountId) => Promise<SourceSyncStart>,
      mode: SourceSyncMode
    ) => {
      if (syncingSourceIds.has(source.id)) {
        return
      }

      setActiveSyncs((syncs) => upsertSourceSync(syncs, makePendingSourceSync(source, mode)))

      try {
        const started = await start(source.id)
        setActiveSyncs((syncs) =>
          upsertSourceSync(syncs, {
            id: source.id,
            jobId: started.jobId,
            mode,
            progress: getProgressForStatus(started.status),
            sourceId: source.id,
            sourceName: source.name,
            status: started.status,
            ...(started.message === null ? {} : { message: started.message }),
            ...(started.creditOutcome === null ? {} : { creditOutcome: started.creditOutcome }),
          })
        )
      } catch (error: unknown) {
        const creditRequired = getTaxMaxiCreditRequired(error)
        if (creditRequired !== null) {
          // The start was refused before any job existed. Surface the same
          // credit-required recovery state as a mid-sync pause, so the island
          // offers a billing action instead of a pointless retry.
          setActiveSyncs((syncs) =>
            upsertSourceSync(syncs, {
              id: source.id,
              mode,
              progress: 100,
              sourceId: source.id,
              sourceName: source.name,
              status: "credit_required",
              creditOutcome: {
                reasonCode: creditRequired.reasonCode,
                availableCredits: creditRequired.availableCredits,
                creditsConsumed: 0,
                additionalCreditsRequired: null,
              },
            })
          )
          return
        }

        if (isTaxMaxiUnauthorizedError(error)) {
          setActiveSyncs((syncs) => syncs.filter((sync) => sync.sourceId !== source.id))
          try {
            await onUnauthorized?.()
          } catch {
            setActiveSyncs((syncs) =>
              upsertSourceSync(syncs, {
                id: source.id,
                mode,
                progress: 100,
                sourceId: source.id,
                sourceName: source.name,
                status: "failed",
                message: "Your session expired. Reload the page to sign in again.",
              })
            )
          }
          return
        }

        setActiveSyncs((syncs) =>
          upsertSourceSync(syncs, {
            id: source.id,
            mode,
            progress: 100,
            sourceId: source.id,
            sourceName: source.name,
            status: "failed",
            message: getErrorMessage(error),
          })
        )
      }
    },
    [onUnauthorized, syncingSourceIds]
  )

  const onSourceSync = useCallback(
    async (source: Account) => {
      if (!startSourceSync) {
        return
      }

      await startSyncJob(source, startSourceSync, "sync")
    },
    [startSourceSync, startSyncJob]
  )

  const onSourceReplay = useCallback(
    async (source: Account) => {
      if (!startSourceReplay) {
        return
      }

      await startSyncJob(source, startSourceReplay, "replay")
    },
    [startSourceReplay, startSyncJob]
  )

  // One job read, shared by the poll loop and the reload reconnect. The
  // response only lands on the item that still carries this job id, and a
  // settled item never changes status, so a late response can never overwrite
  // a newer job or move a settled item back to running.
  const readSourceSyncJob = useCallback(
    (sync: PolledSourceSync) => {
      if (!getSourceSyncJob) {
        return
      }

      const { jobId } = sync
      const syncKey = getSourceSyncKey(sync)

      void getSourceSyncJob({ sourceId: sync.sourceId, jobId }).then(
        (job) => {
          pollFailureCountsRef.current.delete(syncKey)
          if (job.status === "completed" && !completedNotificationsRef.current.has(syncKey)) {
            completedNotificationsRef.current.add(syncKey)
            void notifySourceSyncCompleted({
              completedNotifications: completedNotificationsRef.current,
              onCompleted,
              sourceId: sync.sourceId,
              syncKey,
            })
          }
          setActiveSyncs((syncs) => {
            const currentSync = syncs.find((candidate) => candidate.id === sync.id)

            // A settled item keeps its status. A response that confirms that
            // status may still land, so the one read after a `credit_required`
            // seed carries the job's `creditOutcome` onto the item.
            if (
              !currentSync ||
              currentSync.jobId !== jobId ||
              (isSettledSourceSyncStatus(currentSync.status) && job.status !== currentSync.status)
            ) {
              return syncs
            }

            return replaceSourceSync(syncs, toActiveSourceSync(job, currentSync))
          })
        },
        (error: unknown) => {
          if (isTaxMaxiUnauthorizedError(error)) {
            pollFailureCountsRef.current.delete(syncKey)
            failPolledSourceSync({
              expectedJobId: jobId,
              message: "Your session expired. Sign in again to continue syncing.",
              setActiveSyncs,
              sourceId: sync.sourceId,
            })
            void handlePollingUnauthorized({ onUnauthorized })
            return
          }

          const failureCount = (pollFailureCountsRef.current.get(syncKey) ?? 0) + 1
          const jobNotFound = error instanceof TaxMaxiError && error.status === 404

          if (!jobNotFound && failureCount < MAX_CONSECUTIVE_POLL_FAILURES) {
            pollFailureCountsRef.current.set(syncKey, failureCount)
            return
          }

          pollFailureCountsRef.current.delete(syncKey)
          failPolledSourceSync({
            expectedJobId: jobId,
            message: jobNotFound
              ? "The sync job could not be found. Start the sync again."
              : "The sync status could not be loaded after several attempts. Try again.",
            setActiveSyncs,
            sourceId: sync.sourceId,
          })
        }
      )
    },
    [getSourceSyncJob, onCompleted, onUnauthorized]
  )

  useEffect(() => {
    const pollableSyncs = activeSyncs.flatMap((sync) =>
      sync.jobId !== undefined && (sync.status === "queued" || sync.status === "running")
        ? [{ id: sync.id, jobId: sync.jobId, sourceId: sync.sourceId }]
        : []
    )

    if (!getSourceSyncJob || pollableSyncs.length === 0) {
      return
    }

    const intervalId = window.setInterval(() => {
      for (const sync of pollableSyncs) {
        readSourceSyncJob(sync)
      }
    }, SOURCE_SYNC_POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [activeSyncs, getSourceSyncJob, readSourceSyncJob])

  // Reload reconnect: the server already knows these jobs, so each seed
  // becomes an item right away and its job is read once. From there the
  // regular poll loop takes over. Seeds apply once per mount; a later
  // overview refetch must not re-open an item the user has dismissed.
  useEffect(() => {
    if (seededRef.current || !getSourceSyncJob) {
      return
    }

    seededRef.current = true
    const reconnectedSyncs = seeds.flatMap((seed) => {
      const source = accountsById.get(seed.sourceId)

      return source !== undefined && isReconnectableSeedStatus(seed.status)
        ? [makeSeededSourceSync(seed, source)]
        : []
    })

    if (reconnectedSyncs.length === 0) {
      return
    }

    setActiveSyncs((syncs) => reconnectedSyncs.reduce(upsertSourceSync, syncs))
    for (const sync of reconnectedSyncs) {
      readSourceSyncJob(sync)
    }
  }, [accountsById, getSourceSyncJob, readSourceSyncJob, seeds])

  useEffect(() => {
    const completedSyncKeys = new Set<string>()

    for (const sync of activeSyncs) {
      if (sync.status !== "completed") {
        continue
      }

      const syncKey = getSourceSyncKey(sync)
      completedSyncKeys.add(syncKey)

      if (completionTimeoutsRef.current.has(syncKey)) {
        continue
      }

      const timeoutId = window.setTimeout(() => {
        completionTimeoutsRef.current.delete(syncKey)
        setActiveSyncs((syncs) =>
          syncs.filter((candidate) => getSourceSyncKey(candidate) !== syncKey)
        )
      }, COMPLETED_SYNC_DISMISS_DELAY_MS)

      completionTimeoutsRef.current.set(syncKey, timeoutId)
    }

    for (const [syncKey, timeoutId] of completionTimeoutsRef.current) {
      if (completedSyncKeys.has(syncKey)) {
        continue
      }

      window.clearTimeout(timeoutId)
      completionTimeoutsRef.current.delete(syncKey)
    }

    const activeSyncKeys = new Set(activeSyncs.map(getSourceSyncKey))
    for (const syncKey of pollFailureCountsRef.current.keys()) {
      if (!activeSyncKeys.has(syncKey)) {
        pollFailureCountsRef.current.delete(syncKey)
      }
    }
  }, [activeSyncs])

  useEffect(
    () => () => {
      for (const timeoutId of completionTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId)
      }

      completionTimeoutsRef.current.clear()
      completedNotificationsRef.current.clear()
      pollFailureCountsRef.current.clear()
    },
    []
  )

  const onDismissSync = useCallback((item: SourceSyncIslandItem) => {
    setActiveSyncs((syncs) => syncs.filter((sync) => sync.id !== item.id))
  }, [])

  // A failed replay retries as a replay, not as a fetching sync.
  const onRetrySync = useCallback(
    (item: SourceSyncIslandItem) => {
      const source = accountsById.get(item.id)

      if (!source) {
        return
      }

      setActiveSyncs((syncs) => syncs.filter((sync) => sync.id !== item.id))
      void (item.mode === "replay" ? onSourceReplay(source) : onSourceSync(source))
    },
    [accountsById, onSourceReplay, onSourceSync]
  )

  return {
    activeSyncs,
    onDismissSync,
    onRetrySync,
    onSourceReplay,
    onSourceSync,
    syncingSourceIds,
  }
}

function makePendingSourceSync(source: Account, mode: SourceSyncMode): ActiveSourceSync {
  return {
    id: source.id,
    mode,
    progress: 0,
    sourceId: source.id,
    sourceName: source.name,
    status: "queued",
  }
}

/**
 * A terminal job from a past session must not pop the island on every load;
 * only jobs that can still change, or still need the user, are reconnected.
 */
function isReconnectableSeedStatus(status: SourceSyncStatus): boolean {
  return status === "queued" || status === "running" || status === "credit_required"
}

/**
 * A settled item never changes status again under its job id. `credit_required`
 * is settled too: continuing after billing goes through the start call, which
 * creates a new job and a new item (#108 D06).
 */
function isSettledSourceSyncStatus(status: SourceSyncStatus): boolean {
  return status === "completed" || status === "failed" || status === "credit_required"
}

function makeSeededSourceSync(
  seed: SourceSyncSeed,
  source: Account
): PolledSourceSync & ActiveSourceSync {
  return {
    id: seed.sourceId,
    jobId: seed.jobId,
    mode: seed.mode,
    progress: getProgressForStatus(seed.status),
    sourceId: seed.sourceId,
    sourceName: source.name,
    status: seed.status,
  }
}

function toActiveSourceSync(job: SourceSyncJob, current: ActiveSourceSync): ActiveSourceSync {
  return {
    ...current,
    id: job.sourceId,
    jobId: job.jobId,
    progress: getSourceSyncDisplayProgress({
      phase: job.phase,
      progressPercent: job.progressPercent,
      status: job.status,
    }),
    sourceId: job.sourceId,
    status: job.status,
    ...(job.phase === null ? {} : { phase: job.phase }),
    ...(job.processedRecords === null ? {} : { processedRecords: job.processedRecords }),
    ...(job.totalRecords === null ? {} : { totalRecords: job.totalRecords }),
    ...(job.fetchedRecords === null ? {} : { fetchedRecords: job.fetchedRecords }),
    ...(job.normalizedRecords === null ? {} : { normalizedRecords: job.normalizedRecords }),
    ...(job.failedRecords === null ? {} : { failedRecords: job.failedRecords }),
    ...(job.message === null ? {} : { message: job.message }),
    ...(job.creditOutcome === null ? {} : { creditOutcome: job.creditOutcome }),
  }
}

function upsertSourceSync(
  syncs: ReadonlyArray<ActiveSourceSync>,
  nextSync: ActiveSourceSync
): ReadonlyArray<ActiveSourceSync> {
  const found = syncs.some((sync) => sync.id === nextSync.id)

  if (!found) {
    return [nextSync, ...syncs]
  }

  return syncs.map((sync) => (sync.id === nextSync.id ? nextSync : sync))
}

function replaceSourceSync(
  syncs: ReadonlyArray<ActiveSourceSync>,
  nextSync: ActiveSourceSync
): ReadonlyArray<ActiveSourceSync> {
  return syncs.map((sync) => (sync.id === nextSync.id ? nextSync : sync))
}

function getSourceSyncKey(sync: Pick<ActiveSourceSync, "sourceId" | "jobId">): string {
  return `${sync.sourceId}:${sync.jobId ?? "pending"}`
}

function failPolledSourceSync({
  expectedJobId,
  message,
  setActiveSyncs,
  sourceId,
}: {
  expectedJobId: string
  message: string
  setActiveSyncs: Dispatch<SetStateAction<ReadonlyArray<ActiveSourceSync>>>
  sourceId: AccountId
}) {
  setActiveSyncs((syncs) =>
    syncs.map((sync) =>
      sync.sourceId === sourceId &&
      sync.jobId === expectedJobId &&
      !isSettledSourceSyncStatus(sync.status)
        ? { ...sync, message, progress: 100, status: "failed" }
        : sync
    )
  )
}

async function notifySourceSyncCompleted({
  completedNotifications,
  onCompleted,
  sourceId,
  syncKey,
}: {
  completedNotifications: Set<string>
  onCompleted: ((sourceId: AccountId) => void | Promise<void>) | undefined
  sourceId: AccountId
  syncKey: string
}) {
  try {
    await onCompleted?.(sourceId)
  } catch {
    completedNotifications.delete(syncKey)
  }
}

async function handlePollingUnauthorized({
  onUnauthorized,
}: {
  onUnauthorized: (() => void | Promise<void>) | undefined
}) {
  try {
    await onUnauthorized?.()
  } catch {
    // The sync is already failed and dismissible; a later protected request will retry auth cleanup.
  }
}

function getProgressForStatus(status: SourceSyncStatus): number {
  switch (status) {
    case "queued":
    case "running":
      return 0
    case "completed":
    case "failed":
    case "credit_required":
      return 100
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to start sync."
}
