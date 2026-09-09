export const logoutFromApp = async ({
  logout,
  clearClientState,
  navigateToLogin,
}: {
  readonly logout: () => Promise<unknown>
  readonly clearClientState: () => Promise<void>
  readonly navigateToLogin: () => Promise<unknown>
}): Promise<void> => {
  await logout()
  await clearClientState()
  await navigateToLogin()
}
