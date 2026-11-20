import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.mjs",
  webServer: {
    command: "python3 -m http.server 8080 --bind 127.0.0.1",
    url: "http://127.0.0.1:8080/",
  },
  use: { baseURL: "http://127.0.0.1:8080/" },
  projects: [
    { name: "iphone-webkit", use: { ...devices["iPhone 13"] } },
    { name: "desktop-webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
