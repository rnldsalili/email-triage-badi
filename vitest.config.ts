import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        miniflare: {
          bindings: {
            ADMIN_API_TOKEN: "test-admin-token",
            GOOGLE_CLIENT_ID: "test-google-client-id",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
            GOOGLE_REFRESH_TOKEN: "test-google-refresh-token",
            GMAIL_ACCOUNT_EMAIL: "owner@example.test",
            TEST_MIGRATIONS: migrations,
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
    test: {
      exclude: [...configDefaults.exclude, "tests/live/**"],
      setupFiles: ["./tests/setup.ts"],
    },
  };
});
