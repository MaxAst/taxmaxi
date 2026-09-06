import { NodeHttpClient } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Latch, Layer, Option, Ref } from "effect"
import { HttpClient, HttpServer } from "effect/unstable/http"
import { vi } from "vitest"
import { WorkerHealthServerLive } from "../src/layers/WorkerHealthServerLive.ts"

class HealthServerAddress extends Context.Service<
  HealthServerAddress,
  Ref.Ref<Option.Option<HttpServer.Address>>
>()("test/HealthServerAddress") {}

// Observe the real bound service without exposing a production-only test hook.
vi.mock("@effect/platform-node", (importOriginal) =>
  importOriginal<typeof import("@effect/platform-node")>().then((original) => ({
    ...original,
    NodeHttpServer: {
      ...original.NodeHttpServer,
      layer: (...args: Parameters<typeof original.NodeHttpServer.layer>) =>
        original.NodeHttpServer.layer(...args).pipe(
          Layer.tap((context) =>
            Effect.flatMap(HealthServerAddress, (address) =>
              Ref.set(address, Option.some(Context.get(context, HttpServer.HttpServer).address))
            )
          )
        ),
    },
  }))
)

const assertHealthServerResponds = (onListening: Effect.Effect<void>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const observedAddress = yield* Ref.make(Option.none<HttpServer.Address>())
      yield* Layer.build(Layer.fresh(WorkerHealthServerLive)).pipe(
        Effect.provideService(HealthServerAddress, observedAddress),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ WORKER_HEALTH_PORT: "0" })
        )
      )
      const address = yield* Ref.get(observedAddress)
      if (Option.isNone(address) || address.value._tag !== "TcpAddress")
        return yield* Effect.die("Expected the real health server's TCP address")
      const port = address.value.port
      expect(port).toBeGreaterThan(0)
      yield* onListening
      const response = yield* HttpClient.get(`http://127.0.0.1:${port}/health`)
      const body = yield* response.text
      expect(response.status).toBe(200)
      expect(body).toBe("ok")
      return port
    })
  )

describe("WorkerHealthServerLive", () => {
  it.effect("serves GET /health on an OS-assigned port with 200 ok", () =>
    assertHealthServerResponds(Effect.void).pipe(Effect.provide(NodeHttpClient.layerNodeHttp))
  )

  it.effect("serves two independently scoped health servers on distinct simultaneous ports", () =>
    Effect.gen(function* () {
      const listening = yield* Ref.make(0)
      const bothListening = yield* Latch.make()
      const onListening = Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(listening, (value) => value + 1)
        if (count === 2) yield* bothListening.open
        yield* bothListening.await
      })
      const ports = yield* Effect.all(
        [assertHealthServerResponds(onListening), assertHealthServerResponds(onListening)],
        { concurrency: "unbounded" }
      )
      expect(new Set(ports).size).toBe(2)
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp))
  )
})
