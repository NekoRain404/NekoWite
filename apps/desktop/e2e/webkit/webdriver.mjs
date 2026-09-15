/**
 * A WebDriver (classic, HTTP/JSON) client, and nothing else.
 *
 * WebKitGTK ships `WebKitWebDriver` and `MiniBrowser` but no Node client, and
 * this repo has none either — `playwright` is a Chromium-and-friends driver and
 * its `webkit` browser is a Playwright build, not the GTK port. So the smallest
 * thing that can talk to the engine that actually ships is these HTTP calls.
 *
 * The protocol is small enough that a dependency would be larger than the code
 * it replaces: four verbs over `fetch`, and the session id in the path.
 */
import { createServer } from 'node:net'

/**
 * Ask the OS for a free port.
 *
 * The same rule `scripts/run-e2e.mjs` states for the dev server applies here:
 * resolving to null rather than guessing is what lets the caller fail loudly
 * instead of binding a port something else may take in between. Nothing in this
 * file has a default port, so the app's 1420 can never be the answer.
 */
export function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', () => resolve(null))
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : null
      probe.close(() => resolve(port))
    })
  })
}

export class WebDriver {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`
    this.sessionId = null
    /** Every command WebDriver ran, so a failure can be read back in order. */
    this.log = []
  }

  async #request(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      // A non-JSON body is the driver dying rather than answering; the text is
      // the only diagnostic there is, so it is carried into the error below.
    }
    if (!res.ok) {
      const message = json?.value?.message ?? text
      throw new Error(
        `${method} ${path} -> ${res.status}: ${message}\n${json?.value?.stack ?? ''}`.trim(),
      )
    }
    return json?.value
  }

  #path(suffix = '') {
    if (!this.sessionId) throw new Error('no session — call session() first')
    return `/session/${this.sessionId}${suffix}`
  }

  /**
   * Start a session, retrying while the driver is still binding its port.
   *
   * `browserName` is `MiniBrowser` because that is the GTK example browser
   * WebKitWebDriver drives; the shipped app uses `wry` on the same
   * `WebKitWebView` API, so the engine is identical and only the embedding
   * differs. `webkitgtk:browserOptions` takes `args`, which is where the
   * automation flag would go if a future MiniBrowser grew a headless mode.
   */
  async session(capabilities = { browserName: 'MiniBrowser' }) {
    const deadline = Date.now() + 20_000
    for (;;) {
      try {
        const value = await this.#request('POST', '/session', {
          capabilities: { alwaysMatch: capabilities },
        })
        this.sessionId = value.sessionId
        return value.capabilities
      } catch (error) {
        if (Date.now() > deadline) throw error
        await sleep(250)
      }
    }
  }

  navigate(url) {
    this.log.push(`navigate ${url}`)
    return this.#request('POST', this.#path('/url'), { url })
  }

  /** Synchronous in-page evaluation. `script` is a function body with `return`. */
  execute(script, args = []) {
    return this.#request('POST', this.#path('/execute/sync'), { script, args })
  }

  /** Asynchronous evaluation: the script gets `arguments[arguments.length - 1]`. */
  executeAsync(script, args = []) {
    return this.#request('POST', this.#path('/execute/async'), { script, args })
  }

  findElement(css) {
    this.log.push(`find ${css}`)
    return this.#request('POST', this.#path('/element'), { using: 'css selector', value: css })
  }

  clickElement(elementId) {
    this.log.push('click')
    return this.#request('POST', this.#path(`/element/${elementId}/click`), {})
  }

  windowRect() {
    return this.#request('GET', this.#path('/window/rect'))
  }

  setWindowRect(rect) {
    return this.#request('POST', this.#path('/window/rect'), rect)
  }

  /** The page's own console, so a startup failure is visible as a message. */
  async logs() {
    try {
      return await this.#request('POST', this.#path('/log'), { type: 'browser' })
    } catch {
      return null
    }
  }

  async quit() {
    if (!this.sessionId) return
    const id = this.sessionId
    this.sessionId = null
    try {
      await this.#request('DELETE', `/session/${id}`)
    } catch {
      // A driver that has already torn itself down is the outcome we wanted.
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll `fn` until it returns a truthy value.
 *
 * Playwright's auto-waiting is the one thing this harness gives up by leaving
 * Playwright; every wait in the probes below therefore has to be written out,
 * which is also why they say what they are waiting for.
 */
export async function until(fn, { timeout = 15_000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(interval)
  }
}
