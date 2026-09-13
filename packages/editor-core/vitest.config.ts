import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // See the file: it stops `@milkdown/ctx`'s uncancellable 3 s timer from
    // reporting a post-teardown ReferenceError as an uncaught error.
    setupFiles: ['./vitest.setup.ts'],
  },
})
