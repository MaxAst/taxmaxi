import * as Effect from "effect/Effect"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"

type MovementLegFixture = Omit<
  typeof schema.transactionLegs.$inferInsert,
  "movementCorrectionTargetId"
> & {
  readonly movementIdentity: {
    readonly sourceRecordKey: string
    readonly componentKey: string
  }
}

/** Test writers record each synthetic source movement before inserting its leg. */
export const seedMovementLegs = (legs: readonly MovementLegFixture[]) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    return yield* Effect.forEach(legs, ({ movementIdentity, ...leg }) =>
      Effect.gen(function* () {
        const [target] = yield* db
          .insert(schema.movementCorrectionTargets)
          .values({
            sourceId: leg.sourceId,
            principalId: leg.principalId,
            ...movementIdentity,
          })
          .onConflictDoUpdate({
            target: [
              schema.movementCorrectionTargets.sourceId,
              schema.movementCorrectionTargets.sourceRecordKey,
              schema.movementCorrectionTargets.componentKey,
            ],
            set: { componentKey: movementIdentity.componentKey },
          })
          .returning({ id: schema.movementCorrectionTargets.id })
        if (target === undefined) return yield* Effect.die("Failed to seed movement target")
        return { ...leg, movementCorrectionTargetId: target.id }
      })
    )
  })
