import { defineConfig } from "vitest/config";

// Unit tests for the frontend's pure logic (src/**/*.test.ts). Separate from
// vite.config.ts on purpose: the tests need none of the app's dev-server or
// Tauri settings, and the app build must not change because of them.

// Fixed, and one with daylight saving time, so tests of local-midnight and
// calendar-day logic mean the same on every machine.
process.env.TZ = "Europe/Berlin";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
  },
});
