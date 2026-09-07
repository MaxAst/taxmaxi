// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import type { PortfolioAssets } from "taxmaxi"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CalculationStatus } from "#/components/calculation-status"

const knownBlockers = [
  ["unknown_cause", "Transaction cause missing"],
  ["missing_valuation", "Valuation missing"],
  ["ambiguous_valuation", "Valuation ambiguous"],
  ["valuation_currency_mismatch", "Valuation currency does not match"],
  ["inventory_shortage", "Insufficient acquisition history"],
  ["movement_shortage", "Insufficient balance for movement"],
  ["blocked_inventory_suffix", "Earlier inventory blocker unresolved"],
  ["malformed_movement", "Invalid movement data"],
  ["missing_decimals", "Asset decimal precision missing"],
  ["unsupported_asset_type", "Asset type unsupported"],
  ["unresolved_identity", "Asset identity unresolved"],
  ["movement_correction_needs_attention", "Movement correction needs attention"],
  ["movement_price_currency_mismatch", "Movement price currency does not match"],
  ["de.staking_activity_classification_required", "Staking activity needs classification"],
  ["de.mining_activity_classification_required", "Mining activity needs classification"],
  ["de.airdrop_classification_required", "Airdrop needs classification"],
  ["de.reward_classification_required", "Reward needs classification"],
  ["de.payment_income_classification_required", "Payment income needs classification"],
  ["de.gift_acquisition_basis_required", "Gift acquisition cost basis missing"],
  ["de.gift_disposition_classification_required", "Gift disposition needs classification"],
  ["de.fee_allocation_required", "Fee allocation required"],
] as const

const renderBlockers = (codes: ReadonlyArray<string>) => {
  const portfolio: PortfolioAssets = {
    currency: "EUR",
    activeRun: {
      runId: "run-a",
      status: "partial",
      blockerCounts: codes.map((code) => ({ code, count: 1 })),
    },
    latestRun: { runId: "run-a", status: "partial", failureCode: null },
    assets: [],
    summary: { totalValue: null, costBasis: null, profitLoss: null, profitLossPercentage: null },
  }
  return render(
    <CalculationStatus
      portfolio={portfolio}
      requestFailed={false}
      refreshing={false}
      disabled={false}
      onRefresh={vi.fn()}
      postSyncNotice={null}
    />
  )
}

describe("calculation blocker labels", () => {
  afterEach(cleanup)

  it("labels all known engine and factual-input blockers while preserving their codes", () => {
    renderBlockers(knownBlockers.map(([code]) => code))
    for (const [code, label] of knownBlockers) {
      expect(screen.getByText(label)).toBeTruthy()
      expect(screen.getByText(code)).toBeTruthy()
    }
    expect(screen.queryByText("Unknown blocker")).toBeNull()
  })

  it("labels one blocker accurately in the visible summary and announcement", () => {
    renderBlockers(["missing_valuation"])
    expect(screen.getByText("Blockers in the whole calculation: 1")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("Blockers in the whole calculation: 1")
  })

  it.each(["future.example", "constructor", "__proto__"])(
    "preserves unknown code %s without interpreting it",
    (code) => {
      renderBlockers([code])
      expect(screen.getByText("Unknown blocker")).toBeTruthy()
      expect(screen.getByText(code)).toBeTruthy()
    }
  )
})

describe("first calculation status", () => {
  afterEach(cleanup)

  it.each(["running", "failed"] as const)(
    "does not claim retained results when the first calculation is %s",
    (status) => {
      render(
        <CalculationStatus
          portfolio={{
            currency: "EUR",
            activeRun: null,
            latestRun: { runId: "first-run", status, failureCode: null },
            assets: [],
            summary: {
              totalValue: null,
              costBasis: null,
              profitLoss: null,
              profitLossPercentage: null,
            },
          }}
          requestFailed={false}
          refreshing={false}
          disabled={false}
          onRefresh={vi.fn()}
          postSyncNotice={null}
        />
      )
      expect(screen.getByText("No calculation available.")).toBeTruthy()
      expect(
        screen.getAllByText(
          status === "running"
            ? "The latest calculation is running."
            : "The latest calculation failed."
        ).length
      ).toBeGreaterThan(0)
      expect(screen.queryByText(/results remain visible/i)).toBeNull()
    }
  )
})
