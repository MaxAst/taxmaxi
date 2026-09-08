import { loadEnv } from "vite"
import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"

const wwwAliases = {
  "#": fileURLToPath(new URL("./apps/www/src", import.meta.url)),
  "@": fileURLToPath(new URL("./apps/www/src", import.meta.url)),
}

export default defineConfig({
  resolve: { alias: wwwAliases },
  test: {
    watch: false,
    coverage: {
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    },
    projects: [
      {
        resolve: { alias: wwwAliases },
        test: {
          include: [
            "packages/**/tests/**/*.test.ts",
            "apps/crawler/tests/**/*.test.ts",
            "apps/cli/tests/**/*.test.ts",
            "apps/server/tests/**/*.test.ts",
            "apps/worker/tests/**/*.test.ts",
            "apps/www/tests/**/*.test.ts",
            "apps/www/tests/**/*.test.tsx",
          ],
          exclude: [
            "packages/**/tests/**/*.integration.test.ts",
            "apps/worker/tests/**/*.integration.test.ts",
            "**/node_modules/**",
          ],
          name: { label: "unit", color: "cyan" },
          env: loadEnv("test", "./apps/server", ""),
          globalSetup: ["./apps/www/tests/support/vitest.paraglide.setup.ts"],
        },
      },
      {
        test: {
          include: [
            "packages/**/tests/**/*.integration.test.ts",
            "apps/**/tests/**/*.integration.test.ts",
          ],
          exclude: ["**/node_modules/**"],
          name: { label: "integration", color: "magenta" },
          // Bound database contention independently of the host's CPU count.
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
          env: loadEnv("test", "./apps/server", ""),
          globalSetup: ["./packages/persistence/tests/support/vitest.integration.setup.ts"],
        },
      },
    ],
  },
})
