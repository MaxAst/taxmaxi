import { createFileRoute } from "@tanstack/react-router"

import { Atelier } from "#/components/atelier/atelier"

export const Route = createFileRoute("/atelier")({
  component: Atelier,
})
