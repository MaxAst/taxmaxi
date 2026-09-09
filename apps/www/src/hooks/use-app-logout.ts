import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useCallback } from "react"

import { clearSessionQueries } from "#/integrations/taxmaxi/queries"
import { logoutFromApp } from "#/lib/auth-session"
import { logoutAuthSession } from "#/server-functions/auth"

export const useAppLogout = (): (() => Promise<void>) => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  return useCallback(
    () =>
      logoutFromApp({
        logout: logoutAuthSession,
        clearClientState: () => clearSessionQueries(queryClient),
        navigateToLogin: () => navigate({ to: "/login", replace: true }),
      }),
    [navigate, queryClient]
  )
}
