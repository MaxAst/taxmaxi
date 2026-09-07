import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  TaxMaxiError,
  isTaxMaxiUnauthorizedError,
  type TaxMaxi,
  type TransactionDetail,
} from "taxmaxi"
import { X } from "lucide-react"
import { queries } from "#/integrations/taxmaxi/queries"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "#/components/ui/dialog"
import { Drawer, DrawerContent, DrawerTitle, DrawerDescription } from "#/components/ui/drawer"
import { Button } from "#/components/ui/button"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"

type Correction = TransactionDetail["movementOverrides"][number]
type History = Correction["context"]["history"][number]
type Inputs = Correction["inputs"]["system"]
type AssetProjection = NonNullable<TransactionDetail["assetOverrides"][number]["projection"]>

type Selection = { transactionId: string; taxYear: number; description: string }

export function TransactionInspector({
  selection,
  taxmaxi,
  disabled,
  onUnauthorized,
  onClose,
  returnFocusRef,
  fallbackFocusRef,
}: {
  selection: Selection | null
  taxmaxi: TaxMaxi
  disabled: boolean
  onUnauthorized: () => void | Promise<void>
  onClose: () => void
  returnFocusRef: RefObject<HTMLElement | null>
  fallbackFocusRef?: RefObject<HTMLElement | null>
}) {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)")
    const update = () => setMobile(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  const closeRef = useRef<HTMLButtonElement>(null)
  const open = selection !== null && !disabled
  const restoreFocus = (event: Event) => {
    event.preventDefault()
    if (!open) {
      const opener = returnFocusRef.current
      const target = opener?.isConnected ? opener : fallbackFocusRef?.current
      target?.focus()
    }
  }
  const focusClose = (event: Event) => {
    event.preventDefault()
    closeRef.current?.focus()
  }
  const close = (
    <Button
      ref={closeRef}
      onClick={onClose}
      variant="outline"
      className="min-h-11 shrink-0"
      aria-label={m["app.inspector.close"]()}
    >
      <X aria-hidden="true" data-icon="inline-start" />
      {m["app.inspector.close"]()}
    </Button>
  )
  const content =
    selection && !disabled ? (
      <InspectorRequest
        key={`${selection.transactionId}:${selection.taxYear}`}
        selection={selection}
        taxmaxi={taxmaxi}
        onUnauthorized={onUnauthorized}
      />
    ) : null
  return mobile ? (
    <Drawer
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
    >
      <DrawerContent
        onOpenAutoFocus={focusClose}
        onCloseAutoFocus={restoreFocus}
        className="data-[vaul-drawer-direction=bottom]:max-h-[92dvh]"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <DrawerTitle>{m["app.inspector.title"]()}</DrawerTitle>
            <DrawerDescription className="mt-1 break-words">
              {selection?.description}
            </DrawerDescription>
          </div>
          {close}
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-6">{content}</div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
    >
      <DialogContent
        onOpenAutoFocus={focusClose}
        onCloseAutoFocus={restoreFocus}
        showCloseButton={false}
        className="flex max-h-[90dvh] flex-col gap-4 sm:max-w-3xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <DialogTitle>{m["app.inspector.title"]()}</DialogTitle>
            <DialogDescription className="mt-2 break-words">
              {selection?.description}
            </DialogDescription>
          </div>
          {close}
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain pr-2">{content}</div>
      </DialogContent>
    </Dialog>
  )
}

function InspectorRequest({
  selection,
  taxmaxi,
  onUnauthorized,
}: {
  selection: Selection
  taxmaxi: TaxMaxi
  onUnauthorized: () => void | Promise<void>
}) {
  const detail = useQuery(
    queries.transactionDetail(taxmaxi, {
      transactionId: selection.transactionId,
      taxYear: selection.taxYear,
    })
  )
  const regionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (isTaxMaxiUnauthorizedError(detail.error)) void onUnauthorized()
  }, [detail.error, onUnauthorized])
  const missing = detail.error instanceof TaxMaxiError && detail.error.status === 404
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label={m["app.treatment.heading"]({
        description: selection.description,
        transactionId: selection.transactionId,
      })}
      className="flex flex-col gap-5 outline-none"
    >
      <p className="text-sm text-muted-foreground">
        {m["app.treatment.requestedYear"]({ year: selection.taxYear })}
      </p>
      {detail.isPending ? (
        <p role="status">{m["app.treatment.loading"]()}</p>
      ) : detail.isError ? (
        <div className="flex flex-col gap-3">
          <p role="status">{missing ? m["app.inspector.missing"]() : m["app.treatment.error"]()}</p>
          <Button
            className="min-h-11"
            variant="outline"
            disabled={detail.isFetching}
            onClick={() => {
              regionRef.current?.focus()
              void detail.refetch()
            }}
          >
            {m["app.treatment.retry"]()}
          </Button>
        </div>
      ) : (
        <InspectorFacts detail={detail.data} />
      )}
    </section>
  )
}

const date = (value: string | number) =>
  new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(value))
const empty = () => m["app.treatment.unavailable"]()
const money = (value: string | null, currency?: string) =>
  value === null ? empty() : currency ? `${value} ${currency}` : value

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t pt-4">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  )
}
function Audit({ children }: { children: ReactNode }) {
  return (
    <details className="rounded-lg border px-3 py-1">
      <summary className="min-h-11 cursor-pointer content-center font-medium">
        {m["app.inspector.audit"]()}
      </summary>
      <div className="flex flex-col gap-3 pb-3">{children}</div>
    </details>
  )
}

const labels = {
  originId: () => m["app.inspector.field.originId"](),
  movementId: () => m["app.inspector.field.movementId"](),
  decisionMethod: () => m["app.inspector.field.decisionMethod"](),
  id: () => m["app.inspector.field.id"](),
  transactionId: () => m["app.inspector.field.transactionId"](),
  source: () => m["app.inspector.field.source"](),
  sourceId: () => m["app.inspector.field.sourceId"](),
  timestamp: () => m["app.inspector.field.timestamp"](),
  assetId: () => m["app.inspector.field.assetId"](),
  quantity: () => m["app.inspector.field.quantity"](),
  kind: () => m["app.inspector.field.kind"](),
  rule: () => m["app.inspector.field.rule"](),
  targetId: () => m["app.inspector.field.targetId"](),
  rawId: () => m["app.inspector.field.rawId"](),
  representationId: () => m["app.inspector.field.representationId"](),
  representationUseId: () => m["app.inspector.field.representationUseId"](),
  providerAssetRowId: () => m["app.inspector.field.providerAssetRowId"](),
  origin: () => m["app.inspector.field.origin"](),
  providerTransferId: () => m["app.inspector.field.providerTransferId"](),
  canonicalTransferId: () => m["app.inspector.field.canonicalTransferId"](),
  feeForTransactionId: () => m["app.inspector.field.feeForTransactionId"](),
  provider: () => m["app.inspector.field.provider"](),
  recordType: () => m["app.inspector.field.recordType"](),
  externalId: () => m["app.inspector.field.externalId"](),
  importedAt: () => m["app.inspector.field.importedAt"](),
  status: () => m["app.inspector.field.status"](),
  reason: () => m["app.inspector.field.reason"](),
  deterministic: () => m["app.inspector.field.deterministic"](),
  runId: () => m["app.inspector.field.runId"](),
  engineVersion: () => m["app.inspector.field.engineVersion"](),
  ruleSetVersion: () => m["app.inspector.field.ruleSetVersion"](),
  inputLedgerRevision: () => m["app.inspector.field.inputLedgerRevision"](),
  valuationRevision: () => m["app.inspector.field.valuationRevision"](),
  failureCode: () => m["app.inspector.field.failureCode"](),
  eventId: () => m["app.inspector.field.eventId"](),
  acquisitionEventId: () => m["app.inspector.field.acquisitionEventId"](),
  dispositionEventId: () => m["app.inspector.field.dispositionEventId"](),
  custodyUnitId: () => m["app.inspector.field.custodyUnitId"](),
  acquiredAt: () => m["app.inspector.field.acquiredAt"](),
  disposedAt: () => m["app.inspector.field.disposedAt"](),
  costBasisPerUnit: () => m["app.inspector.field.costBasisPerUnit"](),
  remainingQuantity: () => m["app.inspector.field.remainingQuantity"](),
  blocker: () => m["app.inspector.field.blocker"](),
  missingQuantity: () => m["app.inspector.field.missingQuantity"](),
  outcome: () => m["app.inspector.field.outcome"](),
  application: () => m["app.inspector.field.application"](),
  problem: () => m["app.inspector.field.problem"](),
  stale: () => m["app.inspector.field.stale"](),
  leafId: () => m["app.inspector.field.leafId"](),
  activeId: () => m["app.inspector.field.activeId"](),
  processingJobId: () => m["app.inspector.field.processingJobId"](),
  requestedJobId: () => m["app.inspector.field.requestedJobId"](),
  followUpJobId: () => m["app.inspector.field.followUpJobId"](),
  coverageStatus: () => m["app.inspector.field.coverageStatus"](),
  overrideId: () => m["app.inspector.field.overrideId"](),
  enteredTotal: () => m["app.inspector.field.enteredTotal"](),
  enteredUnit: () => m["app.inspector.field.enteredUnit"](),
  total: () => m["app.inspector.field.total"](),
  unit: () => m["app.inspector.field.unit"](),
  roundedUnit: () => m["app.inspector.field.roundedUnit"](),
  operation: () => m["app.inspector.field.operation"](),
  actor: () => m["app.inspector.field.actor"](),
  recordedAt: () => m["app.inspector.field.recordedAt"](),
  supersedes: () => m["app.inspector.field.supersedes"](),
  systemRevision: () => m["app.inspector.field.systemRevision"](),
  direction: () => m["app.inspector.field.direction"](),
  structure: () => m["app.inspector.field.structure"](),
  sourceRecordKey: () => m["app.inspector.field.sourceRecordKey"](),
  componentKey: () => m["app.inspector.field.componentKey"](),
  fiatAmount: () => m["app.inspector.field.fiatAmount"](),
  fiatCurrency: () => m["app.inspector.field.fiatCurrency"](),
  transactionType: () => m["app.inspector.field.transactionType"](),
  providerTransactionType: () => m["app.inspector.field.providerTransactionType"](),
  feeKey: () => m["app.inspector.field.feeKey"](),
  cause: () => m["app.inspector.field.cause"](),
  currency: () => m["app.inspector.field.currency"](),
  evidenceReference: () => m["app.inspector.field.evidenceReference"](),
  quotedAt: () => m["app.inspector.field.quotedAt"](),
  inclusion: () => m["app.inspector.field.inclusion"](),
  identity: () => m["app.inspector.field.identity"](),
  identityRevision: () => m["app.inspector.field.identityRevision"](),
  inclusionRevision: () => m["app.inspector.field.inclusionRevision"](),
  blockchain: () => m["app.inspector.field.blockchain"](),
  contractAddress: () => m["app.inspector.field.contractAddress"](),
  mintAddress: () => m["app.inspector.field.mintAddress"](),
  technicalBlockers: () => m["app.inspector.field.technicalBlockers"](),
  checkedTechnicalBlockers: () => m["app.inspector.field.checkedTechnicalBlockers"](),
  identityStale: () => m["app.inspector.field.identityStale"](),
  inclusionStale: () => m["app.inspector.field.inclusionStale"](),
  streamState: () => m["app.inspector.field.streamState"](),
  storedAssetId: () => m["app.inspector.field.storedAssetId"](),
  effectiveAssetId: () => m["app.inspector.field.effectiveAssetId"](),
  providerFiatAmount: () => m["app.inspector.field.providerFiatAmount"](),
  providerFiatCurrency: () => m["app.inspector.field.providerFiatCurrency"](),
  fromSource: () => m["app.inspector.field.fromSource"](),
  toSource: () => m["app.inspector.field.toSource"](),
  principalId: () => m["app.inspector.field.principalId"](),
  reconciliationId: () => m["app.inspector.field.reconciliationId"](),
  canonicalSourceId: () => m["app.inspector.field.canonicalSourceId"](),
  providerSourceId: () => m["app.inspector.field.providerSourceId"](),
  canonicalStoredAssetId: () => m["app.inspector.field.canonicalStoredAssetId"](),
  providerStoredAssetId: () => m["app.inspector.field.providerStoredAssetId"](),
  providerTransactionId: () => m["app.inspector.field.providerTransactionId"](),
  canonicalTransactionId: () => m["app.inspector.field.canonicalTransactionId"](),
}
function Fields({ values }: { values: Partial<Record<keyof typeof labels, ReactNode>> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-2 text-sm">
      {Object.entries(values).map(([key, value]) => (
        <Field key={key} label={labels[key as keyof typeof labels]()} value={value} />
      ))}
    </dl>
  )
}
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere] tabular-nums">
        {value ?? empty()}
      </dd>
    </>
  )
}
const yesNo = (value: boolean) => (value ? m["app.inspector.yes"]() : m["app.inspector.no"]())
const reconciliationReason = (code: string): string => {
  switch (code) {
    case "provider_transfer_missing_wallet_address":
      return m["app.inspector.reconciliation.provider_transfer_missing_wallet_address"]()
    case "canonical_transfer_claim_conflict":
      return m["app.inspector.reconciliation.canonical_transfer_claim_conflict"]()
    case "no_candidate_onchain_receipt":
      return m["app.inspector.reconciliation.no_candidate_onchain_receipt"]()
    case "multiple_candidate_onchain_receipts":
      return m["app.inspector.reconciliation.multiple_candidate_onchain_receipts"]()
    case "provider_asset_mapping_pending":
      return m["app.inspector.reconciliation.provider_asset_mapping_pending"]()
    case "destination_representation_mapping_rejected":
      return m["app.inspector.reconciliation.destination_representation_mapping_rejected"]()
    case "representation_economic_asset_conflict":
      return m["app.inspector.reconciliation.representation_economic_asset_conflict"]()
    case "provider_asset_representation_conflict":
      return m["app.inspector.reconciliation.provider_asset_representation_conflict"]()
    case "destination_source_replay_pending":
      return m["app.inspector.reconciliation.destination_source_replay_pending"]()
    case "deterministic_wallet_receipt_match":
      return m["app.inspector.reconciliation.deterministic_wallet_receipt_match"]()
    case "asset_representation_review_pending":
      return m["app.inspector.reconciliation.asset_representation_review_pending"]()
    case "destination_representation_observation_missing":
      return m["app.inspector.reconciliation.destination_representation_observation_missing"]()
    case "canonical_transfer_claim_conflict_pending_rollback":
      return m["app.inspector.reconciliation.canonical_transfer_claim_conflict_pending_rollback"]()
    case "source_replay_pending_reconciliation":
      return m["app.inspector.reconciliation.source_replay_pending_reconciliation"]()
    case "movement_facts_changed_before_canonicalization":
      return m["app.inspector.reconciliation.movement_facts_changed_before_canonicalization"]()
    case "manual_transaction_review_preserved":
      return m["app.inspector.reconciliation.manual_transaction_review_preserved"]()
    case "candidate_set_changed_during_reconciliation":
      return m["app.inspector.reconciliation.candidate_set_changed_during_reconciliation"]()
    case "canonical_transfer_already_approved":
      return m["app.inspector.reconciliation.canonical_transfer_already_approved"]()
    case "canonical_transfer_already_reconciled":
      return m["app.inspector.reconciliation.canonical_transfer_already_reconciled"]()
    default:
      return m["app.inspector.reconciliation.unknown"]({ code })
  }
}

const state = (value: string | null) => {
  switch (value) {
    case "pending":
      return m["app.inspector.state.pending"]()
    case "running":
      return m["app.inspector.state.running"]()
    case "complete":
      return m["app.inspector.state.complete"]()
    case "partial":
      return m["app.inspector.state.partial"]()
    case "failed":
      return m["app.inspector.state.failed"]()
    case "updating":
      return m["app.inspector.state.updating"]()
    case "not_scheduled":
      return m["app.inspector.state.not_scheduled"]()
    case "not_requested":
      return m["app.inspector.state.not_requested"]()
    case "covered":
      return m["app.inspector.state.covered"]()
    case "outside_period":
      return m["app.inspector.state.outside_period"]()
    case "inactive":
      return m["app.inspector.state.inactive"]()
    case "not_applied":
      return m["app.inspector.state.not_applied"]()
    case "applied":
      return m["app.inspector.state.applied"]()
    case "needs_attention":
      return m["app.inspector.state.needs_attention"]()
    case "active":
      return m["app.inspector.state.active"]()
    case "withdrawn":
      return m["app.inspector.state.withdrawn"]()
    case "superseded":
      return m["app.inspector.state.superseded"]()
    case "create":
      return m["app.inspector.state.create"]()
    case "replace":
      return m["app.inspector.state.replace"]()
    case "withdraw":
      return m["app.inspector.state.withdraw"]()
    case "included":
      return m["app.inspector.state.included"]()
    case "excluded":
      return m["app.inspector.state.excluded"]()
    case "blocked":
      return m["app.inspector.state.blocked"]()
    case "withheld":
      return m["app.inspector.state.withheld"]()
    case "absent":
      return m["app.inspector.state.absent"]()
    case "available":
      return m["app.inspector.state.available"]()
    case "unavailable":
      return m["app.inspector.state.unavailable"]()
    case "acquisition":
      return m["app.inspector.state.acquisition"]()
    case "disposal":
      return m["app.inspector.state.disposal"]()
    case "income":
      return m["app.inspector.state.income"]()
    case "fee":
      return m["app.inspector.state.fee"]()
    case "inbound":
      return m["app.inspector.state.inbound"]()
    case "outbound":
      return m["app.inspector.state.outbound"]()
    case "ownership_change":
      return m["app.inspector.state.ownership_change"]()
    case "custody":
      return m["app.inspector.state.custody"]()
    case "approved":
      return m["app.inspector.state.approved"]()
    case "rejected":
      return m["app.inspector.state.rejected"]()
    case "auto_applied":
      return m["app.inspector.state.auto_applied"]()
    case "needs_review":
      return m["app.inspector.state.needs_review"]()
    case "credit_required":
      return m["app.inspector.state.credit_required"]()
    case "purchase":
      return m["app.inspector.state.purchase"]()
    case "sale":
      return m["app.inspector.state.sale"]()
    case "gift":
      return m["app.inspector.state.gift"]()
    case "airdrop":
      return m["app.inspector.state.airdrop"]()
    case "mining_reward":
      return m["app.inspector.state.mining_reward"]()
    case "staking_reward":
      return m["app.inspector.state.staking_reward"]()
    case "passive_staking_reward":
      return m["app.inspector.state.passive_staking_reward"]()
    case "reward":
      return m["app.inspector.state.reward"]()
    case "payment":
      return m["app.inspector.state.payment"]()
    case "unknown":
      return m["app.inspector.state.unknown"]()
    case "custody_movement":
      return m["app.inspector.state.custody_movement"]()
    case "disposition":
      return m["app.inspector.state.disposition"]()
    case "observed_consideration":
      return m["app.inspector.state.observed_consideration"]()
    case "market_quote":
      return m["app.inspector.state.market_quote"]()
    case "user_valuation":
      return m["app.inspector.state.user_valuation"]()
    case "user_assertion":
      return m["app.inspector.state.user_assertion"]()
    case "provider_transfer":
      return m["app.inspector.state.provider_transfer"]()
    case "canonical_transfer":
      return m["app.inspector.state.canonical_transfer"]()
    case "transaction":
      return m["app.inspector.state.transaction"]()
    case "leg":
      return m["app.inspector.state.leg"]()
    case "none":
      return m["app.inspector.state.none"]()
    case "deterministic":
      return m["app.inspector.state.deterministic"]()
    case "rule":
      return m["app.inspector.state.rule"]()
    case "ai":
      return m["app.inspector.state.ai"]()
    case "manual":
      return m["app.inspector.state.manual"]()
    case "target_unavailable":
      return m["app.inspector.state.target_unavailable"]()
    case "target_ineligible":
      return m["app.inspector.state.target_ineligible"]()
    case "target_changed":
      return m["app.inspector.state.target_changed"]()
    case "quantity_changed":
      return m["app.inspector.state.quantity_changed"]()
    case "asset_changed":
      return m["app.inspector.state.asset_changed"]()
    case "structure_changed":
      return m["app.inspector.state.structure_changed"]()
    case "reporting_currency_mismatch":
      return m["app.inspector.state.reporting_currency_mismatch"]()
    case "technical_blocker":
      return m["app.inspector.state.technical_blocker"]()
    case "unresolved_identity":
      return m["app.inspector.state.unresolved_identity"]()
    default:
      return value === null ? empty() : <code>{value}</code>
  }
}

function InspectorFacts({ detail }: { detail: TransactionDetail }) {
  return (
    <>
      <Section title={m["app.inspector.facts"]()}>
        <Fields
          values={{
            timestamp: date(detail.timestamp),
            source: detail.source.name,
            transactionType: state(detail.transactionType),
            providerTransactionType: state(detail.providerTransactionType),
            externalId: detail.externalId,
          }}
        />
        <p className="text-xs text-muted-foreground">
          {m["app.inspector.classificationUnavailable"]()}
        </p>
        <Audit>
          <Fields
            values={{
              transactionId: detail.transactionId,
              sourceId: detail.source.sourceId,
              rawId: detail.sourceRawRecordId,
            }}
          />
        </Audit>
      </Section>
      <Section title={m["app.inspector.movements"]()}>
        {detail.movements.map((movement) => (
          <article key={movement.id} className="flex flex-col gap-3 rounded-lg border p-3">
            <Fields
              values={{
                kind: state(movement.kind),
                quantity: movement.amount,
                assetId: movement.assetId,
                timestamp: date(movement.timestamp),
              }}
            />
            <Audit>
              <Fields
                values={{
                  id: movement.id,
                  transactionId: movement.transactionId,
                  sourceId: movement.sourceId,
                  targetId: movement.movementCorrectionTargetId,
                  origin: state(movement.originKind),
                  rule: movement.derivationRule,
                  decisionMethod: state(movement.provenance),
                  rawId: movement.sourceRawRecordId,
                  representationUseId: movement.sourceRepresentationUseId,
                  providerAssetRowId: movement.providerAssetRowId,
                  representationId: movement.assetRepresentationId,
                  providerTransferId: movement.providerTransferId,
                  canonicalTransferId: movement.sourceTransferId,
                  feeForTransactionId: movement.feeForTransactionId,
                }}
              />
            </Audit>
          </article>
        ))}
      </Section>
      <Section title={m["app.inspector.evidence"]()}>
        {detail.sourceEvidence.length === 0 ? (
          <p>{m["app.inspector.noEvidence"]()}</p>
        ) : (
          detail.sourceEvidence.map((item, index) => (
            <article
              className="flex flex-col gap-2 rounded-lg border p-3"
              key={`${item.origin}:${item.originId}:${index}`}
            >
              <Fields
                values={{
                  origin: state(item.origin),
                  status: state(item.status),
                  rawId: item.sourceRawRecordId,
                }}
              />
              {item.evidence ? (
                <Fields
                  values={{
                    provider: item.evidence.provider,
                    recordType: item.evidence.recordType,
                    externalId: item.evidence.externalRecordId,
                    timestamp: date(item.evidence.occurredAt),
                    importedAt: date(item.evidence.importedAt),
                  }}
                />
              ) : (
                <p>{m["app.inspector.notRetained"]()}</p>
              )}
              <Audit>
                <Fields
                  values={{
                    id: item.evidence?.id,
                    sourceId: item.sourceId,
                    originId: item.originId,
                  }}
                />
              </Audit>
            </article>
          ))
        )}
      </Section>
      {detail.reconciliations.length ? (
        <Section title={m["app.inspector.reconciliations"]()}>
          {detail.reconciliations.map((item) => (
            <article className="flex flex-col gap-3" key={item.id}>
              <Fields
                values={{
                  status: state(item.status),
                  reason: reconciliationReason(item.matchReason),
                  deterministic: yesNo(item.deterministic),
                }}
              />
              <Audit>
                <Fields
                  values={{
                    id: item.id,
                    providerTransferId: item.providerTransferId,
                    canonicalTransferId: item.canonicalTransferId,
                    transactionId: item.canonicalTransactionId,
                  }}
                />
              </Audit>
            </article>
          ))}
        </Section>
      ) : null}
      <Calculation calculation={detail.calculation} />
      <Section title={m["app.inspector.current"]()}>
        {detail.movementOverrides.length === 0 ? (
          <p>{m["app.inspector.noHistory"]()}</p>
        ) : (
          detail.movementOverrides.map((projection) => (
            <CurrentCorrection key={projection.context.targetId} projection={projection} />
          ))
        )}
      </Section>
      <Section title={m["app.inspector.assets"]()}>
        {detail.assetOverrides.length === 0 ? (
          <p>{m["app.inspector.none"]()}</p>
        ) : (
          detail.assetOverrides.map((item) => (
            <article key={item.movementId} className="flex flex-col gap-3 rounded-lg border p-3">
              <Fields values={{ movementId: item.movementId }} />
              {item.projection ? (
                <AssetDecision projection={item.projection} />
              ) : (
                <p>{m["app.inspector.notRetained"]()}</p>
              )}
            </article>
          ))
        )}
      </Section>
      <Section title={m["app.inspector.captured"]()}>
        <p className="text-sm text-muted-foreground">{m["app.inspector.capturedHint"]()}</p>
        {detail.calculation.run === null ? (
          <p>{m["app.inspector.noRunInputs"]()}</p>
        ) : detail.calculation.correctionInputs.length === 0 ? (
          <p>{m["app.inspector.noCaptured"]()}</p>
        ) : (
          detail.calculation.correctionInputs.map((input) => (
            <article key={input.history.id} className="flex flex-col gap-3 rounded-lg border p-3">
              <Fields
                values={{
                  runId: detail.calculation.run?.id,
                  overrideId: input.history.id,
                  targetId: input.history.targetId,
                  streamState: state(input.streamState),
                  outcome: state(input.currentOutcome),
                  application: state(input.application),
                  problem: state(input.applicationProblem),
                  currency: input.reportingCurrency,
                }}
              />
              <ResolvedPrice price={input.resolvedPrice} />
              <Section title={m["app.inspector.system"]()}>
                <EngineInputs inputs={input.system} />
              </Section>
              <Section title={m["app.inspector.effective"]()}>
                <EngineInputs inputs={input.effective} />
              </Section>
              <Audit>
                <HistoryRecord record={input.history} />
                {input.current ? (
                  <LegFacts current={input.current} />
                ) : (
                  <p>{m["app.inspector.notRetained"]()}</p>
                )}
              </Audit>
            </article>
          ))
        )}
      </Section>
    </>
  )
}

function Calculation({ calculation }: { calculation: TransactionDetail["calculation"] }) {
  const run = calculation.run
  return (
    <Section title={m["app.inspector.calculation"]()}>
      {run === null ? (
        <p>{m["app.treatment.noRun"]()}</p>
      ) : (
        <>
          <p className="break-all">
            {m["app.treatment.run"]({
              runId: run.id,
              year: run.taxYear,
              jurisdiction: run.jurisdiction,
              currency: run.reportingCurrency,
            })}
          </p>
          <p>
            {m["app.inspector.runStatus"]()}: {state(run.status)}
          </p>
          <Audit>
            <Fields
              values={{
                engineVersion: run.engineVersion,
                ruleSetVersion: run.ruleSetVersion,
                inputLedgerRevision: run.inputLedgerRevision,
                valuationRevision: run.valuationRevision,
                failureCode: run.failureCode,
              }}
            />
          </Audit>
        </>
      )}
      <p>
        {calculation.state === "partial"
          ? m["app.treatment.partial"]()
          : m["app.treatment.complete"]()}
      </p>
      <p>{monetaryStatusLabel(calculation.monetaryStatus)}</p>
      {calculation.allocations.length === 0 && calculation.income.length === 0 ? (
        <p>{m["app.treatment.noResults"]()}</p>
      ) : null}
      {calculation.allocations.map((result, index) => (
        <section
          aria-label={m["app.treatment.allocation"]({ sequence: index + 1 })}
          className="flex flex-col gap-3 rounded-lg border p-3"
          key={result.sequence}
        >
          <h4 className="font-medium">{m["app.treatment.allocation"]({ sequence: index + 1 })}</h4>
          <p className="break-all">{m["app.treatment.asset"]({ assetId: result.assetId })}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Field label={m["app.treatment.quantity"]()} value={result.quantity} />
            <Field
              label={m["app.treatment.costBasis"]()}
              value={money(result.costBasis, run?.reportingCurrency)}
            />
            <Field
              label={m["app.treatment.proceeds"]()}
              value={money(result.proceeds, run?.reportingCurrency)}
            />
            <Field
              label={m["app.treatment.gainLoss"]()}
              value={money(result.gainLoss, run?.reportingCurrency)}
            />
          </dl>
          <Fields
            values={{ acquiredAt: date(result.acquiredAt), disposedAt: date(result.disposedAt) }}
          />
          <TreatmentCodes codes={result.treatmentCodes} />
          <Audit>
            <Fields
              values={{
                acquisitionEventId: result.acquisitionEventId,
                dispositionEventId: result.dispositionEventId,
                custodyUnitId: result.custodyUnitId,
              }}
            />
          </Audit>
        </section>
      ))}
      {calculation.income.map((result, index) => (
        <section
          aria-label={m["app.treatment.income"]({ sequence: index + 1 })}
          className="flex flex-col gap-3 rounded-lg border p-3"
          key={result.sequence}
        >
          <h4 className="font-medium">{m["app.treatment.income"]({ sequence: index + 1 })}</h4>
          <p className="break-all">{m["app.treatment.asset"]({ assetId: result.assetId })}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Field label={m["app.treatment.quantity"]()} value={result.quantity} />
            <Field
              label={m["app.treatment.value"]()}
              value={money(result.value, run?.reportingCurrency)}
            />
          </dl>
          <Fields values={{ timestamp: date(result.occurredAt) }} />
          <TreatmentCodes codes={result.treatmentCodes} />
          <Audit>
            <Fields values={{ eventId: result.eventId, sourceId: result.sourceId }} />
          </Audit>
        </section>
      ))}
      {calculation.derivedLots.length ? (
        <Section title={m["app.inspector.lots"]()}>
          {calculation.derivedLots.map((lot) => (
            <article className="flex flex-col gap-3 rounded-lg border p-3" key={lot.sequence}>
              <Fields
                values={{
                  assetId: lot.assetId,
                  acquiredAt: date(lot.acquiredAt),
                  remainingQuantity: lot.remainingQuantity,
                  costBasisPerUnit: money(lot.costBasisPerUnit, run?.reportingCurrency),
                }}
              />
              <Audit>
                <Fields
                  values={{
                    acquisitionEventId: lot.acquisitionEventId,
                    custodyUnitId: lot.custodyUnitId,
                  }}
                />
              </Audit>
            </article>
          ))}
        </Section>
      ) : null}
      {calculation.blockers.length ? (
        <Section title={m["app.inspector.blockers"]()}>
          {calculation.blockers.map((blocker) => (
            <article className="flex flex-col gap-3 rounded-lg border p-3" key={blocker.sequence}>
              <Fields
                values={{
                  blocker: blocker.code,
                  missingQuantity: blocker.missingQuantity,
                  assetId: blocker.assetId,
                }}
              />
              <Audit>
                <Fields
                  values={{
                    eventId: blocker.eventId,
                    providerAssetRowId: blocker.providerAssetRowId,
                    custodyUnitId: blocker.custodyUnitId,
                  }}
                />
              </Audit>
            </article>
          ))}
        </Section>
      ) : null}
    </Section>
  )
}

const treatmentLabel = (code: string) => {
  switch (code) {
    case "de.taxable_private_disposal":
      return m["app.treatment.codes.taxableDisposal"]()
    case "de.tax_free_holding_period":
      return m["app.treatment.codes.holdingPeriod"]()
    case "de.taxable_income_section22_3_staking":
      return m["app.treatment.codes.stakingIncome"]()
    default:
      return m["app.treatment.codes.unknown"]()
  }
}
function TreatmentCodes({ codes }: { codes: ReadonlyArray<string> }) {
  return codes.length === 0 ? (
    <p className="text-muted-foreground">{m["app.treatment.noCodes"]()}</p>
  ) : (
    <ul className="flex flex-col gap-1">
      {codes.map((code, index) => (
        <li key={`${index}:${code}`}>
          <span className="block">{treatmentLabel(code)}</span>
          <code className="block break-all text-xs text-muted-foreground">{code}</code>
        </li>
      ))}
    </ul>
  )
}
const monetaryStatusLabel = (status: TransactionDetail["calculation"]["monetaryStatus"]) => {
  switch (status) {
    case "available":
      return m["app.treatment.moneyAvailable"]()
    case "partial":
      return m["app.treatment.moneyPartial"]()
    case "unavailable":
      return m["app.treatment.moneyUnavailable"]()
    case "not_applicable":
      return m["app.treatment.moneyNotApplicable"]()
  }
}

function EngineInputs({ inputs }: { inputs: Inputs }) {
  const event = inputs.event
  return (
    <div className="flex flex-col gap-3">
      {event ? (
        <Fields
          values={{
            kind: state(event._tag),
            quantity: event.quantity,
            assetId: event.assetId,
            timestamp: date(event.occurredAt.epochMillis),
            eventId: event.id,
            externalId: event.transactionReference,
            ...(event._tag === "custody_movement"
              ? { fromSource: event.fromCustodySourceId, toSource: event.toCustodySourceId }
              : { cause: state(event.cause), sourceId: event.custodySourceId }),
          }}
        />
      ) : (
        <p>{m["app.inspector.notRetained"]()}</p>
      )}
      <Valuations facts={inputs.valuationFacts} />
      {inputs.classificationEvidence ? (
        <Fields
          values={{
            origin: state(inputs.classificationEvidence._tag),
            overrideId: inputs.classificationEvidence.overrideId,
          }}
        />
      ) : null}
    </div>
  )
}
function Valuations({ facts }: { facts: Inputs["valuationFacts"] }) {
  return facts.length === 0 ? (
    <p className="text-sm text-muted-foreground">
      {m["app.inspector.valuation"]()}: {m["app.inspector.none"]()}
    </p>
  ) : (
    <ul className="flex flex-col gap-3">
      {facts.map((fact, index) => (
        <li key={`${fact.eventId}:${index}`}>
          <Fields
            values={{
              kind: state(fact._tag),
              eventId: fact.eventId,
              ...(fact._tag === "market_quote"
                ? {
                    unit: money(fact.unitPrice.amount, fact.unitPrice.currency),
                    quotedAt: date(fact.quotedAt.epochMillis),
                    source: fact.source,
                  }
                : {
                    total: money(fact.amount.amount, fact.amount.currency),
                    evidenceReference: fact.evidenceReference,
                  }),
            }}
          />
        </li>
      ))}
    </ul>
  )
}
function ResolvedPrice({ price }: { price: Correction["price"]["resolvedPrice"] }) {
  return price ? (
    <Fields
      values={{
        total: money(price.totalValue, price.currency),
        ...(price.unitPrice.rounded
          ? { roundedUnit: money(price.unitPrice.amount, price.currency) }
          : { unit: money(price.unitPrice.amount, price.currency) }),
      }}
    />
  ) : null
}
function UserInput({ input }: { input: History["input"] }) {
  if (input === null) return <p>{m["app.inspector.noActive"]()}</p>
  if (input._tag === "classification")
    return (
      <Fields values={{ direction: state(input.input._tag), cause: state(input.input.cause) }} />
    )
  return (
    <Fields
      values={
        input.input._tag === "total_value"
          ? { enteredTotal: money(input.input.amount, input.input.currency) }
          : { enteredUnit: money(input.input.amount, input.input.currency) }
      }
    />
  )
}
function SystemEvidence({ system }: { system: History["inspectedSystem"] }) {
  return (
    <Fields
      values={{
        timestamp: date(system.occurredAt),
        kind: state(system.legKind),
        fiatAmount: system.recordedFiatAmount,
        fiatCurrency: system.recordedFiatCurrency,
        transactionType: state(system.transactionType),
        providerTransactionType: state(system.providerTransactionType),
        rule: system.derivationRule,
        feeKey: system.feeForSourceRecordKey,
      }}
    />
  )
}
function InspectedFacts({ facts }: { facts: History["inspectedFacts"] }) {
  return (
    <Fields
      values={{
        quantity: facts.quantity,
        assetId: facts.economicAssetId,
        direction: state(facts.direction),
        structure: state(facts.structure),
        systemRevision: facts.systemRevision,
        principalId: facts.target.principalId,
        sourceId: facts.target.sourceId,
        sourceRecordKey: facts.target.sourceRecordKey,
        componentKey: facts.target.componentKey,
      }}
    />
  )
}
function HistoryRecord({ record }: { record: History }) {
  return (
    <article className="flex flex-col gap-3 border-t pt-3">
      <Fields
        values={{
          kind:
            record.kind === "price"
              ? m["app.inspector.price"]()
              : m["app.inspector.classification"](),
          operation: state(record.operation),
          actor: record.actorUserId,
          recordedAt: date(record.recordedAt),
          reason: record.reason,
          id: record.id,
          supersedes: record.supersedesOverrideId,
        }}
      />
      <UserInput input={record.input} />
      <details>
        <summary className="min-h-11 cursor-pointer content-center">
          {m["app.inspector.inspected"]()}
        </summary>
        <div className="flex flex-col gap-3">
          <InspectedFacts facts={record.inspectedFacts} />
          <SystemEvidence system={record.inspectedSystem} />
          <Fields values={{ currency: record.inspectedValuationEvidence.reportingCurrency }} />
          <Valuations facts={record.inspectedValuationEvidence.facts} />
        </div>
      </details>
    </article>
  )
}
function Stream({ stream, title }: { stream: Correction["price"]; title: string }) {
  return (
    <Section title={title}>
      <p className="font-medium">{m["app.inspector.user"]()}</p>
      <UserInput input={stream.active?.input ?? null} />
      <ResolvedPrice price={stream.resolvedPrice} />
      <p className="font-medium">{m["app.inspector.attention"]()}</p>
      <Fields
        values={{
          application: state(stream.application),
          problem: state(stream.applicationProblem),
          stale: yesNo(stream.stale),
        }}
      />
      <p className="font-medium">{m["app.inspector.replay"]()}</p>
      <Fields values={{ status: state(stream.replay.status) }} />
      <p className="font-medium">{m["app.inspector.coverage"]()}</p>
      <Fields values={{ coverageStatus: state(stream.coverageStatus) }} />
      {stream.coverage ? (
        <div className="flex flex-col gap-3">
          <Fields
            values={{
              runId: stream.coverage.runId,
              status: state(stream.coverage.status),
              overrideId: stream.coverage.overrideId,
              application: state(stream.coverage.input.application),
              problem: state(stream.coverage.input.applicationProblem),
              failureCode: stream.coverage.failureCode,
            }}
          />
          <ResolvedPrice price={stream.coverage.input.resolvedPrice} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{m["app.inspector.noCoverage"]()}</p>
      )}
      <Audit>
        <Fields
          values={{
            leafId: stream.leaf?.id,
            activeId: stream.active?.id,
            processingJobId: stream.replay.processingJobId,
            followUpJobId: stream.replay.followUpJobId,
          }}
        />
        {stream.coverage ? (
          <>
            <Section title={m["app.inspector.system"]()}>
              <EngineInputs inputs={stream.coverage.input.system} />
            </Section>
            <Section title={m["app.inspector.effective"]()}>
              <EngineInputs inputs={stream.coverage.input.effective} />
            </Section>
          </>
        ) : null}
      </Audit>
    </Section>
  )
}
function LegFacts({ current }: { current: NonNullable<Correction["inputs"]["current"]> }) {
  return (
    <div className="flex flex-col gap-3">
      <Fields
        values={{
          targetId: current.targetId,
          id: current.legId,
          sourceId: current.sourceId,
          transactionId: current.transactionId,
          timestamp: date(current.occurredAt),
          quantity: current.quantity,
          storedAssetId: current.storedAssetId,
          effectiveAssetId: current.effectiveAssetId,
          direction: state(current.direction),
          structure: state(current.structure),
          kind: state(current.legKind),
          transactionType: state(current.transactionType),
          providerTransactionType: state(current.providerTransactionType),
          fiatAmount: current.recordedFiatAmount,
          fiatCurrency: current.recordedFiatCurrency,
          providerFiatAmount: current.providerFiatAmount,
          providerFiatCurrency: current.providerFiatCurrency,
          rule: current.derivationRule,
          feeKey: current.feeForSourceRecordKey,
          origin: state(current.originKind),
          canonicalTransferId: current.sourceTransferId,
          providerTransferId: current.providerTransferId,
        }}
      />
      {current.custody.length ? (
        <Section title={m["app.inspector.custody"]()}>
          {current.custody.map((link) => (
            <Fields
              key={link.reconciliationId}
              values={{
                reconciliationId: link.reconciliationId,
                canonicalTransferId: link.canonicalTransferId,
                providerTransferId: link.providerTransferId,
                canonicalTransactionId: link.canonicalTransactionId,
                providerTransactionId: link.providerTransactionId,
                canonicalSourceId: link.canonicalSourceId,
                providerSourceId: link.providerSourceId,
                timestamp: date(link.occurredAt),
                quantity: link.quantity,
                canonicalStoredAssetId: link.canonicalStoredAssetId,
                providerStoredAssetId: link.providerStoredAssetId,
                direction: state(link.providerDirection),
                outcome: state(link.outcome),
              }}
            />
          ))}
        </Section>
      ) : null}
    </div>
  )
}
function CurrentCorrection({ projection }: { projection: Correction }) {
  const current = projection.context.current
  return (
    <article className="flex flex-col gap-3 rounded-lg border p-3">
      <Fields
        values={{
          targetId: projection.context.targetId,
          outcome: state(projection.inputs.currentOutcome),
        }}
      />
      <Section title={m["app.inspector.system"]()}>
        <EngineInputs inputs={projection.inputs.system} />
      </Section>
      <Section title={m["app.inspector.effective"]()}>
        <EngineInputs inputs={projection.inputs.effective} />
      </Section>
      <Stream title={m["app.inspector.price"]()} stream={projection.price} />
      <Stream title={m["app.inspector.classification"]()} stream={projection.classification} />
      <details>
        <summary className="min-h-11 cursor-pointer content-center font-medium">
          {m["app.inspector.history"]()}
        </summary>
        {projection.context.history.length ? (
          projection.context.history.map((record) => (
            <HistoryRecord key={record.id} record={record} />
          ))
        ) : (
          <p>{m["app.inspector.noHistory"]()}</p>
        )}
      </details>
      <Audit>
        {current ? (
          <>
            <InspectedFacts facts={current.facts} />
            <SystemEvidence system={current.system} />
            <Fields values={{ currency: current.valuationEvidence.reportingCurrency }} />
            <Valuations facts={current.valuationEvidence.facts} />
          </>
        ) : (
          <p>{m["app.inspector.notRetained"]()}</p>
        )}
        {projection.inputs.current ? <LegFacts current={projection.inputs.current} /> : null}
      </Audit>
    </article>
  )
}

const identity = (value: AssetProjection["system"]["identity"] | null) =>
  value?._tag === "resolved" ? value.assetId : m["app.inspector.unresolved"]()
function AssetHistory({ record }: { record: AssetProjection["history"][number] }) {
  return (
    <article className="flex flex-col gap-3 border-t pt-3">
      <Fields
        values={{
          id: record.id,
          kind: record.kind === "identity" ? labels.identity() : labels.inclusion(),
          operation: state(record.operation),
          actor: record.actorUserId,
          recordedAt: date(record.recordedAt),
          reason: record.reason,
          supersedes: record.supersedesOverrideId,
        }}
      />
      <p className="font-medium">{m["app.inspector.user"]()}</p>
      <Fields
        values={{
          identity: record.replacementIdentity ? identity(record.replacementIdentity) : null,
          inclusion: state(record.replacementInclusion),
        }}
      />
      <p className="font-medium">{m["app.inspector.inspected"]()}</p>
      <Fields
        values={{
          systemRevision: record.inspectedSystemRevision,
          identity: record.inspectedSystemIdentity
            ? identity(record.inspectedSystemIdentity)
            : null,
          inclusion: state(record.inspectedSystemInclusion),
        }}
      />
    </article>
  )
}
function AssetDecision({ projection }: { projection: AssetProjection }) {
  const decision = projection.effectiveDecision
  const work = projection.recomputation
  return (
    <>
      <Section title={m["app.inspector.system"]()}>
        <Fields
          values={{
            identity: identity(projection.system.identity),
            inclusion: state(projection.system.inclusion),
          }}
        />
      </Section>
      <Section title={m["app.inspector.user"]()}>
        <Fields
          values={{
            identity: projection.activeIdentityOverride
              ? identity(projection.activeIdentityOverride.replacementIdentity)
              : m["app.inspector.noActive"](),
            inclusion: projection.activeInclusionOverride
              ? state(projection.activeInclusionOverride.replacementInclusion)
              : m["app.inspector.noActive"](),
          }}
        />
      </Section>
      <Section title={m["app.inspector.effective"]()}>
        <Fields
          values={{
            status: state(decision._tag),
            assetId: decision._tag === "included" ? decision.assetId : identity(decision.identity),
            ...(decision._tag === "blocked" ? { reason: state(decision.reason) } : {}),
            technicalBlockers: projection.technicalBlockers.length
              ? projection.technicalBlockers.join(", ")
              : m["app.inspector.none"](),
            identityStale: yesNo(projection.identityOverrideUsesStaleSystemRevision),
            inclusionStale: yesNo(projection.inclusionOverrideUsesStaleSystemRevision),
          }}
        />
      </Section>
      <Section title={m["app.inspector.replay"]()}>
        <Fields values={{ status: state(work.status) }} />
        {work.status !== "not_scheduled" ? (
          <>
            {work.sourceJobs.map((job, index) => (
              <Fields
                key={`${job.overrideId}:${job.sourceId}:${index}`}
                values={{
                  overrideId: job.overrideId,
                  sourceId: job.sourceId,
                  processingJobId: job.jobId,
                  requestedJobId: job.requestedJobId,
                  status: state(job.status),
                  failureCode: job.failureCode,
                }}
              />
            ))}
            <p className="font-medium">{m["app.inspector.coverage"]()}</p>
            {work.calculationRun ? (
              <Fields
                values={{
                  runId: work.calculationRun.runId,
                  status: state(work.calculationRun.status),
                  failureCode: work.calculationRun.failureCode,
                }}
              />
            ) : (
              <p>{m["app.inspector.noCoverage"]()}</p>
            )}
          </>
        ) : null}
      </Section>
      <details>
        <summary className="min-h-11 cursor-pointer content-center font-medium">
          {m["app.inspector.assetHistory"]()}
        </summary>
        {projection.history.length ? (
          projection.history.map((record) => <AssetHistory key={record.id} record={record} />)
        ) : (
          <p>{m["app.inspector.noHistory"]()}</p>
        )}
      </details>
      <Audit>
        <Fields
          values={{
            identityRevision: projection.system.identityRevision,
            inclusionRevision: projection.system.inclusionRevision,
            checkedTechnicalBlockers: projection.checkedTechnicalBlockerKinds.length
              ? projection.checkedTechnicalBlockerKinds.join(", ")
              : m["app.inspector.none"](),
            ...(projection.target._tag === "provider_asset"
              ? { providerAssetRowId: projection.target.providerAssetRowId }
              : {
                  blockchain: projection.target.blockchain,
                  kind: projection.target.type,
                  contractAddress: projection.target.contractAddress,
                  mintAddress: projection.target.mintAddress,
                }),
          }}
        />
      </Audit>
    </>
  )
}
