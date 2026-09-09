import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import {
  getTaxMaxiPasswordRequirements,
  isTaxMaxiEmailVerificationRequiredError,
  isTaxMaxiUnauthorizedError,
  toTaxMaxiError,
  type TaxMaxi,
  type TaxMaxiPasswordRequirement,
} from "taxmaxi"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { clearSessionQueries } from "#/integrations/taxmaxi/queries"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

export type AuthMode = "login" | "sign-up"

type FormError =
  | { readonly kind: "email_taken" }
  | {
      readonly kind: "password_weak"
      readonly requirements: ReadonlyArray<TaxMaxiPasswordRequirement>
      readonly minPasswordLength: number
    }
  | { readonly kind: "wrong_credentials" }
  | { readonly kind: "unknown" }

/**
 * Where a failed submit lands on the page: which fields are marked invalid,
 * which element takes focus, and whether the message sits under one field or
 * under the form as a single alert. Every other decision about an error reads
 * from this one table.
 */
type ErrorPlacement = {
  readonly focus: "email" | "password" | "alert"
  readonly marksEmail: boolean
  readonly marksPassword: boolean
  readonly formLevel: boolean
}

const ERROR_PLACEMENT: Record<FormError["kind"], ErrorPlacement> = {
  email_taken: { focus: "email", marksEmail: true, marksPassword: false, formLevel: false },
  password_weak: { focus: "password", marksEmail: false, marksPassword: true, formLevel: false },
  wrong_credentials: { focus: "email", marksEmail: true, marksPassword: true, formLevel: true },
  unknown: { focus: "alert", marksEmail: false, marksPassword: false, formLevel: true },
}

// A schema error from the SDK (`code === "ParseError"`) stays "unknown" on
// purpose: the same code covers a response the SDK could not decode, so it
// cannot be read as "the typed email is malformed".
const toFormError = (error: unknown): FormError => {
  const taxmaxiError = toTaxMaxiError(error)
  const passwordRules = getTaxMaxiPasswordRequirements(taxmaxiError)

  if (passwordRules !== null) {
    return { kind: "password_weak", ...passwordRules }
  }

  if (taxmaxiError.code === "UserExistsError") {
    return { kind: "email_taken" }
  }

  if (isTaxMaxiUnauthorizedError(taxmaxiError)) {
    return { kind: "wrong_credentials" }
  }

  return { kind: "unknown" }
}

const passwordRuleMessage = ({
  minPasswordLength,
  rule,
}: {
  readonly minPasswordLength: number
  readonly rule: TaxMaxiPasswordRequirement
}): string => {
  switch (rule) {
    case "min_length":
      return m["auth.form.passwordRules.minLength"]({ minPasswordLength })
    case "lowercase":
      return m["auth.form.passwordRules.lowercase"]()
    case "uppercase":
      return m["auth.form.passwordRules.uppercase"]()
    case "number":
      return m["auth.form.passwordRules.number"]()
    case "special_char":
      return m["auth.form.passwordRules.specialChar"]()
  }
}

const labelClassName = "text-sm leading-none font-medium text-[#1e4d40] dark:text-[#8ab4a3]"

const errorClassName = "text-sm text-destructive"

type EmailPasswordFormProps = {
  mode: AuthMode
  taxmaxi: () => TaxMaxi
}

/**
 * Email and password form for login and sign-up.
 *
 * Submits straight to the API through the browser SDK, so the API sets its own
 * cookies (#133 D08). Every API refusal is mapped to a message key; the raw
 * error text never reaches the page.
 */
export function EmailPasswordForm({ mode, taxmaxi }: EmailPasswordFormProps) {
  const isLogin = mode === "login"
  const id = useId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const alertRef = useRef<HTMLParagraphElement>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<FormError | undefined>()

  const emailId = `${id}-email`
  const passwordId = `${id}-password`
  const emailErrorId = `${id}-email-error`
  const passwordErrorId = `${id}-password-error`
  const formErrorId = `${id}-form-error`

  // Focus moves to the first error each time a submit fails: a field error
  // focuses its field, a form-level error focuses the alert so it is read.
  useEffect(() => {
    if (error === undefined) return

    const focusRefs = { email: emailRef, password: passwordRef, alert: alertRef }
    focusRefs[ERROR_PLACEMENT[error.kind].focus].current?.focus()
  }, [error])

  const submit = async () => {
    const client = taxmaxi()

    if (isLogin) {
      await client.auth.login({ email, password })
      // The API has replaced the session cookie. Anything cached from the
      // previous session in this tab must not be read by the new one.
      await clearSessionQueries(queryClient)
      await navigate({ to: "/app" })
      return
    }

    await client.auth.register({ email, password })
    await navigate({ to: "/verify-email" })
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (pending) return

    setPending(true)
    setError(undefined)

    try {
      await submit()
    } catch (caught) {
      // A verified password with a pending email continues on the verify page;
      // the API has restored the verification cookie.
      if (isTaxMaxiEmailVerificationRequiredError(toTaxMaxiError(caught))) {
        await navigate({ to: "/verify-email" })
        return
      }

      setError(toFormError(caught))
    } finally {
      setPending(false)
    }
  }

  const placement = error === undefined ? undefined : ERROR_PLACEMENT[error.kind]
  const emailInvalid = placement?.marksEmail ?? false
  const passwordInvalid = placement?.marksPassword ?? false
  const hasFormLevelError = placement?.formLevel ?? false

  // A marked field points at its own message, or at the shared alert when the
  // message is form-level.
  const emailDescribedBy = !emailInvalid
    ? undefined
    : hasFormLevelError
      ? formErrorId
      : emailErrorId
  const passwordDescribedBy = !passwordInvalid
    ? undefined
    : hasFormLevelError
      ? formErrorId
      : passwordErrorId

  return (
    <form aria-busy={pending} className="grid gap-4" onSubmit={handleSubmit}>
      <div className="grid gap-2">
        <label className={labelClassName} htmlFor={emailId}>
          {m["auth.form.email"]()}
        </label>
        <Input
          aria-describedby={emailDescribedBy}
          aria-invalid={emailInvalid}
          autoComplete="email"
          disabled={pending}
          id={emailId}
          inputMode="email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder={m["auth.form.emailPlaceholder"]()}
          ref={emailRef}
          required
          size="touch"
          spellCheck={false}
          type="email"
          value={email}
          variant="auth"
        />
        {/* A reserved line keeps the password field still when a message appears. */}
        <div className="min-h-5">
          {error?.kind === "email_taken" ? (
            <p className={errorClassName} id={emailErrorId}>
              {m["auth.form.emailTaken"]()}{" "}
              <Link className="underline underline-offset-4" to="/login">
                {m["auth.form.emailTakenLogIn"]()}
              </Link>
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2">
        <label className={labelClassName} htmlFor={passwordId}>
          {m["auth.form.password"]()}
        </label>
        <Input
          aria-describedby={passwordDescribedBy}
          aria-invalid={passwordInvalid}
          autoComplete={isLogin ? "current-password" : "new-password"}
          disabled={pending}
          id={passwordId}
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder={m["auth.form.passwordPlaceholder"]()}
          ref={passwordRef}
          required
          size="touch"
          type="password"
          value={password}
          variant="auth"
        />
        <div className="min-h-5">
          {error?.kind === "password_weak" ? (
            <div className={errorClassName} id={passwordErrorId}>
              <p>{m["auth.form.passwordWeak"]()}</p>
              <ul className="list-disc pl-5">
                {error.requirements.map((rule) => (
                  <li key={rule}>
                    {passwordRuleMessage({ minPasswordLength: error.minPasswordLength, rule })}
                  </li>
                ))}
              </ul>
            </div>
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
            {error?.kind === "wrong_credentials"
              ? m["auth.form.wrongCredentials"]()
              : m["auth.form.unknownError"]()}
          </p>
        ) : null}
      </div>

      <Button className="mt-2" disabled={pending} size="touch" type="submit" variant="cta">
        {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {isLogin ? m["auth.form.submitLogin"]() : m["auth.form.submitSignUp"]()}
      </Button>
    </form>
  )
}
