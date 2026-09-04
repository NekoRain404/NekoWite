// Perf-harness setup.
//
// The chunked graph layout and the incremental index builder yield to the main
// thread via `scheduler.yield()` → `requestAnimationFrame` → `setTimeout`. In
// happy-dom `requestAnimationFrame` may not fire on its own, which would stall
// the benchmarks forever. Route it through a macrotask so yields always progress.
const g = globalThis as {
  requestAnimationFrame?: (cb: (time: number) => void) => number
}
if (typeof g.requestAnimationFrame === 'function') {
  g.requestAnimationFrame = (cb) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number
}
