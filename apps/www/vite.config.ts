import { fileURLToPath } from "node:url"

import { cloudflare } from "@cloudflare/vite-plugin"
import { paraglideVitePlugin } from "@inlang/paraglide-js"
import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { paraglideCompilerOptions } from "#/lib/i18n"

const config = defineConfig(({ command }) => {
  const productionBuild = command === "build"
  // Keep development route types available to tsc without bundling the workshop.
  const productionRouteTree = fileURLToPath(
    new URL("./.tanstack/routeTree.production.ts", import.meta.url)
  )

  return {
    resolve: {
      tsconfigPaths: true,
      alias: productionBuild ? [{ find: "./routeTree.gen", replacement: productionRouteTree }] : [],
    },
    plugins: [
      {
        name: "atelier-production-boundary",
        apply: "build",
        enforce: "pre",
        resolveId(source) {
          if (source.endsWith("/routes/atelier")) return "\0atelier-production-not-found"
        },
        load(id) {
          if (id === "\0atelier-production-not-found") {
            // Reserve the path so it cannot fall through to the CMS /$slug loader.
            return `import { createFileRoute, notFound } from "@tanstack/react-router";
export const Route = createFileRoute("/atelier")({ beforeLoad: () => { throw notFound() } });`
          }
        },
        transform(code, id) {
          if (id.endsWith("/src/paraglide/messages/_index.js")) {
            // Dynamic message lookup elsewhere retains the whole namespace.
            return code.replace(/^export \* from ['"]\.\/atelier_[^'"]+['"];?$/gm, "")
          }
          if (
            id.split("?")[0]?.endsWith("/src/styles.css") &&
            code.includes('@import "tailwindcss"')
          ) {
            // Tailwind scans source files even when the router does not import them.
            return `${code}\n@source not "./components/atelier";\n`
          }
        },
        generateBundle() {
          for (const id of this.getModuleIds()) {
            if (
              /\/src\/(components\/atelier\/|routes\/atelier\.|paraglide\/messages\/atelier_)/.test(
                id
              )
            ) {
              this.error(`Atelier entered the production ${this.environment.name} graph: ${id}`)
            }
          }
        },
      },
      devtools(),
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      tailwindcss(),
      tanstackStart({
        router: productionBuild
          ? {
              generatedRouteTree: productionRouteTree,
            }
          : {},
      }),
      viteReact(),
      paraglideVitePlugin({
        project: "./project.inlang",
        outdir: "./src/paraglide",
        ...paraglideCompilerOptions,
      }),
    ],
  }
})

export default config
