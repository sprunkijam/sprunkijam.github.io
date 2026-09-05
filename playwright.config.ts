import { defineConfig, devices } from "@playwright/test";

/**
 * Cold-load smoke for iPhone-sized Chromium (Edge iOS / Safari are WebKit;
 * this approximates the touch + viewport path in CI).
 */
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: "iphone-chromium",
      testIgnore: /desktop-resize\.spec\.ts|present-guard\.spec\.ts/,
      use: {
        ...devices["iPhone 14"],
        // Force Chromium after the iPhone preset (which defaults to WebKit).
        // Edge iOS is WebKit on device; this approximates touch + viewport in CI.
        browserName: "chromium",
      },
    },
    {
      name: "desktop-chromium",
      testMatch: /desktop-resize\.spec\.ts|present-guard\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 900, height: 600 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
    },
  ],
});
