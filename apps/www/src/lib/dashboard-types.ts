import type { Source, SourceOverview, SourceSyncJob } from "taxmaxi"

export const ALL_ACCOUNTS = "all"
export const taxYears = [2025, 2024, 2023] as const

export type AccountScope = typeof ALL_ACCOUNTS | AccountId
export type AccountKind = "exchange" | "wallet"
export type AccountId = Source["id"]
export type TaxYear = (typeof taxYears)[number]

export type Account = {
  id: AccountId
  name: Source["name"]
  kind: AccountKind
  network?: string
  providerKey?: NonNullable<Source["providerKey"]>
  importedTransactions: number
  unresolvedItems: number
  lastSync: string
  lastSyncedAt?: string
}

/**
 * A sync job the server already knows about, handed to the sync hook after a
 * page load so the island can reconnect to it. Built from the source
 * overview's `latestSync`; the status uses the job endpoint's words
 * (`queued`, `running`, ...) so the hook can treat it like a job it started.
 */
export type SourceSyncSeed = {
  sourceId: AccountId
  jobId: string
  mode: NonNullable<SourceOverview["latestSync"]["mode"]>
  status: SourceSyncJob["status"]
}

export type TaxYearAccountSummary = {
  accountId: AccountId
  taxYear: TaxYear
  realizedProfitLoss: number
  taxesPayable: number
  taxesReceivable: number
  taxableEvents: number
  missingClassifications: number
}

export type AssetHolding = {
  asset: string
  name: string
  lots: ReadonlyArray<{
    accountId: AccountId
    amount: number
    value: number
    costBasis: number
  }>
}
