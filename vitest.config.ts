import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// The Worker serves the dashboard from `web/dist`. The test pool needs that
// directory to exist; a placeholder keeps `bun run test` working before the
// dashboard has been built. `bun run web:build` replaces it with the real app.
const ASSETS_DIR = "web/dist";
const ASSETS_INDEX = `${ASSETS_DIR}/index.html`;

const ensureAssetsDirectory = async (): Promise<void> => {
  if (existsSync(ASSETS_INDEX)) {
    return;
  }
  await mkdir(ASSETS_DIR, { recursive: true });
  await writeFile(
    ASSETS_INDEX,
    '<!doctype html><html lang="en"><body><div id="root"></div></body></html>\n'
  );
  console.warn(
    `[vitest] ${ASSETS_INDEX} was missing; wrote a placeholder. Run "bun run web:build" for the real dashboard.`
  );
};

export default defineConfig(async () => {
  await ensureAssetsDirectory();
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          bindings: {
            ADMIN_API_TOKEN: "test-admin-token",
            GMAIL_ACCOUNT_EMAIL: "owner@example.test",
            GOOGLE_CLIENT_ID: "test-google-client-id",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
            GOOGLE_REFRESH_TOKEN: "test-google-refresh-token",
            TEST_MIGRATIONS: migrations,
          },
        },
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
    test: {
      exclude: [...configDefaults.exclude, "tests/live/**", "web/**"],
      setupFiles: ["./tests/setup.ts"],
    },
  };
});
