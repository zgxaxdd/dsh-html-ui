import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    /* 复用系统 Edge（channel msedge），无需下载 Chromium */
    browserName: 'chromium',
    channel: 'msedge',
    headless: true,
  },
  reporter: [['list']],
})
