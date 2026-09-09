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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TaxMaxi } from "taxmaxi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { queryKeys } from "#/integrations/taxmaxi/queries"
import { VerifyEmailPage } from "#/routes/verify-email"

const BASE_URL = "https://api.example.test"

const VERIFIED = { redirectTo: "/app" }

const VERIFICATION_FLOW = { email: "max@example.com", redirectTo: "/verify-email" }

const CODE_INVALID_BODY = {
  _tag: "EmailVerificationCodeInvalidError",
  message: "Verification code is invalid",
}

const CODE_EXPIRED_BODY = {
  _tag: "EmailVerificationCodeExpiredError",
  message: "Verification code has expired",
}

const FLOW_MISSING_BODY = {
  _tag: "EmailVerificationFlowMissingError",
  message: "Verification session is missing or expired. Start sign-up or login again.",
}

const RESEND_LIMITED_BODY = {
  _tag: "VerificationResendRateLimitedError",
  retryAfterSeconds: 42,
  message: "Wait before asking for another code",
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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const renderVerifyEmailPage = async ({
  respond = async () => Response.json(VERIFIED),
}: {
  readonly respond?: (request: CapturedRequest) => Promise<Response>
} = {}) => {
  const requests: Array<CapturedRequest> = []
  const taxmaxi = TaxMaxi.fromBrowserSession({
    baseUrl: BASE_URL,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const rawBody =
        init?.body === undefined || init.body === null ? "" : await new Response(init.body).text()
      const request = {
        method: init?.method ?? "GET",
        path: url.pathname,
        body: rawBody === "" ? undefined : JSON.parse(rawBody),
      }
      requests.push(request)
      return respond(request)
    },
  })

  const rootRoute = createRootRoute({ component: Outlet })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/verify-email",
    component: () => <VerifyEmailPage taxmaxi={() => taxmaxi} />,
  })
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => <p>Login page</p>,
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
  const routeTree = rootRoute.addChildren([pageRoute, loginRoute, appRoute])
  const history = createMemoryHistory({ initialEntries: ["/verify-email"] })
  const router = createRouter({ history, routeTree })

  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )

  return { cachedQueriesOnAppEntry, history, queryClient, requests }
}

const codeField = () => screen.getByLabelText("Verification code")

const submitCode = (code: string) => {
  fireEvent.change(codeField(), { target: { value: code } })
  fireEvent.click(screen.getByRole("button", { name: "Verify" }))
}

const resendButton = () => screen.getByRole("button", { name: "Send a new code" })

// The visible countdown, as opposed to the live region that announces the wait.
const countdown = (seconds: number) =>
  screen.getByText(`You can ask for a new code in ${seconds} s.`, {
    selector: "p:not([role='status'])",
  })

describe("VerifyEmailPage verify", () => {
  it("sends the trimmed uppercase code, disables submit while pending, then enters the app", async () => {
    const response = deferred<Response>()
    const { cachedQueriesOnAppEntry, history, queryClient, requests } = await renderVerifyEmailPage(
      { respond: () => response.promise }
    )
    // Someone else loaded the app in this tab before; their cache must not survive.
    queryClient.setQueryData(queryKeys.account(), {
      account: { id: "00000000-0000-4000-8000-000000000001", email: "a@example.com" },
      loginMethods: [],
    })

    submitCode("  abcd1234 ")

    const submit = screen.getByRole("button", { name: "Verify" })
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(true))
    expect(history.location.pathname).toBe("/verify-email")

    response.resolve(Response.json(VERIFIED))

    await waitFor(() => expect(history.location.pathname).toBe("/app"))
    expect(requests).toEqual([
      { method: "POST", path: "/auth/verify-email", body: { code: "ABCD1234" } },
    ])
    expect(cachedQueriesOnAppEntry).toEqual([0])
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })).toEqual([])
  })

  it("shows the invalid-code message on the field", async () => {
    const { history } = await renderVerifyEmailPage({
      respond: async () => Response.json(CODE_INVALID_BODY, { status: 400 }),
    })

    submitCode("ABCD1234")

    const message = await screen.findByText(
      "This code is not right. Check the email and try again."
    )
    expect(codeField().getAttribute("aria-invalid")).toBe("true")
    expect(codeField().getAttribute("aria-describedby")).toBe(message.id)
    expect(screen.queryByText(CODE_INVALID_BODY.message)).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(history.location.pathname).toBe("/verify-email")
    await waitFor(() => expect(document.activeElement).toBe(codeField()))
    expect(screen.getByRole("button", { name: "Verify" }).hasAttribute("disabled")).toBe(false)
  })

  it("treats a code the SDK refuses like an invalid code, without a request", async () => {
    const { requests } = await renderVerifyEmailPage()

    submitCode("ABC")

    await screen.findByText("This code is not right. Check the email and try again.")
    expect(codeField().getAttribute("aria-invalid")).toBe("true")
    expect(requests).toEqual([])
  })

  it("shows the expired message with the resend button ready", async () => {
    await renderVerifyEmailPage({
      respond: async () => Response.json(CODE_EXPIRED_BODY, { status: 400 }),
    })

    submitCode("ABCD1234")

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("This code has expired. Ask for a new one.")
    expect(codeField().getAttribute("aria-invalid")).toBe("true")
    expect(codeField().getAttribute("aria-describedby")).toBe(alert.id)
    expect(resendButton().hasAttribute("disabled")).toBe(false)
    expect(screen.queryByText(CODE_EXPIRED_BODY.message)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })

  it("shows the missing-flow message with a login link", async () => {
    await renderVerifyEmailPage({
      respond: async () => Response.json(FLOW_MISSING_BODY, { status: 400 }),
    })

    submitCode("ABCD1234")

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Your verification session has ended.")
    expect(
      screen.getByRole("link", { name: "Log in to get a new code" }).getAttribute("href")
    ).toBe("/login")
    expect(codeField().getAttribute("aria-invalid")).toBe("false")
    expect(screen.queryByText(FLOW_MISSING_BODY.message)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })

  it("shows the generic failure message for an unexpected error", async () => {
    await renderVerifyEmailPage({
      respond: async () =>
        Response.json({ _tag: "InternalServerError", message: "boom" }, { status: 500 }),
    })

    submitCode("ABCD1234")

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Something went wrong. Please try again.")
    expect(screen.queryByText("boom")).toBeNull()
    expect(codeField().getAttribute("aria-invalid")).toBe("false")
  })
})

describe("VerifyEmailPage resend", () => {
  it("asks for a new code through the SDK and says it is on its way", async () => {
    const { requests } = await renderVerifyEmailPage({
      respond: async () => Response.json(VERIFICATION_FLOW),
    })

    fireEvent.click(resendButton())

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("A new code is on its way.")
    )
    expect(requests).toEqual([
      { method: "POST", path: "/auth/resend-verification", body: undefined },
    ])
    expect(resendButton().hasAttribute("disabled")).toBe(false)
  })

  it("clears an earlier code message once a new code is sent", async () => {
    await renderVerifyEmailPage({
      respond: async (request) =>
        request.path === "/auth/verify-email"
          ? Response.json(CODE_EXPIRED_BODY, { status: 400 })
          : Response.json(VERIFICATION_FLOW),
    })

    submitCode("ABCD1234")
    await screen.findByRole("alert")

    fireEvent.click(resendButton())

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("A new code is on its way.")
    )
    expect(screen.queryByRole("alert")).toBeNull()
    expect(codeField().getAttribute("aria-invalid")).toBe("false")
  })

  it("disables the button with a countdown when the resend is rate limited", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await renderVerifyEmailPage({
      respond: async () => Response.json(RESEND_LIMITED_BODY, { status: 429 }),
    })

    fireEvent.click(resendButton())

    await waitFor(() => expect(countdown(42)).toBeDefined())
    expect(resendButton().hasAttribute("disabled")).toBe(true)
    expect(screen.queryByText(RESEND_LIMITED_BODY.message)).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(countdown(41)).toBeDefined()
    expect(resendButton().hasAttribute("disabled")).toBe(true)

    // A tab that was asleep gets no ticks; the wait still ends on time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.queryByText(/ask for a new code in/)).toBeNull()
    expect(resendButton().hasAttribute("disabled")).toBe(false)
  })

  it("announces the wait once when it starts and once when it ends, not every second", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await renderVerifyEmailPage({
      respond: async () => Response.json(RESEND_LIMITED_BODY, { status: 429 }),
    })

    fireEvent.click(resendButton())

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("You can ask for a new code in 42 s.")
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(countdown(40)).toBeDefined()
    expect(screen.getByRole("status").textContent).toBe("You can ask for a new code in 42 s.")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000)
    })
    expect(screen.getByRole("status").textContent).toBe("You can ask for a new code now.")
    expect(resendButton().hasAttribute("disabled")).toBe(false)
  })

  it("shows the missing-flow message when the resend has no session", async () => {
    await renderVerifyEmailPage({
      respond: async () => Response.json(FLOW_MISSING_BODY, { status: 400 }),
    })

    fireEvent.click(resendButton())

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Your verification session has ended.")
    expect(
      screen.getByRole("link", { name: "Log in to get a new code" }).getAttribute("href")
    ).toBe("/login")
    expect(screen.getByRole("status").textContent).toBe("")
  })
})
