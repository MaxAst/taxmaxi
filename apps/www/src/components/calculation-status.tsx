import { useId } from "react"
import type { PortfolioAssets } from "taxmaxi"

import { Button } from "#/components/ui/button"
import { m } from "#/paraglide/messages"

const BLOCKER_LABELS: Readonly<Record<string, () => string>> = {
  unknown_cause: () => m["app.calculation.blockers.unknownCause"](),
  missing_valuation: () => m["app.calculation.blockers.missingValuation"](),
  ambiguous_valuation: () => m["app.calculation.blockers.ambiguousValuation"](),
  valuation_currency_mismatch: () => m["app.calculation.blockers.valuationCurrencyMismatch"](),
  inventory_shortage: () => m["app.calculation.blockers.inventoryShortage"](),
  movement_shortage: () => m["app.calculation.blockers.movementShortage"](),
  blocked_inventory_suffix: () => m["app.calculation.blockers.blockedInventory"](),
  malformed_movement: () => m["app.calculation.blockers.malformedMovement"](),
  missing_decimals: () => m["app.calculation.blockers.missingDecimals"](),
  unsupported_asset_type: () => m["app.calculation.blockers.unsupportedAssetType"](),
  unresolved_identity: () => m["app.calculation.blockers.unresolvedIdentity"](),
  movement_correction_needs_attention: () => m["app.calculation.blockers.movementCorrection"](),
  movement_price_currency_mismatch: () => m["app.calculation.blockers.movementPriceCurrency"](),
  "de.staking_activity_classification_required": () => m["app.calculation.blockers.staking"](),
  "de.mining_activity_classification_required": () => m["app.calculation.blockers.mining"](),
  "de.airdrop_classification_required": () => m["app.calculation.blockers.airdrop"](),
  "de.reward_classification_required": () => m["app.calculation.blockers.reward"](),
  "de.payment_income_classification_required": () => m["app.calculation.blockers.paymentIncome"](),
  "de.gift_acquisition_basis_required": () => m["app.calculation.blockers.giftBasis"](),
  "de.gift_disposition_classification_required": () =>
    m["app.calculation.blockers.giftDisposition"](),
  "de.fee_allocation_required": () => m["app.calculation.blockers.feeAllocation"](),
}

const latestRunLabel = (status: NonNullable<PortfolioAssets["latestRun"]>["status"]) => {
  switch (status) {
    case "running":
      return m["app.calculation.latestRunning"]()
    case "failed":
      return m["app.calculation.latestFailed"]()
    case "partial":
      return m["app.calculation.latestPartial"]()
    case "complete":
      return m["app.calculation.latestComplete"]()
  }
}

/** Present the returned portfolio run without claiming coverage of a source sync. */
export function CalculationStatus({
  portfolio,
  requestFailed,
  refreshing,
  disabled,
  onRefresh,
  postSyncNotice,
}: {
  portfolio: PortfolioAssets | undefined
  requestFailed: boolean
  refreshing: boolean
  disabled: boolean
  onRefresh: () => void
  postSyncNotice: "checking" | "unconfirmed" | null
}) {
  const headingId = useId()
  const activeRun = portfolio?.activeRun
  const latestRun = portfolio?.latestRun
  const blockers = activeRun?.blockerCounts ?? []
  const blockerTotal = blockers.reduce((total, blocker) => total + blocker.count, 0)
  const activeLabel =
    portfolio === undefined
      ? requestFailed
        ? null
        : m["app.calculation.loading"]()
      : activeRun == null
        ? m["app.calculation.unavailable"]()
        : activeRun.status === "partial"
          ? m["app.calculation.partial"]()
          : m["app.calculation.complete"]()
  const latestLabel = latestRun == null ? null : latestRunLabel(latestRun.status)
  const showLatestStatus = latestRun?.status === "running" || latestRun?.status === "failed"
  const blockerSummary =
    blockers.length > 0 ? m["app.calculation.blockerTotal"]({ count: blockerTotal }) : null
  const notice =
    postSyncNotice === null
      ? null
      : postSyncNotice === "checking"
        ? m["app.calculation.checking"]()
        : m["app.calculation.unconfirmed"]()
  // Only facts change this text; fetching and identical polling responses do not
  // cause a new live-region announcement.
  const announcement = [
    activeLabel,
    activeRun == null ? null : m["app.calculation.activeRun"]({ runId: activeRun.runId }),
    blockerSummary,
    showLatestStatus ? latestLabel : null,
    showLatestStatus && latestRun != null
      ? m["app.calculation.latestRun"]({ runId: latestRun.runId })
      : null,
    requestFailed ? m["app.calculation.requestFailed"]() : null,
    notice,
  ]
    .filter((text) => text !== null)
    .join(" ")

  return (
    <section aria-labelledby={headingId} className="max-w-2xl space-y-2 text-sm">
      <h2 className="font-medium" id={headingId}>
        {m["app.calculation.heading"]()}
      </h2>
      <p className="text-xs text-muted-foreground">{m["app.calculation.scope"]()}</p>
      <p aria-label={m["app.calculation.announcements"]()} className="sr-only" role="status">
        {announcement}
      </p>
      <div className="space-y-1">
        {activeLabel === null ? null : <p>{activeLabel}</p>}
        {blockerSummary === null ? null : <p>{blockerSummary}</p>}
        {showLatestStatus ? <p>{latestLabel}</p> : null}
        {requestFailed ? <p>{m["app.calculation.requestFailed"]()}</p> : null}
        {notice === null ? null : <p className="text-muted-foreground">{notice}</p>}
      </div>
      {activeRun == null && latestRun == null ? null : (
        <details className="group">
          <summary className="min-h-11 cursor-pointer content-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {m["app.calculation.details"]()}
          </summary>
          <div className="space-y-3 border-l border-border pl-3 pb-2">
            {activeRun == null ? null : (
              <p className="break-all">
                {m["app.calculation.activeRun"]({ runId: activeRun.runId })}
              </p>
            )}
            {latestRun == null ? null : (
              <div className="space-y-1">
                <p className="break-all">
                  {m["app.calculation.latestRun"]({ runId: latestRun.runId })}
                </p>
                <p>{latestLabel}</p>
                {latestRun.failureCode === null ? null : (
                  <p className="break-all">
                    {m["app.calculation.failureCode"]({ code: latestRun.failureCode })}
                  </p>
                )}
              </div>
            )}
            {blockers.length === 0 ? null : (
              <div className="space-y-2">
                <p className="text-muted-foreground">{m["app.calculation.blockerScope"]()}</p>
                <dl className="space-y-3">
                  {blockers.map(({ code, count }) => (
                    <div className="flex items-start justify-between gap-4" key={code}>
                      <dt className="min-w-0">
                        <span className="block">
                          {(Object.hasOwn(BLOCKER_LABELS, code)
                            ? BLOCKER_LABELS[code]?.()
                            : undefined) ?? m["app.calculation.blockers.unknown"]()}
                        </span>
                        <code className="block break-all text-xs text-muted-foreground">
                          {code}
                        </code>
                      </dt>
                      <dd className="shrink-0 tabular-nums">{count}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        </details>
      )}
      <Button
        className="min-h-11"
        disabled={refreshing || disabled}
        onClick={onRefresh}
        size="sm"
        variant="outline"
      >
        {m["app.calculation.refresh"]()}
      </Button>
    </section>
  )
}
