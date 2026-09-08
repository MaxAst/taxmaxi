// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TaxMaxiError, type SourceSyncJob } from "taxmaxi"

import { useSourceSyncs } from "#/hooks/use-source-syncs"
import type { SourceSyncSeed } from "#/lib/dashboard-types"

const source = {
  id: "source-1",
  name: "Test source",
  kind: "wallet" as const,
  importedTransactions: 0,
  unresolvedItems: 0,
  lastSync: "Never",
}

const makeJob = (status: SourceSyncJob["status"]): SourceSyncJob => ({
  sourceId: source.id,
  jobId: "job-1",
  status,
  phase: status === "completed" ? "completed" : "classifying",
  processedRecords: null,
  totalRecords: null,
  progressPercent: status === "completed" ? 100 : 50,
  fetchedRecords: null,
  normalizedRecords: null,
  failedRecords: null,
  message: null,
  resumable: false,
  creditOutcome: null,
})

const deferred = <A,>() => {
  let resolvePromise: (value: A) => void = () => undefined
  const promise = new Promise<A>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe("useSourceSyncs", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not let an older running response overwrite a completed sync", async () => {
    vi.useFakeTimers()
    const firstPoll = deferred<SourceSyncJob>()
    const secondPoll = deferred<SourceSyncJob>()
    const getSourceSyncJob = vi
      .fn<() => Promise<SourceSyncJob>>()
      .mockReturnValueOnce(firstPoll.promise)
      .mockReturnValueOnce(secondPoll.promise)

    const { result } = renderHook(() =>
      useSourceSyncs({
        accountsById: new Map([[source.id, source]]),
        getSourceSyncJob,
        startSourceSync: async () => ({
          sourceId: source.id,
          jobId: "job-1",
          status: "queued",
          message: null,
          resumable: false,
          creditOutcome: null,
        }),
      })
    )

    await act(async () => {
      await result.current.onSourceSync(source)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    await act(async () => {
      secondPoll.resolve(makeJob("completed"))
      await Promise.resolve()
    })
    expect(result.current.activeSyncs[0]?.status).toBe("completed")

    await act(async () => {
      firstPoll.resolve(makeJob("running"))
      await Promise.resolve()
    })
    expect(result.current.activeSyncs[0]?.status).toBe("completed")
  })

  it("does not let an older running response overwrite a credit-required sync", async () => {
    vi.useFakeTimers()
    const firstPoll = deferred<SourceSyncJob>()
    const secondPoll = deferred<SourceSyncJob>()
    const getSourceSyncJob = vi
      .fn<() => Promise<SourceSyncJob>>()
      .mockReturnValueOnce(firstPoll.promise)
      .mockReturnValueOnce(secondPoll.promise)
      .mockResolvedValue(makeJob("running"))
    const creditOutcome = {
      reasonCode: "no_usable_credits" as const,
      availableCredits: 0,
      creditsConsumed: 3,
      additionalCreditsRequired: 2,
    }

    const { result } = renderHook(() =>
      useSourceSyncs({
        accountsById: new Map([[source.id, source]]),
        getSourceSyncJob,
        startSourceSync: async () => ({
          sourceId: source.id,
          jobId: "job-1",
          status: "queued",
          message: null,
          resumable: false,
          creditOutcome: null,
        }),
      })
    )

    await act(async () => {
      await result.current.onSourceSync(source)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(getSourceSyncJob).toHaveBeenCalledTimes(2)

    await act(async () => {
      secondPoll.resolve({ ...makeJob("credit_required"), resumable: true, creditOutcome })
      await Promise.resolve()
    })
    expect(result.current.activeSyncs[0]?.status).toBe("credit_required")

    await act(async () => {
      firstPoll.resolve(makeJob("running"))
      await Promise.resolve()
    })
    expect(result.current.activeSyncs[0]?.status).toBe("credit_required")
    expect(result.current.activeSyncs[0]?.creditOutcome).toEqual(creditOutcome)

    // The item is settled, so the poll loop must not pick it up again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(getSourceSyncJob).toHaveBeenCalledTimes(2)
  })

  it("carries the structured credit outcome of a credit-required job onto the island item", async () => {
    vi.useFakeTimers()
    const poll = deferred<SourceSyncJob>()
    const getSourceSyncJob = vi.fn<() => Promise<SourceSyncJob>>().mockReturnValue(poll.promise)

    const { result } = renderHook(() =>
      useSourceSyncs({
        accountsById: new Map([[source.id, source]]),
        getSourceSyncJob,
        startSourceSync: async () => ({
          sourceId: source.id,
          jobId: "job-1",
          status: "queued",
          message: null,
          resumable: false,
          creditOutcome: null,
        }),
      })
    )

    await act(async () => {
      await result.current.onSourceSync(source)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    await act(async () => {
      poll.resolve({
        ...makeJob("credit_required"),
        message: null,
        resumable: true,
        creditOutcome: {
          reasonCode: "no_usable_credits",
          availableCredits: 0,
          creditsConsumed: 3,
          additionalCreditsRequired: 2,
        },
      })
      await Promise.resolve()
    })

    expect(result.current.activeSyncs[0]?.status).toBe("credit_required")
    expect(result.current.activeSyncs[0]?.creditOutcome).toEqual({
      reasonCode: "no_usable_credits",
      availableCredits: 0,
      creditsConsumed: 3,
      additionalCreditsRequired: 2,
    })
  })

  it("surfaces a refused zero-credit start as credit-required, not a failed sync", async () => {
    const refusal = new TaxMaxiError({
      code: "SourceCreditRequiredError",
      message: "No usable credits available to start a sync.",
      status: 402,
      cause: {
        _tag: "SourceCreditRequiredError",
        message: "No usable credits available to start a sync.",
        reasonCode: "no_usable_credits",
        availableCredits: 0,
      },
    })

    const { result } = renderHook(() =>
      useSourceSyncs({
        accountsById: new Map([[source.id, source]]),
        startSourceSync: async () => {
          throw refusal
        },
      })
    )

    await act(async () => {
      await result.current.onSourceSync(source)
    })

    const sync = result.current.activeSyncs[0]
    expect(sync?.status).toBe("credit_required")
    expect(sync?.message).toBeUndefined()
    expect(sync?.creditOutcome).toEqual({
      reasonCode: "no_usable_credits",
      availableCredits: 0,
      creditsConsumed: 0,
      additionalCreditsRequired: null,
    })
  })

  // #108 T06 (D06): Continue after a credit stop is the same start call. The
  // island's credit_required item is replaced by the new queued job, and the
  // poll loop follows that job.
  it("replaces a credit-required item with the new queued job when the sync continues", async () => {
    vi.useFakeTimers()
    const creditOutcome = {
      reasonCode: "no_usable_credits" as const,
      availableCredits: 0,
      creditsConsumed: 3,
      additionalCreditsRequired: 2,
    }
    let starts = 0
    const startSourceSync = vi.fn(async () => {
      starts += 1
      return {
        sourceId: source.id,
        jobId: `job-${starts}`,
        status: "queued" as const,
        message: null,
        resumable: false,
        creditOutcome: null,
      }
    })
    const getSourceSyncJob = vi.fn(
      async ({ jobId }: { readonly jobId: string; readonly sourceId: string }) =>
        jobId === "job-1"
          ? { ...makeJob("credit_required"), resumable: true, creditOutcome }
          : { ...makeJob("running"), jobId }
    )

    const { result } = renderHook(() =>
      useSourceSyncs({
        accountsById: new Map([[source.id, source]]),
        getSourceSyncJob,
        startSourceSync,
      })
    )

    await act(async () => {
      await result.current.onSourceSync(source)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(result.current.activeSyncs).toHaveLength(1)
    expect(result.current.activeSyncs[0]).toMatchObject({
      creditOutcome,
      jobId: "job-1",
      status: "credit_required",
    })

    // Continue: the same start call for the same source.
    await act(async () => {
      await result.current.onSourceSync(source)
    })

    expect(startSourceSync).toHaveBeenCalledTimes(2)
    expect(startSourceSync).toHaveBeenLastCalledWith(source.id)
    expect(result.current.activeSyncs).toHaveLength(1)
    expect(result.current.activeSyncs[0]).toMatchObject({ jobId: "job-2", status: "queued" })
    expect(result.current.activeSyncs[0]?.creditOutcome).toBeUndefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(getSourceSyncJob).toHaveBeenLastCalledWith({ jobId: "job-2", sourceId: source.id })
    expect(result.current.activeSyncs).toHaveLength(1)
    expect(result.current.activeSyncs[0]).toMatchObject({ jobId: "job-2", status: "running" })
  })
})

describe("useSourceSyncs reload reconnect", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const seed = (status: SourceSyncSeed["status"]): SourceSyncSeed => ({
    sourceId: source.id,
    jobId: "job-1",
    mode: "sync",
    status,
  })

  const renderSeeded = (
    seeds: ReadonlyArray<SourceSyncSeed>,
    getSourceSyncJob: () => Promise<SourceSyncJob>
  ) =>
    renderHook(
      ({ seeds: currentSeeds }: { seeds: ReadonlyArray<SourceSyncSeed> }) =>
        useSourceSyncs({
          accountsById: new Map([[source.id, source]]),
          getSourceSyncJob,
          seeds: currentSeeds,
        }),
      { initialProps: { seeds } }
    )

  it("reads a seeded queued job once right away and then keeps polling it", async () => {
    vi.useFakeTimers()
    const initialRead = deferred<SourceSyncJob>()
    const getSourceSyncJob = vi
      .fn<() => Promise<SourceSyncJob>>()
      .mockReturnValueOnce(initialRead.promise)
      .mockResolvedValue(makeJob("running"))

    const { result } = renderSeeded([seed("queued")], getSourceSyncJob)

    expect(getSourceSyncJob).toHaveBeenCalledExactlyOnceWith({
      sourceId: source.id,
      jobId: "job-1",
    })
    expect(result.current.activeSyncs).toHaveLength(1)
    expect(result.current.activeSyncs[0]).toMatchObject({
      id: source.id,
      jobId: "job-1",
      mode: "sync",
      sourceName: source.name,
      status: "queued",
    })
    expect(result.current.syncingSourceIds.has(source.id)).toBe(true)

    await act(async () => {
      initialRead.resolve(makeJob("running"))
      await Promise.resolve()
    })
    expect(result.current.activeSyncs[0]?.status).toBe("running")
    expect(result.current.activeSyncs[0]?.phase).toBe("classifying")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(getSourceSyncJob).toHaveBeenCalledTimes(3)
    expect(result.current.activeSyncs[0]?.jobId).toBe("job-1")
  })

  it("does not re-open a failed job from a past session", async () => {
    vi.useFakeTimers()
    const getSourceSyncJob = vi
      .fn<() => Promise<SourceSyncJob>>()
      .mockResolvedValue(makeJob("failed"))

    const { result } = renderSeeded([seed("failed")], getSourceSyncJob)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(result.current.activeSyncs).toEqual([])
    expect(getSourceSyncJob).not.toHaveBeenCalled()
  })

  it("carries the credit outcome of a reconnected credit-required job from the job read", async () => {
    vi.useFakeTimers()
    const getSourceSyncJob = vi.fn<() => Promise<SourceSyncJob>>().mockResolvedValue({
      ...makeJob("credit_required"),
      resumable: true,
      creditOutcome: {
        reasonCode: "no_usable_credits",
        availableCredits: 0,
        creditsConsumed: 8,
        additionalCreditsRequired: 22,
      },
    })

    const { result } = renderSeeded([seed("credit_required")], getSourceSyncJob)

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.activeSyncs[0]).toMatchObject({
      jobId: "job-1",
      progress: 100,
      status: "credit_required",
      creditOutcome: {
        reasonCode: "no_usable_credits",
        availableCredits: 0,
        creditsConsumed: 8,
        additionalCreditsRequired: 22,
      },
    })
    expect(result.current.syncingSourceIds.has(source.id)).toBe(false)

    // A paused job has nothing to poll; the one read on mount is the only one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(getSourceSyncJob).toHaveBeenCalledTimes(1)
  })

  it("applies seeds only on mount, so a later overview refetch opens nothing", async () => {
    vi.useFakeTimers()
    const getSourceSyncJob = vi
      .fn<() => Promise<SourceSyncJob>>()
      .mockResolvedValue(makeJob("running"))

    const { rerender, result } = renderSeeded([], getSourceSyncJob)
    expect(result.current.activeSyncs).toEqual([])

    rerender({ seeds: [seed("queued")] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(result.current.activeSyncs).toEqual([])
    expect(getSourceSyncJob).not.toHaveBeenCalled()
  })
})
