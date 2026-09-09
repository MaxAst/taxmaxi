/**
 * FactualLedgerRepositoryLive - Adapt the shared factual snapshot for calculations.
 *
 * @module FactualLedgerRepositoryLive
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { FactualLedgerRepository } from "../services/FactualLedgerRepository.ts"
import { makeFactualLedgerSnapshotReader } from "./FactualLedgerSnapshotReader.ts"

/** Live factual-ledger repository layer with unchanged calculation inputs. */
export const FactualLedgerRepositoryLive = Layer.effect(
  FactualLedgerRepository,
  Effect.map(makeFactualLedgerSnapshotReader, (reader) =>
    FactualLedgerRepository.of({
      load: (params) =>
        Effect.map(reader.load(params), ({ ledger, movements }) => ({ ...ledger, movements })),
    })
  )
)
