import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import * as Cause from "effect/Cause"
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { HttpApiScalar, OpenApi } from "effect/unstable/httpapi"
// NodeHttpServer requires the Node server constructor as its platform adapter.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http"
import { LoggerLive } from "@my/observability"
import {
  SourceSyncRunServiceLive,
  SourceSyncServiceLive,
  TransferReconciliationServiceLive,
} from "@my/sync-engine/layers"
import { AuthLive, PgClientLive, RepositoriesLive } from "@my/persistence/layers"
import {
  AnonSessionServiceLive,
  invalidSessionCookieCleanup,
  SessionTokenValidatorLive,
  SIWXProofVerifierLive,
  TaxMaxiApiLive,
  X402PaymentValidatorLive,
} from "@my/rest-api"
import { TaxMaxiApi } from "@my/rest-api/contracts"
import { ApiBullMqSourceSyncQueueLive } from "./layers/ApiBullMqSourceSyncQueueLive.ts"
import { ApiBullMqCalculationRecomputeQueueLive } from "./layers/ApiBullMqCalculationRecomputeQueueLive.ts"
import { TracingLive } from "./layers/TracingLive.ts"

const port = 4000
const DEFAULT_FRONTEND_URL = "http://localhost:3000"

const SyncRuntimeLive = SourceSyncServiceLive.pipe(
  Layer.provideMerge(ApiBullMqSourceSyncQueueLive),
  Layer.provide(RepositoriesLive)
)

const SyncRunRuntimeLive = SourceSyncRunServiceLive.pipe(
  Layer.provide(SyncRuntimeLive),
  Layer.provide(RepositoriesLive)
)

const TransferReconciliationRuntimeLive = TransferReconciliationServiceLive.pipe(
  Layer.provide(RepositoriesLive)
)

const ApplicationLive = Layer.mergeAll(
  RepositoriesLive,
  SyncRuntimeLive,
  SyncRunRuntimeLive,
  TransferReconciliationRuntimeLive,
  ApiBullMqCalculationRecomputeQueueLive,
  AuthLive
)

const normalizeUrl = (url: string): string => (url.endsWith("/") ? url.slice(0, -1) : url)

const CorsLive = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
    const frontendUrl = yield* Config.string("FRONTEND_URL").pipe(
      Config.withDefault(DEFAULT_FRONTEND_URL),
      Config.map(normalizeUrl)
    )

    return HttpRouter.cors({
      allowedOrigins: environment === "development" ? [DEFAULT_FRONTEND_URL] : [frontendUrl],
      credentials: true,
      exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
    })
  })
)

const requestFailureLogging = HttpMiddleware.make((httpApp) =>
  httpApp.pipe(
    Effect.tapCause((cause) =>
      Effect.gen(function* () {
        const renderedCause = Cause.pretty(cause)
        if (renderedCause.startsWith("SourcePaymentRequiredError:")) {
          return
        }

        const request = yield* HttpServerRequest.HttpServerRequest

        yield* Effect.logError(
          {
            method: request.method,
            url: request.originalUrl,
            cause: renderedCause,
          },
          "HTTP API request failed"
        )
      })
    )
  )
)

const OpenApiLive = HttpRouter.add(
  "GET",
  "/openapi.json",
  HttpServerResponse.jsonUnsafe(OpenApi.fromApi(TaxMaxiApi))
)

const RoutesLive = Layer.mergeAll(
  TaxMaxiApiLive,
  HttpApiScalar.layer(TaxMaxiApi),
  OpenApiLive,
  CorsLive
)

const ServerLive = HttpRouter.serve(RoutesLive, {
  middleware: (httpApp) => invalidSessionCookieCleanup(requestFailureLogging(httpApp)),
}).pipe(
  Layer.provide(AnonSessionServiceLive),
  Layer.provide(SIWXProofVerifierLive),
  Layer.provide(X402PaymentValidatorLive),
  Layer.provide(SessionTokenValidatorLive),
  Layer.provide(ApplicationLive),
  Layer.provide(PgClientLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port }))
)

Layer.launch(ServerLive).pipe(
  Effect.provide(Layer.mergeAll(LoggerLive, TracingLive)),
  NodeRuntime.runMain
)
