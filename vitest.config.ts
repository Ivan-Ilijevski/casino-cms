import { defineConfig } from 'vitest/config'

// Vitest would otherwise pick up vite.config.ts, whose `root: 'web'` is meant
// for the SPA build and hides every server test under test/.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
