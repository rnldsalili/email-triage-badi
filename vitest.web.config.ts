import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["web/test/**/*.test.{ts,tsx}"],
    setupFiles: ["./web/test/setup.ts"],
  },
});
