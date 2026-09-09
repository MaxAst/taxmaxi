import { createFileRoute } from "@tanstack/react-router"
import type { TaxMaxi } from "taxmaxi"

import { AuthShell } from "#/components/auth-shell"
import { VerifyEmailForm } from "#/components/verify-email-form"
import { Card, CardContent } from "#/components/ui/card"
import { m } from "#/paraglide/messages"

export const Route = createFileRoute("/verify-email")({
  head: () => ({
    meta: [
      {
        name: "robots",
        content: "noindex",
      },
    ],
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { taxmaxi } = Route.useRouteContext()

  return <VerifyEmailPage taxmaxi={taxmaxi} />
}

type VerifyEmailPageProps = {
  taxmaxi: () => TaxMaxi
}

/**
 * The page a person lands on after sign-up or an unverified login. The API
 * holds the pending request behind its verification cookie, so the page needs
 * no loader: it only asks for the code.
 */
export function VerifyEmailPage({ taxmaxi }: VerifyEmailPageProps) {
  return (
    <AuthShell
      description={m["auth.verifyEmail.description"]()}
      homeLabel={m["auth.home"]()}
      title={m["auth.verifyEmail.title"]()}
    >
      <div className="relative z-10">
        <Card className="rounded-2xl bg-[#f5f2e8] shadow-lg ring-[#d9d2bc] dark:bg-[#1a1f1d] dark:ring-[#2a3a35]">
          <CardContent className="py-6">
            <VerifyEmailForm taxmaxi={taxmaxi} />
          </CardContent>
        </Card>
      </div>
    </AuthShell>
  )
}
