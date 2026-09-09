import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import { getTaxMaxiRetryAfterSeconds, toTaxMaxiError, type TaxMaxi } from "taxmaxi"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { clearSessionQueries } from "#/integrations/taxmaxi/queries"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

type FormError =
  | { readonly kind: "code_invalid" }
  | { readonly kind: "code_expired" }
  | { readonly kind: "flow_missing" }
  | { readonly kind: "unknown" }

/**
 * Where a failed request lands on the page: whether the code field is marked
 * invalid, which element takes focus, and whether the message sits under the
 * field or under the form as a single alert.
 */
type ErrorPlacement = {
  readonly focus: "code" | "alert"
  readonly marksCode: boolean
  readonly formLevel: boolean
}

const ERROR_PLACEMENT: Record<FormError["kind"], ErrorPlacement> = {
  code_invalid: { focus: "code", marksCode: true, formLevel: false },
  code_expired: { focus: "alert", marksCode: true, formLevel: true },
  flow_missing: { focus: "alert", marksCode: false, formLevel: true },
  unknown: { focus: "alert", marksCode: false, formLevel: true },
}

/**
 * What the last "send a new code" click produced.
 *
 * A wait ends at `deadline`, a wall-clock time from the 429's
 * `retryAfterSeconds`, so a tab that was in the background or asleep opens
 * the resend button as soon as the API's wait is over. `announcedSeconds` is
 * what the live region said when the wait started; it does not tick.
 * `ready` means a wait has just ended and the live region says so.
 */
type ResendNotice =
  | { readonly kind: "sent" }
  | { readonly kind: "wait"; readonly deadline: number; readonly announcedSeconds: number }
  | { readonly kind: "ready" }

const secondsUntil = (deadline: number): number =>
  Math.max(0, Math.ceil((deadline - Date.now()) / 1000))

// The API expects exactly eight uppercase letters or digits. A pasted or
// typed code often carries spaces or lowercase, so the page fixes those before
// the SDK checks the code (#133 T08 note).
const toSubmittedCode = (typed: string): string => typed.trim().toUpperCase()

// A `ParseError` here means the SDK refused the code before sending it, for
// example a code with seven characters. To the person it is the same as a
// code the API refuses.
const toVerifyError = (error: unknown): FormError => {
  switch (toTaxMaxiError(error).code) {
    case "EmailVerificationCodeInvalidError":
    case "ParseError":
      return { kind: "code_invalid" }
    case "EmailVerificationCodeExpiredError":
      return { kind: "code_expired" }
    case "EmailVerificationFlowMissingError":
      return { kind: "flow_missing" }
    default:
      return { kind: "unknown" }
  }
}

const toResendError = (error: unknown): FormError =>
  toTaxMaxiError(error).code === "EmailVerificationFlowMissingError"
    ? { kind: "flow_missing" }
    : { kind: "unknown" }

const labelClassName = "text-sm leading-none font-medium text-[#1e4d40] dark:text-[#8ab4a3]"

const errorClassName = "text-sm text-destructive"

const noticeClassName = "text-sm text-[#2a6857] dark:text-[#a3c4b5]"

type VerifyEmailFormProps = {
  taxmaxi: () => TaxMaxi
}

/**
 * Code field, verify button, and "send a new code" for the verify-email page.
 *
 * Both calls go straight to the API through the browser SDK, so the API reads
 * its own verification cookie and sets the session cookie itself (#133 D08).
 * Every refusal is mapped to a message key; the raw error text never reaches
 * the page. A successful verify drops the previous session's cached queries
 * before entering `/app` (#133 D05).
 */
export function VerifyEmailForm({ taxmaxi }: VerifyEmailFormProps) {
  const id = useId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const codeRef = useRef<HTMLInputElement>(null)
  const alertRef = useRef<HTMLParagraphElement>(null)
  const [code, setCode] = useState("")
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState<FormError | undefined>()
  const [resendNotice, setResendNotice] = useState<ResendNotice | undefined>()
  // The visible countdown. Only this changes once a second; the live region
  // does not, so a screen reader hears the wait once, not every tick.
  const [secondsLeft, setSecondsLeft] = useState(0)

  const codeId = `${id}-code`
  const codeErrorId = `${id}-code-error`
  const formErrorId = `${id}-form-error`

  // Focus moves to the first error each time a request fails: the field error
  // focuses the field, a form-level error focuses the alert so it is read.
  useEffect(() => {
    if (error === undefined) return

    const focusRefs = { code: codeRef, alert: alertRef }
    focusRefs[ERROR_PLACEMENT[error.kind].focus].current?.focus()
  }, [error])

  const waiting = resendNotice?.kind === "wait"

  // The countdown reads the clock on every tick instead of counting ticks:
  // browsers pause or slow intervals in a background tab, so counting would
  // keep the button disabled after the API's wait has passed. Coming back to
  // the tab refreshes it right away. Once the deadline passes the wait ends
  // and the resend button opens again.
  useEffect(() => {
    if (resendNotice?.kind !== "wait") return

    const { deadline } = resendNotice
    const tick = () => {
      const left = secondsUntil(deadline)

      if (left > 0) {
        setSecondsLeft(left)
        return
      }

      setResendNotice({ kind: "ready" })
    }
    const timer = setInterval(tick, 1000)

    document.addEventListener("visibilitychange", tick)
    window.addEventListener("focus", tick)

    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", tick)
      window.removeEventListener("focus", tick)
    }
  }, [resendNotice])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (verifying || resending) return

    setVerifying(true)
    setError(undefined)

    try {
      await taxmaxi().auth.verifyEmail({ code: toSubmittedCode(code) })
      // The API has created the session. Anything cached from a previous
      // session in this tab must not be read by the new one.
      await clearSessionQueries(queryClient)
      await navigate({ to: "/app" })
    } catch (caught) {
      setError(toVerifyError(caught))
    } finally {
      setVerifying(false)
    }
  }

  const handleResend = async () => {
    if (verifying || resending) return

    setResending(true)
    setResendNotice(undefined)

    try {
      await taxmaxi().auth.resendVerification()
      // A fresh code replaces the one any earlier message was about.
      setError(undefined)
      setResendNotice({ kind: "sent" })
    } catch (caught) {
      const retryAfterSeconds = getTaxMaxiRetryAfterSeconds(caught)

      if (retryAfterSeconds !== null) {
        setSecondsLeft(retryAfterSeconds)
        setResendNotice({
          kind: "wait",
          deadline: Date.now() + retryAfterSeconds * 1000,
          announcedSeconds: retryAfterSeconds,
        })
        return
      }

      setError(toResendError(caught))
    } finally {
      setResending(false)
    }
  }

  const placement = error === undefined ? undefined : ERROR_PLACEMENT[error.kind]
  const codeInvalid = placement?.marksCode ?? false
  const hasFormLevelError = placement?.formLevel ?? false
  const resendBlocked = verifying || resending || waiting

  // A marked field points at its own message, or at the shared alert when the
  // message is form-level.
  const codeDescribedBy = !codeInvalid ? undefined : hasFormLevelError ? formErrorId : codeErrorId

  return (
    <form aria-busy={verifying || resending} className="grid gap-4" onSubmit={handleSubmit}>
      <div className="grid gap-2">
        <label className={labelClassName} htmlFor={codeId}>
          {m["auth.verifyEmail.code"]()}
        </label>
        <Input
          aria-describedby={codeDescribedBy}
          aria-invalid={codeInvalid}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          className="uppercase tracking-widest"
          disabled={verifying}
          id={codeId}
          inputMode="text"
          name="code"
          onChange={(event) => setCode(event.target.value)}
          placeholder={m["auth.verifyEmail.codePlaceholder"]()}
          ref={codeRef}
          required
          size="touch"
          spellCheck={false}
          type="text"
          value={code}
          variant="auth"
        />
        {/* A reserved line keeps the button still when a message appears. */}
        <div className="min-h-5">
          {error?.kind === "code_invalid" ? (
            <p className={errorClassName} id={codeErrorId}>
              {m["auth.verifyEmail.codeInvalid"]()}
            </p>
          ) : null}
        </div>
      </div>

      <div className="min-h-5">
        {hasFormLevelError ? (
          <p
            className={cn(errorClassName, "outline-none")}
            id={formErrorId}
            ref={alertRef}
            role="alert"
            tabIndex={-1}
          >
            {error?.kind === "code_expired" ? m["auth.verifyEmail.codeExpired"]() : null}
            {error?.kind === "flow_missing" ? (
              <>
                {m["auth.verifyEmail.flowMissing"]()}{" "}
                <Link className="underline underline-offset-4" to="/login">
                  {m["auth.verifyEmail.flowMissingLogIn"]()}
                </Link>
              </>
            ) : null}
            {error?.kind === "unknown" ? m["auth.form.unknownError"]() : null}
          </p>
        ) : null}
      </div>

      <Button
        className="mt-2"
        disabled={verifying || resending}
        size="touch"
        type="submit"
        variant="cta"
      >
        {verifying ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {m["auth.verifyEmail.submit"]()}
      </Button>

      <Button
        disabled={resendBlocked}
        onClick={handleResend}
        size="touch"
        type="button"
        variant="surface"
      >
        {resending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {m["auth.verifyEmail.resend"]()}
      </Button>

      <div className="grid gap-1.5 text-center">
        {/* The visible notice is not a live region: its countdown changes
            every second. */}
        <p className={cn(noticeClassName, "min-h-5 tabular-nums")}>
          {resendNotice?.kind === "sent" ? m["auth.verifyEmail.resent"]() : null}
          {waiting ? m["auth.verifyEmail.resendWait"]({ seconds: secondsLeft }) : null}
        </p>
        {/* The live region speaks at most once per event: the code is on its
            way, the wait has started, the wait is over. */}
        <p aria-atomic="true" className="sr-only" role="status">
          {resendNotice?.kind === "sent" ? m["auth.verifyEmail.resent"]() : null}
          {resendNotice?.kind === "wait"
            ? m["auth.verifyEmail.resendWait"]({ seconds: resendNotice.announcedSeconds })
            : null}
          {resendNotice?.kind === "ready" ? m["auth.verifyEmail.resendReady"]() : null}
        </p>
      </div>
    </form>
  )
}
