#!/usr/bin/env node
/**
 * Run the e2e suite on a port of its own.
 *
 * The suite starts a dev server of its own and points `baseURL` at it, and the
 * port it used was FIXED (1420) — which is also the port `pnpm tauri dev` pins
 * for the app's own window (`tauri.conf.json`'s `devUrl`, `vite.config.ts`'s
 * `strictPort`). So a run either refused to start because the app was up, or —
 * worse, and observed — killed the app's server to take the port.
 *
 * The port therefore has to be chosen BEFORE Playwright loads: `defineConfig`
 * takes an object, not a function (`playwright/types/test.d.ts`), so the config
 * cannot pick one asynchronously. This wrapper picks it, hands it over in the
 * environment, and forwards the exit code and signals.
 *
 * Nothing here touches the app's own port: `vite.config.ts`'s `server.port` and
 * `strictPort` stay exactly as they are, because `tauri dev` depends on both.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** The port the app's own dev server uses. Only a fallback: never taken. */
const APP_PORT = 1420

/**
 * Ask the OS for a free port. Resolving to null (rather than guessing) is what
 * lets the caller fall back to the app's port with a visible note instead of
 * running on a port something else may take between the check and the bind.
 */
function freePort() {
  return new Promise((resolvePort) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', () => resolvePort(null))
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : null
      probe.close(() => resolvePort(port))
    })
  })
}

const port = (await freePort()) ?? APP_PORT
if (port === APP_PORT) {
  // Say it out loud: a direct run on the app's port is the case the fix exists
  // for, and it can only happen when the OS could not hand out a port.
  console.warn(`[e2e] no free port could be reserved; falling back to ${APP_PORT}`)
} else {
  console.log(`[e2e] running on port ${port} (the app's ${APP_PORT} is left alone)`)
}

const here = dirname(fileURLToPath(import.meta.url))
const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'test', ...process.argv.slice(2)],
  {
    cwd: resolve(here, '..'),
    stdio: 'inherit',
    env: { ...process.env, NEKOWITE_E2E_PORT: String(port) },
  },
)

// Signals are forwarded rather than swallowed: a Ctrl+C must stop the run the
// way it always did, and Playwright is what owns the dev server it started.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
