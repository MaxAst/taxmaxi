import { createFileRoute } from "@tanstack/react-router"

import { AuthPage } from "#/components/auth-page"

export const Route = createFileRoute("/sign-up")({
  head: () => ({
    meta: [
      {
        name: "robots",
        content: "noindex",
      },
    ],
  }),
  loader: async ({ context }) => {
    const { providers } = await context.taxmaxi().auth.providers()
    return { providers }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const { providers } = Route.useLoaderData()
  const { taxmaxi } = Route.useRouteContext()

  return <AuthPage mode="sign-up" providers={providers} taxmaxi={taxmaxi} />
}
