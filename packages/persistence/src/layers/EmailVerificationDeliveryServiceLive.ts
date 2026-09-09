/**
 * @module EmailVerificationDeliveryServiceLive
 *
 * Resend-backed delivery for local email verification codes.
 */

import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Resend } from "resend"
import {
  EmailVerificationDeliveryError,
  EmailVerificationDeliveryService,
  type EmailVerificationDeliveryServiceShape,
} from "../services/EmailVerificationDeliveryService.ts"

const DEFAULT_VERIFICATION_FROM = "TaxMaxi <taxmaxi@updates.taxmaxi.com>"
const RESEND_DELIVERY_MODE = "resend"
const LOG_DELIVERY_MODE = "log"
const RESEND_DEFAULT_BASE_URL = "https://api.resend.com"
const RESEND_PROBE_PATH = "/domains"
const RESEND_PROBE_TIMEOUT_MS = 8_000
const SEND_FAILURE_MESSAGE = "Failed to send verification email"

/**
 * Error object the Resend SDK returns instead of throwing. A fetch failure
 * inside the SDK becomes `application_error` with `statusCode: null`, which
 * hides the real network error.
 */
const ResendErrorResponse = Schema.Struct({
  name: Schema.String,
  statusCode: Schema.NullOr(Schema.Finite),
  message: Schema.String,
})

const decodeResendErrorResponse = Schema.decodeUnknownOption(ResendErrorResponse)

/**
 * Own fields a thrown error may carry beyond `name` and `message`, such as a
 * Node system error code (`ENOTFOUND`, `ECONNREFUSED`).
 */
const ThrownErrorFields = Schema.Struct({
  code: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
})

const decodeThrownErrorFields = Schema.decodeUnknownOption(ThrownErrorFields)

const summarizeThrown = (cause: unknown) => ({
  name: cause instanceof Error ? cause.name : undefined,
  message: cause instanceof Error ? cause.message : String(cause),
  code: Option.getOrUndefined(decodeThrownErrorFields(cause))?.code,
})

/**
 * Turns a thrown value into a loggable `{ name, message, code, cause }` with
 * the nested cause summarized one level deep. Node's fetch throws
 * `TypeError: fetch failed` and keeps the real network error as `cause`.
 */
const describeThrown = (cause: unknown) => ({
  ...summarizeThrown(cause),
  cause:
    cause instanceof Error && cause.cause !== undefined ? summarizeThrown(cause.cause) : undefined,
})

const isUnresolvedRequest = (error: typeof ResendErrorResponse.Type) =>
  error.name === "application_error" && error.statusCode === null

const elapsedSince = (startedAt: number) =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => now - startedAt))

const verificationEmailHtml = (code: string) => `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f8;color:#0f1720;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <main style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d9e0e6;border-radius:16px;padding:32px;">
      <p style="margin:0 0 12px;font-size:14px;color:#4b5563;">TaxMaxi email verification</p>
      <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#111827;">Confirm your email</h1>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#374151;">
        Use this verification code to finish signing in to TaxMaxi.
      </p>
      <div style="margin:0 0 24px;padding:20px 24px;border-radius:14px;background:#0f1720;color:#f8fafc;font-size:28px;font-weight:700;letter-spacing:0.32em;text-align:center;">
        ${code}
      </div>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">
        This code expires in 10 minutes. If you did not request it, you can ignore this email.
      </p>
    </main>
  </body>
</html>`

const make = Effect.gen(function* () {
  const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
  const deliveryMode = yield* Config.string("AUTH_VERIFICATION_DELIVERY_MODE").pipe(
    Config.withDefault(environment === "production" ? RESEND_DELIVERY_MODE : LOG_DELIVERY_MODE)
  )
  const fromAddress = yield* Config.string("AUTH_VERIFICATION_EMAIL_FROM").pipe(
    Config.withDefault(DEFAULT_VERIFICATION_FROM)
  )

  if (deliveryMode === LOG_DELIVERY_MODE) {
    yield* Effect.logInfo({ deliveryMode, fromAddress }, "Email verification delivery configured")

    const sendVerificationCode: EmailVerificationDeliveryServiceShape["sendVerificationCode"] = ({
      email,
      code,
    }) =>
      Effect.logInfo(
        {
          email,
          code,
          deliveryMode,
        },
        "Verification code generated"
      )

    return {
      sendVerificationCode,
    } satisfies EmailVerificationDeliveryServiceShape
  }

  const resendApiKey = yield* Config.redacted("RESEND_API_KEY")
  // The SDK reads the same variable itself; we read it only to log and probe.
  const resendBaseUrl = yield* Config.string("RESEND_BASE_URL").pipe(
    Config.withDefault(RESEND_DEFAULT_BASE_URL)
  )
  const resend = new Resend(Redacted.value(resendApiKey))

  yield* Effect.logInfo(
    { deliveryMode, fromAddress, resendBaseUrl },
    "Email verification delivery configured"
  )

  /**
   * One plain GET against the Resend API with the same key, so a failed send
   * can be told apart as DNS, TLS, proxy, or timeout. Runs only when the SDK
   * reported the generic "could not be resolved" error, and never changes the
   * outcome of the send.
   */
  const probeResendHost = Effect.gen(function* () {
    const probeUrl = new URL(RESEND_PROBE_PATH, resendBaseUrl).toString()
    const startedAt = yield* Clock.currentTimeMillis

    yield* Effect.tryPromise({
      try: () =>
        // Plain fetch on purpose: the probe mirrors what the Resend SDK does
        // and must not add an HttpClient requirement to this layer.
        // @effect-diagnostics-next-line globalFetchInEffect:off
        fetch(probeUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${Redacted.value(resendApiKey)}` },
          signal: AbortSignal.timeout(RESEND_PROBE_TIMEOUT_MS),
        }),
      catch: describeThrown,
    }).pipe(
      Effect.flatMap((response) =>
        elapsedSince(startedAt).pipe(
          Effect.flatMap((elapsedMs) =>
            Effect.logInfo(
              { probeUrl, status: response.status, elapsedMs },
              "Resend host probe reached the API"
            )
          )
        )
      ),
      Effect.tapError((error) =>
        elapsedSince(startedAt).pipe(
          Effect.flatMap((elapsedMs) =>
            Effect.logError({ probeUrl, elapsedMs, error }, "Resend host probe failed")
          )
        )
      )
    )
  }).pipe(Effect.ignore)

  const logSendFailure = ({
    email,
    elapsedMs,
    cause,
  }: {
    readonly email: string
    readonly elapsedMs: number
    readonly cause: unknown
  }) =>
    Option.match(decodeResendErrorResponse(cause), {
      onNone: () =>
        Effect.logError(
          { email, elapsedMs, deliveryMode, error: describeThrown(cause) },
          SEND_FAILURE_MESSAGE
        ),
      onSome: (error) =>
        Effect.logError({ email, elapsedMs, deliveryMode, error }, SEND_FAILURE_MESSAGE).pipe(
          Effect.andThen(isUnresolvedRequest(error) ? probeResendHost : Effect.void)
        ),
    })

  const sendThroughResend = ({ email, code }: { readonly email: string; readonly code: string }) =>
    Effect.tryPromise({
      try: () =>
        resend.emails.send({
          from: fromAddress,
          to: [email],
          subject: "Your TaxMaxi verification code",
          text: `Your TaxMaxi verification code is: ${code}`,
          html: verificationEmailHtml(code),
        }),
      catch: (cause) =>
        new EmailVerificationDeliveryError({
          message: SEND_FAILURE_MESSAGE,
          cause,
        }),
    }).pipe(
      Effect.flatMap((result) =>
        result.error === null
          ? Effect.succeed(result.data.id)
          : Effect.fail(
              new EmailVerificationDeliveryError({
                message: SEND_FAILURE_MESSAGE,
                cause: result.error,
              })
            )
      )
    )

  const sendVerificationCode: EmailVerificationDeliveryServiceShape["sendVerificationCode"] = ({
    email,
    code,
  }) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis

      yield* sendThroughResend({ email, code }).pipe(
        Effect.tap((resendId) =>
          elapsedSince(startedAt).pipe(
            Effect.flatMap((elapsedMs) =>
              Effect.logInfo({ email, elapsedMs, resendId }, "Sent verification email")
            )
          )
        ),
        Effect.tapError((error) =>
          elapsedSince(startedAt).pipe(
            Effect.flatMap((elapsedMs) => logSendFailure({ email, elapsedMs, cause: error.cause }))
          )
        )
      )
    })

  return {
    sendVerificationCode,
  } satisfies EmailVerificationDeliveryServiceShape
})

/**
 * Live verification email delivery via Resend.
 */
export const EmailVerificationDeliveryServiceLive = Layer.effect(
  EmailVerificationDeliveryService,
  make
)
