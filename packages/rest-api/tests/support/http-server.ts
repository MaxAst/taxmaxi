import { NodeHttpServer } from "@effect/platform-node"
import * as Layer from "effect/Layer"
import { FetchHttpClient, HttpServer } from "effect/unstable/http"
// NodeHttpServer requires the Node server constructor as its platform adapter.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http"

/** Bind to the client's IPv4 loopback address so another listener cannot receive test traffic. */
export const HttpServerTestLive = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false }))
    )
  ),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
)
