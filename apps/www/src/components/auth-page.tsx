import { Link } from "@tanstack/react-router"
import type { AuthProvider, TaxMaxi } from "taxmaxi"

import CoinbaseIcon from "#/components/ui/logos/coinbase/coinbase-app.svg"
import { AuthShell } from "#/components/auth-shell"
import { EmailPasswordForm, type AuthMode } from "#/components/email-password-form"
import { Button } from "#/components/ui/button"
import { Card, CardContent } from "#/components/ui/card"
import { Text } from "#/components/ui/typography"
import { m } from "#/paraglide/messages"

type AuthPageProps = {
  mode: AuthMode
  /** The providers the API reports as enabled; nothing else is rendered. */
  providers: ReadonlyArray<AuthProvider>
  taxmaxi: () => TaxMaxi
}

export function AuthPage({ mode, providers, taxmaxi }: AuthPageProps) {
  const isLogin = mode === "login"
  const hasLocal = providers.some((provider) => provider.type === "local")
  const hasCoinbase = providers.some((provider) => provider.type === "coinbase")

  return (
    <AuthShell
      description={
        <>
          {isLogin ? m["auth.login.newHere"]() : m["auth.signUp.alreadyAccount"]()}{" "}
          <Link to={isLogin ? "/sign-up" : "/login"} className="underline underline-offset-4">
            {isLogin ? m["auth.login.createAccount"]() : m["auth.signUp.logIn"]()}
          </Link>
          .
        </>
      }
      homeLabel={m["auth.home"]()}
      title={isLogin ? m["auth.login.title"]() : m["auth.signUp.title"]()}
    >
      <div className="relative z-10">
        <Card className="rounded-2xl bg-[#f5f2e8] shadow-lg ring-[#d9d2bc] dark:bg-[#1a1f1d] dark:ring-[#2a3a35]">
          <CardContent className="py-6">
            <div className="grid gap-4">
              {hasLocal ? <EmailPasswordForm mode={mode} taxmaxi={taxmaxi} /> : null}

              {hasLocal && hasCoinbase ? (
                <div
                  aria-hidden="true"
                  className="flex items-center gap-3 text-xs uppercase tracking-wide text-[#2a6857] dark:text-[#a3c4b5]"
                >
                  <span className="h-px flex-1 bg-[#d9d2bc] dark:bg-[#2a3a35]" />
                  {m["auth.or"]()}
                  <span className="h-px flex-1 bg-[#d9d2bc] dark:bg-[#2a3a35]" />
                </div>
              ) : null}

              {hasCoinbase ? (
                <Button
                  asChild
                  className="h-12 gap-2 rounded-xl border-[#d9d2bc] bg-white text-[#1e4d40] hover:bg-[#f5f2e8] dark:border-[#2a3a35] dark:bg-[#202724] dark:text-[#f7f0e3] dark:hover:bg-[#26312d]"
                  variant="outline"
                >
                  <Link to="/coinbase-sign-in">
                    <img src={CoinbaseIcon} alt="Coinbase" width={22} height={22} />
                    {m["auth.continueCoinbase"]()}
                  </Link>
                </Button>
              ) : null}

              {!hasLocal && !hasCoinbase ? (
                <Text align="center" size="bodySm" tone="auth">
                  {m["auth.noProviders"]()}
                </Text>
              ) : null}
            </div>

            <Text align="center" className="mt-6" size="caption" tone="auth">
              {isLogin ? m["auth.login.agreementIntro"]() : m["auth.signUp.agreementIntro"]()}{" "}
              <Link to="/terms" className="underline underline-offset-4">
                {m["auth.terms"]()}
              </Link>{" "}
              {m["auth.and"]()}{" "}
              <Link to="/privacy" className="underline underline-offset-4">
                {m["auth.privacy"]()}
              </Link>
              .
            </Text>
          </CardContent>
        </Card>
      </div>
    </AuthShell>
  )
}
