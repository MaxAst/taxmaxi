import { SourceSyncQueue } from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const SourceSyncQueueUnexpectedTestLive = Layer.succeed(SourceSyncQueue, {
  enqueueSourceSyncJob: () => Effect.die("Unexpected source sync queue call in endpoint fixture"),
})
