import assert from "node:assert/strict"
import { testRender } from "@opentui/solid"
import type { Source, TransactionListItem, Transactions } from "taxmaxi"
import { disposeController } from "../../src/tui/controller.ts"
import { SourceTransactionsScreen } from "../../src/tui/screens/SourceTransactionsScreen.tsx"

const source: Source = {
  id: "00000000-0000-4000-8000-000000000128",
  principalId: "00000000-0000-4000-8000-000000000001",
  name: "Example wallet",
  providerKey: "helius-solana",
  sourceRef: { _tag: "onchain", addressId: "00000000-0000-4000-8000-000000000002" },
  createdAt: { epochMillis: Date.parse("2026-09-05T00:00:00.000Z") },
}
const session = {
  apiUrl: "https://api.example.test",
  sessionToken: "test-session",
  userId: "test-user",
  connectedAt: "2026-09-05T00:00:00.000Z",
}
const row: TransactionListItem = {
  transactionId: "00000000-0000-4000-8000-000000000003",
  timestamp: "2026-09-04T12:00:00.000Z",
  source: { sourceId: source.id, name: source.name, kind: "onchain" },
  transactionType: "trade",
  description: "Ready trade",
  externalId: "canonical-external-id",
  movements: [{ amount: "2.50000000", assetSymbol: "SOL", kind: "disposal" }],
  calculationState: "complete",
  income: null,
  realizedGainLoss: "12.34",
  fiatCurrency: "EUR",
  needsReview: false,
}
const scenario = process.argv[2]
const partialRow: TransactionListItem = {
  ...row,
  description: "Partial trade",
  calculationState: "partial",
  realizedGainLoss: null,
  fiatCurrency: null,
  needsReview: true,
}
const exactValues: Readonly<Record<string, string>> = {
  "large-gain": "9007199254740993",
  "exact-loss": "-9007199254740993.125",
  "tiny-gain": "0.000000000000000001",
}
const exactValue = exactValues[scenario ?? ""]
const isShortTerminal = scenario === "short-terminal" || scenario === "short-review"
const firstRows: ReadonlyArray<TransactionListItem> = (() => {
  if (scenario === "empty") return []
  if (scenario === "partial") return [partialRow]
  if (scenario === "zero") return [{ ...row, realizedGainLoss: "0" }]
  if (exactValue !== undefined) return [{ ...row, realizedGainLoss: exactValue }]
  if (scenario === "complete-review") return [{ ...row, needsReview: true }]
  if (isShortTerminal) {
    return Array.from({ length: 8 }, (_, index) => ({
      ...(scenario === "short-review" ? row : partialRow),
      needsReview: true,
      transactionId: `short-${index}`,
      description: `Trade ${index}`,
      movements: [
        ...row.movements,
        { amount: "1", assetSymbol: "BTC", kind: "acquisition" },
        { amount: "0.5", assetSymbol: "ETH", kind: "income" },
        { amount: "0.01", assetSymbol: "SOL", kind: "fee" },
      ],
    }))
  }
  return [row]
})()

const firstPage: Transactions = {
  transactions: firstRows,
  totalCount: scenario === "paginated" ? 2 : firstRows.length,
  page: {
    hasMore: scenario === "paginated",
    nextCursor: scenario === "paginated" ? "next-page" : null,
  },
}
const secondPage: Transactions = {
  transactions: [{ ...row, transactionId: "second", description: "Second ready trade" }],
  totalCount: 2,
  page: { hasMore: false, nextCursor: null },
}
const requests: Request[] = []
const originalFetch = globalThis.fetch
let backCount = 0
let quitCount = 0
let expiredCount = 0

globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  requests.push(request)
  const url = new URL(request.url)
  assert.equal(url.pathname, "/v1/transactions")
  assert.equal(url.searchParams.get("sourceId"), source.id)
  assert.equal(request.headers.get("authorization"), "Bearer test-session")
  return Promise.resolve(
    Response.json(url.searchParams.get("cursor") === "next-page" ? secondPage : firstPage)
  )
}

const setup = await testRender(
  () => (
    <SourceTransactionsScreen
      source={source}
      session={session}
      active={() => true}
      onBack={() => backCount++}
      onQuit={() => quitCount++}
      onSessionExpired={() => expiredCount++}
    />
  ),
  { width: 110, height: isShortTerminal ? 24 : 32 }
)

try {
  const frame = await setup.waitForFrame((text) =>
    scenario === "empty"
      ? text.includes("No ready accounting transactions yet.")
      : text.includes("realized gain/loss")
  )
  assert.match(frame, /Ready accounting transactions/)
  assert.match(frame, /\[b\] back/)
  assert.equal(requests.length, 1)
  assert.equal(new URL(requests[0]?.url ?? "").searchParams.has("cursor"), false)

  if (scenario === "partial" || scenario === "short-terminal") {
    assert.match(frame, /calculation\s+Partial/)
    assert.match(frame, /realized gain\/loss\s+Unknown/)
    assert.match(frame, /disposal\s+2\.5 SOL/)
    assert.doesNotMatch(frame, /0\.00|Complete|provider unknown|rule/)
  }
  if (scenario === "zero") {
    assert.match(frame, /calculation\s+Complete/)
    assert.match(frame, /realized gain\/loss\s+0 EUR/)
  }
  if (exactValue !== undefined) {
    assert.ok(frame.includes(`${exactValue} EUR`), frame)
  }
  if (scenario === "complete-review" || scenario === "short-review") {
    assert.match(frame, /calculation\s+Complete/)
    assert.match(frame, /review\s+Needs review/)
    assert.match(frame, /1 legs Needs review|4 legs Needs review/)
  }
  if (scenario === "zero") {
    assert.doesNotMatch(frame, /Needs review/)
  }
  if (scenario === "paginated") {
    assert.match(frame, /1\/1 ready accounting transactions · \[m\] load more/)
    setup.mockInput.pressKey("m")
    await setup.waitForFrame((text) => text.includes("1/2 ready accounting transactions"))
    assert.equal(requests.length, 2)
    assert.equal(new URL(requests[1]?.url ?? "").searchParams.get("cursor"), "next-page")
    setup.mockInput.pressArrow("down")
    const next = await setup.waitForFrame((text) =>
      text.includes("2/2 ready accounting transactions")
    )
    assert.match(next, /description\s+Second ready trade/)
    assert.doesNotMatch(next, /2\/2 ready accounting transactions · \[m\]/)
    setup.mockInput.pressKey("m")
    await setup.renderOnce()
    assert.equal(requests.length, 2)
    setup.mockInput.pressKey("r")
    const refreshed = await setup.waitForFrame((text) =>
      text.includes("1/1 ready accounting transactions")
    )
    assert.match(refreshed, /description\s+Ready trade/)
    assert.equal(requests.length, 3)
    assert.equal(new URL(requests[2]?.url ?? "").searchParams.has("cursor"), false)
  }
  if (isShortTerminal) {
    assert.match(frame, /fee\s+0\.01 SOL/)
    await setup.mockInput.pressKeys(["ARROW_DOWN", "ARROW_DOWN", "ARROW_DOWN", "ARROW_DOWN"])
    const selected = await setup.waitForFrame((text) =>
      text.includes("5/8 ready accounting transactions")
    )
    assert.match(selected, /description\s+Trade 4/)
    assert.match(selected, /fee\s+0\.01 SOL/)
    assert.match(selected, /review\s+Needs review/)
    assert.match(selected, /\[b\] back/)
  }
  setup.mockInput.pressKey("b")
  setup.mockInput.pressKey("q")
  assert.equal(backCount, 1)
  assert.equal(quitCount, 1)
  assert.equal(expiredCount, 0)
} finally {
  setup.renderer.destroy()
  globalThis.fetch = originalFetch
  await disposeController()
}

process.stdout.write("Screen assertions passed\n")
