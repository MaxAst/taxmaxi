import { it, expect } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { HttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
// NodeHttpServer requires the Node server constructor as its platform adapter.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http"
import { HttpServerTestLive } from "./support/http-server.ts"

it.effect("keeps concurrent clients on their own loopback listener and releases each port", () =>
  Effect.gen(function* () {
    const ports = yield* Effect.gen(function* () {
      let competitorRequests = 0
      const competitor = yield* Layer.build(
        HttpRouter.add(
          "GET",
          "/probe",
          Effect.sync(() => {
            competitorRequests++
            return HttpServerResponse.empty({ status: 404 })
          })
        ).pipe(
          HttpRouter.serve,
          Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
        )
      )
      const makeApp = (identity: string) =>
        HttpRouter.add("GET", "/probe", HttpServerResponse.text(identity, { status: 400 })).pipe(
          HttpRouter.serve,
          Layer.provideMerge(HttpServerTestLive)
        )
      const first = yield* Layer.build(makeApp("first"))
      const second = yield* Layer.build(makeApp("second"))
      const contexts = [competitor, first, second]
      const addresses = contexts.map(
        (context) => Context.get(context, HttpServer.HttpServer).address
      )
      const ports: Array<number> = []
      for (const address of addresses) {
        if (address._tag !== "TcpAddress") return yield* Effect.die("Expected a TCP test listener")
        expect(address.hostname).toBe("127.0.0.1")
        expect(address.port).toBeGreaterThan(0)
        ports.push(address.port)
      }
      expect(new Set(ports).size).toBe(3)
      const responses = yield* Effect.all(
        [first, second].map((context) =>
          Effect.gen(function* () {
            const response = yield* Context.get(context, HttpClient.HttpClient).get("/probe")
            return {
              status: response.status,
              url: response.request.url,
              body: yield* response.text,
            }
          })
        ),
        { concurrency: "unbounded" }
      )
      expect(responses).toEqual([
        { status: 400, url: `http://127.0.0.1:${ports[1]}/probe`, body: "first" },
        { status: 400, url: `http://127.0.0.1:${ports[2]}/probe`, body: "second" },
      ])
      expect(competitorRequests).toBe(0)
      return ports
    }).pipe(Effect.scoped)

    for (const port of ports) {
      yield* Layer.build(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })).pipe(
        Effect.scoped
      )
    }
  })
)
