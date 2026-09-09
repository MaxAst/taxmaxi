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
 * What the last "send a new code" click produced. A wait counts down once a
 * second until the resend button opens again.
 */
type ResendNotice = { readonly kind: "sent" } | { readonly kind: "wait"; readonly seconds: number }

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

const fieldClassName =
  "h-11 rounded-xl border-[#d9d2bc] bg-white px-3.5 text-center font-mono text-lg uppercase tracking-[0.3em] text-[#1e4d40] placeholder:text-[#2a6857]/50 dark:border-[#2a3a35] dark:bg-[#202724] dark:text-[#f7f0e3] dark:placeholder:text-[#a3c4b5]/50"

const labelClassName = "text-sm font-medium text-[#1e4d40] dark:text-[#f7f0e3]"

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

  // The wait from a 429 counts down once a second; at zero the notice goes
  // away and the resend button opens again.
  useEffect(() => {
    if (!waiting) return

    const timer = setInterval(() => {
      setResendNotice((current) =>
        current?.kind !== "wait"
          ? current
          : current.seconds > 1
            ? { kind: "wait", seconds: current.seconds - 1 }
            : undefined
      )
    }, 1000)

    return () => clearInterval(timer)
  }, [waiting])

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
        setResendNotice({ kind: "wait", seconds: retryAfterSeconds })
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
    <form aria-busy={verifying || resending} className="grid gap-3" onSubmit={handleSubmit}>
      <div className="grid gap-1.5">
        <label className={labelClassName} htmlFor={codeId}>
          {m["auth.verifyEmail.code"]()}
        </label>
        <Input
          aria-describedby={codeDescribedBy}
          aria-invalid={codeInvalid}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          className={fieldClassName}
          disabled={verifying}
          id={codeId}
          inputMode="text"
          name="code"
          onChange={(event) => setCode(event.target.value)}
          ref={codeRef}
          required
          spellCheck={false}
          type="text"
          value={code}
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
        className="h-12 gap-2 rounded-xl bg-[#1e4d40] text-[#f7f0e3] hover:bg-[#2a6857] dark:bg-[#8ab4a3] dark:text-[#1a1f1d] dark:hover:bg-[#a3c4b5]"
        disabled={verifying || resending}
        type="submit"
      >
        {verifying ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {m["auth.verifyEmail.submit"]()}
      </Button>

      <div className="mt-2 grid justify-items-center gap-1.5 text-center">
        <p className={noticeClassName}>
          {m["auth.verifyEmail.resendPrompt"]()}{" "}
          <Button
            className="h-auto p-0 text-sm text-[#1e4d40] dark:text-[#8ab4a3]"
            disabled={resendBlocked}
            onClick={handleResend}
            type="button"
            variant="link"
          >
            {resending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {m["auth.verifyEmail.resend"]()}
          </Button>
        </p>
        <p aria-atomic="true" className={cn(noticeClassName, "min-h-5")} role="status">
          {resendNotice?.kind === "sent" ? m["auth.verifyEmail.resent"]() : null}
          {resendNotice?.kind === "wait"
            ? m["auth.verifyEmail.resendWait"]({ seconds: resendNotice.seconds })
            : null}
        </p>
      </div>
    </form>
  )
}
