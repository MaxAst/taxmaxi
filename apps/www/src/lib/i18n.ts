import type { Locale } from "#/paraglide/runtime"
import type { CompilerOptions } from "@inlang/paraglide-js"
import type { FileRoutesByTo } from "../routeTree.gen"

type RoutePath = keyof FileRoutesByTo

const baseLocale = "en" satisfies Locale

const excludedPaths = ["admin", "docs", "api", "dashboard", "app"] as const

type PublicRoutePath = Exclude<RoutePath, `${string}${(typeof excludedPaths)[number]}${string}`>

type UrlPatterns = NonNullable<CompilerOptions["urlPatterns"]>
type RouteStrategies = NonNullable<CompilerOptions["routeStrategies"]>
type LocaleStrategy = NonNullable<CompilerOptions["strategy"]>

type TranslatedPathname = {
  pattern: string
  localized: Array<[Locale, string]>
}

function toUrlPattern(path: string) {
  const pattern = path
    // catch-all
    .replace(/\/\$$/, "/:path(.*)?")
    // optional parameters: {-$param}
    .replace(/\{-\$([a-zA-Z0-9_]+)\}/g, ":$1?")
    // named parameters: $param
    .replace(/\$([a-zA-Z0-9_]+)/g, ":$1")
    // remove trailing slash
    .replace(/\/+$/, "")

  return pattern === "" ? "/" : pattern
}

function toLocalizedPattern(locale: Locale, path: string) {
  const pattern = toUrlPattern(path)

  if (locale === baseLocale) {
    return pattern
  }

  if (pattern === "/") {
    return `/${locale}`
  }

  return `/${locale}${pattern}`
}

function createTranslatedPathnames(
  input: Record<PublicRoutePath, Record<Locale, string>>
): TranslatedPathname[] {
  return Object.entries(input).map(([pattern, locales]) => ({
    pattern: toUrlPattern(pattern),
    localized: Object.entries(locales).map(
      ([locale, path]) =>
        [locale as Locale, toLocalizedPattern(locale as Locale, path)] satisfies [Locale, string]
    ),
  }))
}

const cookieLocalePath = (pattern: string): TranslatedPathname => ({
  pattern,
  localized: [
    ["en", pattern],
    ["de", pattern],
  ],
})

const preferenceLocalePathnames = [
  cookieLocalePath("/dashboard/:path(.*)?"),
  cookieLocalePath("/app"),
  cookieLocalePath("/app/:path(.*)?"),
] satisfies UrlPatterns

export const localeStrategy = ["url", "cookie", "baseLocale"] satisfies LocaleStrategy

export const translatedPathnames = [
  ...preferenceLocalePathnames,
  ...createTranslatedPathnames({
    "/": {
      en: "/",
      de: "/",
    },
    "/about": {
      en: "/about",
      de: "/ueber",
    },
    "/assets": {
      en: "/assets",
      de: "/assets",
    },
    "/assets/$assetId": {
      en: "/assets/$assetId",
      de: "/assets/$assetId",
    },
    "/articles/$slug": {
      en: "/articles/$slug",
      de: "/artikel/$slug",
    },
    "/coinbase-sign-in": {
      en: "/coinbase-sign-in",
      de: "/coinbase-sign-in",
    },
    "/demo/ai-chat": {
      en: "/demo/ai-chat",
      de: "/demo/ai-chat",
    },
    "/demo/ai-image": {
      en: "/demo/ai-image",
      de: "/demo/ai-image",
    },
    "/demo/ai-structured": {
      en: "/demo/ai-structured",
      de: "/demo/ai-structured",
    },
    "/demo/posthog": {
      en: "/demo/posthog",
      de: "/demo/posthog",
    },
    "/demo/tanstack-query": {
      en: "/demo/tanstack-query",
      de: "/demo/tanstack-query",
    },
    "/demo/store": {
      en: "/demo/store",
      de: "/demo/speicher",
    },
    "/demo/form/address": {
      en: "/demo/form/address",
      de: "/demo/formular/adresse",
    },
    "/demo/form/simple": {
      en: "/demo/f/simple",
      de: "/demo/formular/simpel",
    },
    "/demo/guitars/$guitarId": {
      en: "/demo/guitars/$guitarId",
      de: "/demo/gitarren/$guitarId",
    },
    "/demo/guitars": {
      en: "/demo/guitars",
      de: "/demo/gitarren",
    },
    "/imprint": {
      en: "/imprint",
      de: "/impressum",
    },
    "/login": {
      en: "/login",
      de: "/login",
    },
    "/privacy": {
      en: "/privacy",
      de: "/datenschutz",
    },
    "/sign-up": {
      en: "/sign-up",
      de: "/registrieren",
    },
    "/terms": {
      en: "/terms",
      de: "/bedingungen",
    },
    "/verify-email": {
      en: "/verify-email",
      de: "/e-mail-bestaetigen",
    },
    "/tax-law/$slug": {
      en: "/tax-law/$slug",
      de: "/steuerrecht/$slug",
    },
    "/$slug": {
      en: "/$slug",
      de: "/$slug",
    },
  }),
] satisfies UrlPatterns

const cookieLocaleStrategy: LocaleStrategy = ["cookie", "baseLocale"]

export const routeStrategies = [
  { match: "/dashboard/:path(.*)?", strategy: cookieLocaleStrategy },
  { match: "/app", strategy: cookieLocaleStrategy },
  { match: "/app/:path(.*)?", strategy: cookieLocaleStrategy },
  { match: "/api/:path(.*)?", exclude: true },
  { match: "/demo/api/:path(.*)?", exclude: true },
] satisfies RouteStrategies

export const paraglideCompilerOptions = {
  cookieName: "PARAGLIDE_LOCALE",
  outputStructure: "message-modules" as const,
  strategy: localeStrategy,
  routeStrategies,
  urlPatterns: translatedPathnames,
}
