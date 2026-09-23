export interface StartupMaskClock {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

const browserClock: StartupMaskClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
}

/** Keeps the first paint calm while startup work settles, without hiding a hung app forever. */
export function createStartupMaskController(
  hide: () => void,
  clock: StartupMaskClock = browserClock,
  minimumMs = 1000,
  maximumMs = 3000,
) {
  let ready = false
  let minimumElapsed = false
  let hidden = false
  let minimumTimer: ReturnType<typeof setTimeout> | null = null
  let maximumTimer: ReturnType<typeof setTimeout> | null = null
  let startedAt = 0

  function finish(): void {
    if (hidden) return
    hidden = true
    if (minimumTimer !== null) clock.clearTimeout(minimumTimer)
    if (maximumTimer !== null) clock.clearTimeout(maximumTimer)
    hide()
  }

  return {
    start(): void {
      if (startedAt !== 0) return
      startedAt = Date.now()
      minimumTimer = clock.setTimeout(() => {
        minimumElapsed = true
        if (ready) finish()
      }, minimumMs)
      maximumTimer = clock.setTimeout(finish, maximumMs)
    },
    markReady(): void {
      // Startup can settle before Vue has mounted the overlay (notably when
      // no vault is restored). Keep the minimum display window anchored to the
      // first render rather than allowing a ready callback to skip it.
      ready = true
      if (minimumElapsed) finish()
    },
    dispose(): void {
      if (minimumTimer !== null) clock.clearTimeout(minimumTimer)
      if (maximumTimer !== null) clock.clearTimeout(maximumTimer)
    },
  }
}
