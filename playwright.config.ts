import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./pw",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 10_000,
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
