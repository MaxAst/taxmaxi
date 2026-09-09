// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TaxMaxi, type AuthProvider } from "taxmaxi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AuthPage } from "#/components/auth-page"
import { queryKeys } from "#/integrations/taxmaxi/queries"

const BASE_URL = "https://api.example.test"

const provider = (type: "local" | "coinbase"): AuthProvider => ({
  type,
  supportsRegistration: type === "local",
  supportsPasswordLogin: type === "local",
  oauthEnabled: type === "coinbase",
  supportsLinking: type === "coinbase",
})

const VERIFICATION_FLOW = { email: "max@example.com", redirectTo: "/verify-email" }

const LOGIN = {
  token: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
  user: {
    id: "00000000-0000-4000-8000-000000000101",
    email: "max@example.com",
    displayName: "max",
    role: "member",
    primaryProvider: "local",
    emailVerified: true,
    welcomeSeenAt: null,
    createdAt: { epochMillis: 1_788_264_000_000 },
    updatedAt: { epochMillis: 1_788_264_000_000 },
  },
  provider: "local",
  expiresAt: "2026-09-08T12:00:00.000Z",
}

const USER_EXISTS_BODY = {
  _tag: "UserExistsError",
  email: "max@example.com",
  message: "A user with this email already exists",
}

const PASSWORD_WEAK_BODY = {
  _tag: "PasswordWeakError",
  message: "Password does not meet requirements",
  requirements: ["min_length", "number"],
  minPasswordLength: 8,
}

const UNAUTHORIZED_BODY = { _tag: "AuthUnauthorizedError", message: "Invalid credentials" }

const VERIFICATION_REQUIRED_BODY = {
  _tag: "EmailVerificationRequiredError",
  email: "max@example.com",
  message: "Email verification is required before login",
}

type CapturedRequest = {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(
      (query: string): MediaQueryList => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })
    ),
  })
})

afterEach(cleanup)

const renderAuthPage = async ({
  mode,
  providers,
  respond = async () => Response.json({ providers: [] }),
}: {
  readonly mode: "login" | "sign-up"
  readonly providers: ReadonlyArray<AuthProvider>
  readonly respond?: () => Promise<Response>
}) => {
  const requests: Array<CapturedRequest> = []
  const taxmaxi = TaxMaxi.fromBrowserSession({
    baseUrl: BASE_URL,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const rawBody =
        init?.body === undefined || init.body === null ? "" : await new Response(init.body).text()
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: rawBody === "" ? undefined : JSON.parse(rawBody),
      })
      return respond()
    },
  })

  const rootRoute = createRootRoute({ component: Outlet })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: `/${mode}`,
    component: () => <AuthPage mode={mode} providers={providers} taxmaxi={() => taxmaxi} />,
  })
  const otherPageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: mode === "login" ? "/sign-up" : "/login",
    component: () => <p>Other auth page</p>,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // How many `taxmaxi` queries are still cached at the moment the app is entered.
  const cachedQueriesOnAppEntry: Array<number> = []
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/app",
    beforeLoad: () => {
      cachedQueriesOnAppEntry.push(
        queryClient.getQueryCache().findAll({ queryKey: queryKeys.all }).length
      )
    },
    component: () => <p>App dashboard</p>,
  })
  const verifyEmailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/verify-email",
    component: () => <p>Verify email page</p>,
  })
  const routeTree = rootRoute.addChildren([pageRoute, otherPageRoute, appRoute, verifyEmailRoute])
  const history = createMemoryHistory({ initialEntries: [`/${mode}`] })
  const router = createRouter({ history, routeTree })

  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )

  return { cachedQueriesOnAppEntry, history, queryClient, requests }
}

const fillAndSubmit = ({
  email,
  password,
  submit,
}: Record<"email" | "password" | "submit", string>) => {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } })
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } })
  fireEvent.click(screen.getByRole("button", { name: submit }))
}

const queryCoinbaseLink = () => screen.queryByRole("link", { name: /Continue with Coinbase/ })

describe("AuthPage provider rendering", () => {
  it.each([
    { providers: [provider("coinbase")], coinbase: true, form: false },
    { providers: [provider("local")], coinbase: false, form: true },
    { providers: [provider("local"), provider("coinbase")], coinbase: true, form: true },
  ])(
    "renders from $providers.length provider(s): coinbase=$coinbase form=$form",
    async ({ coinbase, form, providers }) => {
      await renderAuthPage({ mode: "login", providers })

      expect(queryCoinbaseLink() !== null).toBe(coinbase)
      expect(screen.queryByLabelText("Email") !== null).toBe(form)
      expect(screen.queryByLabelText("Password") !== null).toBe(form)
      expect(screen.queryByText("or") !== null).toBe(coinbase && form)
    }
  )

  it("says so when the API lists no provider", async () => {
    await renderAuthPage({ mode: "sign-up", providers: [] })

    expect(queryCoinbaseLink()).toBeNull()
    expect(screen.queryByLabelText("Email")).toBeNull()
    expect(screen.getByText("No login method is available right now.")).toBeTruthy()
  })

  it("renders every control at the touch size", async () => {
    await renderAuthPage({ mode: "login", providers: [provider("local"), provider("coinbase")] })

    const controls = [
      screen.getByLabelText("Email"),
      screen.getByLabelText("Password"),
      screen.getByRole("button", { name: "Log in" }),
      screen.getByRole("link", { name: /Continue with Coinbase/ }),
    ]
    expect(controls.map((control) => control.classList.contains("h-11"))).toEqual([
      true,
      true,
      true,
      true,
    ])
  })
})

describe("AuthPage sign-up", () => {
  it("registers through the SDK, disables submit while pending, then moves to verify-email", async () => {
    const response = deferred<Response>()
    const { history, requests } = await renderAuthPage({
      mode: "sign-up",
      providers: [provider("local")],
      respond: () => response.promise,
    })

    fillAndSubmit({ email: "max@example.com", password: "Str0ngPass", submit: "Create account" })

    const submit = screen.getByRole("button", { name: "Create account" })
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(true))
    expect(history.location.pathname).toBe("/sign-up")

    response.resolve(Response.json(VERIFICATION_FLOW, { status: 201 }))

    await waitFor(() => expect(history.location.pathname).toBe("/verify-email"))
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/auth/register",
        body: { email: "max@example.com", password: "Str0ngPass" },
      },
    ])
  })

  it("shows the already-registered message on the email field with a login link", async () => {
    await renderAuthPage({
      mode: "sign-up",
      providers: [provider("local")],
      respond: async () => Response.json(USER_EXISTS_BODY, { status: 409 }),
    })

    fillAndSubmit({ email: "max@example.com", password: "Str0ngPass", submit: "Create account" })

    const message = await screen.findByText("This email is already registered.")
    const email = screen.getByLabelText("Email")
    expect(email.getAttribute("aria-invalid")).toBe("true")
    expect(email.getAttribute("aria-describedby")).toBe(message.id)
    expect(screen.getByRole("link", { name: "Log in instead" }).getAttribute("href")).toBe("/login")
    expect(screen.queryByText(USER_EXISTS_BODY.message)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(email))
    expect(screen.getByRole("button", { name: "Create account" }).hasAttribute("disabled")).toBe(
      false
    )
  })

  it("lists one line per unmet password rule on the password field", async () => {
    await renderAuthPage({
      mode: "sign-up",
      providers: [provider("local")],
      respond: async () => Response.json(PASSWORD_WEAK_BODY, { status: 400 }),
    })

    fillAndSubmit({ email: "max@example.com", password: "short", submit: "Create account" })

    await screen.findByText("Your password needs:")
    const items = screen.getAllByRole("listitem").map((item) => item.textContent)
    expect(items).toEqual(["at least 8 characters", "a number"])

    const password = screen.getByLabelText("Password")
    expect(password.getAttribute("aria-invalid")).toBe("true")
    const describedBy = password.getAttribute("aria-describedby")
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain("a number")
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("false")
    expect(screen.queryByText(PASSWORD_WEAK_BODY.message)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(password))
  })
})

describe("AuthPage login", () => {
  it("logs in through the SDK and moves to the app", async () => {
    const { history, requests } = await renderAuthPage({
      mode: "login",
      providers: [provider("local"), provider("coinbase")],
      respond: async () => Response.json(LOGIN),
    })

    fillAndSubmit({ email: "Max@Example.com", password: "Str0ngPass", submit: "Log in" })

    await waitFor(() => expect(history.location.pathname).toBe("/app"))
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/auth/login",
        body: {
          provider: "local",
          credentials: { email: "Max@Example.com", password: "Str0ngPass" },
        },
      },
    ])
  })

  it("drops the previous session's cached queries before entering the app", async () => {
    const { cachedQueriesOnAppEntry, history, queryClient } = await renderAuthPage({
      mode: "login",
      providers: [provider("local")],
      respond: async () => Response.json(LOGIN),
    })
    // User A loaded the app in this tab; B now logs in.
    queryClient.setQueryData(queryKeys.account(), {
      account: { id: "00000000-0000-4000-8000-000000000001", email: "a@example.com" },
      loginMethods: [],
    })
    queryClient.setQueryData(queryKeys.sourceList(), [])

    fillAndSubmit({ email: "b@example.com", password: "Str0ngPass", submit: "Log in" })

    await waitFor(() => expect(history.location.pathname).toBe("/app"))
    expect(cachedQueriesOnAppEntry).toEqual([0])
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })).toEqual([])
  })

  it("shows one generic message for wrong credentials", async () => {
    const { history } = await renderAuthPage({
      mode: "login",
      providers: [provider("local")],
      respond: async () => Response.json(UNAUTHORIZED_BODY, { status: 401 }),
    })

    fillAndSubmit({ email: "max@example.com", password: "wrong", submit: "Log in" })

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Wrong email or password.")
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByLabelText("Email").getAttribute("aria-describedby")).toBe(alert.id)
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByLabelText("Password").getAttribute("aria-describedby")).toBe(alert.id)
    expect(screen.queryByText(UNAUTHORIZED_BODY.message)).toBeNull()
    expect(history.location.pathname).toBe("/login")
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Email")))
  })

  it("moves an unverified login to verify-email", async () => {
    const { history } = await renderAuthPage({
      mode: "login",
      providers: [provider("local")],
      respond: async () => Response.json(VERIFICATION_REQUIRED_BODY, { status: 403 }),
    })

    fillAndSubmit({ email: "max@example.com", password: "Str0ngPass", submit: "Log in" })

    await waitFor(() => expect(history.location.pathname).toBe("/verify-email"))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("shows the generic failure message for an unexpected error", async () => {
    await renderAuthPage({
      mode: "login",
      providers: [provider("local")],
      respond: async () =>
        Response.json({ _tag: "InternalServerError", message: "boom" }, { status: 500 }),
    })

    fillAndSubmit({ email: "max@example.com", password: "Str0ngPass", submit: "Log in" })

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Something went wrong. Please try again.")
    expect(screen.queryByText("boom")).toBeNull()
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("false")
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })
})
