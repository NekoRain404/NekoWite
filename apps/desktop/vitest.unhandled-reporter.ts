/**
 * Report the run's unhandled errors by CATEGORY, beside vitest's own list of them.
 *
 * The ruling this exists for: a full run with unhandled exceptions is not green even when every
 * assertion passed, AND a broken test script is a different thing from a product defect — the two
 * are to be tracked and reported apart. Vitest already makes the first half true: it prints the
 * errors and exits non-zero unless `dangerouslyIgnoreUnhandledErrors` is set, which this project
 * does not set and must not (see the note under `test` in `vite.config.ts`). What it does not do is
 * the second half — its output is one flat list, so "the harness leaked a timer after teardown" and
 * "the app threw" read the same, and a reader who has to guess which is which will guess wrong.
 *
 * So this classifies, and only classifies. It deliberately does NOT:
 *
 *   - touch the exit code, or pass/fail in any way. An unhandled error is reported by vitest and
 *     fails the run exactly as it did before this file existed;
 *   - install a `process.on('unhandledRejection')` / `('uncaughtException')` listener. It cannot:
 *     vitest's own capture declines to report an error when a second listener is registered
 *     ("if there is another listener, assume that it's handled by user code",
 *     `vitest/dist/chunks/execute.*.js`), so a listener here would turn every unhandled error in
 *     the suite into silence — the precise failure this whole task is about. The reporter API is
 *     used instead, which is handed the same list vitest prints.
 *
 * The category is decided from the THROWING frame — the first stack frame that names a file — and
 * from vitest's own `VITEST_AFTER_ENV_TEARDOWN` flag, never from the error's message. Matching text
 * would classify today's error and mislead on tomorrow's.
 */
import type { Reporter } from 'vitest/node'

/** The three buckets, in the order they are printed. */
const CATEGORIES = [
  'product',
  'test-harness',
  'third-party/environment',
  'unclassified',
] as const

type Category = (typeof CATEGORIES)[number]

/** The first stack frame that names a file, as `file:line:col`. */
function throwingFrame(stack: string | undefined): string | null {
  if (!stack) return null
  for (const line of stack.split('\n').slice(1)) {
    const match = line.match(/\(?((?:[A-Za-z]:)?[^()\s]+):\d+:\d+\)?$/)
    if (match) return match[1]
  }
  return null
}

function classify(error: { stack?: string; VITEST_AFTER_ENV_TEARDOWN?: boolean }): Category {
  const frame = throwingFrame(error.stack)
  if (frame === null) return 'unclassified'
  // A frame inside a dependency is the dependency's own code running, wherever it was called from.
  if (frame.includes('/node_modules/')) return 'third-party/environment'
  // The harness: the spec files and their support, which are a test script rather than the app.
  if (/\.test\.ts$/.test(frame) || frame.includes('/e2e/') || frame.includes('/perf/')) {
    return 'test-harness'
  }
  // The application's own source.
  if (frame.includes('/src/')) return 'product'
  return 'unclassified'
}

/** One line per distinct message, with the file it was attributed to. */
function describe(error: { name?: string; message?: string; VITEST_TEST_PATH?: string }): string {
  const path = error.VITEST_TEST_PATH ? ` (while ${error.VITEST_TEST_PATH})` : ''
  return `${error.name ?? 'Error'}: ${error.message ?? ''}${path}`
}

export default class UnhandledErrorCategories implements Reporter {
  onFinished(_files: unknown, errors?: unknown[]): void {
    if (errors === undefined || errors.length === 0) return

    const byCategory = new Map<Category, Map<string, number>>()
    for (const raw of errors) {
      const error = raw as { stack?: string; name?: string; message?: string; VITEST_TEST_PATH?: string }
      const category = classify(error)
      const seen = byCategory.get(category) ?? new Map<string, number>()
      const line = describe(error)
      seen.set(line, (seen.get(line) ?? 0) + 1)
      byCategory.set(category, seen)
    }

    const total = errors.length
    const out = [
      '',
      `Unhandled errors by category — ${total} total, and the run is RED for all of them.`,
      'This split says which of them can be a product defect and which cannot. It does not excuse any.',
    ]
    for (const category of CATEGORIES) {
      const seen = byCategory.get(category)
      if (seen === undefined) continue
      const count = [...seen.values()].reduce((a, b) => a + b, 0)
      out.push('')
      out.push(`  ${category} — ${count}`)
      for (const [line, n] of seen) out.push(`    ${n}x ${line}`)
    }
    out.push('')

    // `console.log` and not a reporter logger: the point is for this to sit in the same plain text
    // a reader already scrolls, next to vitest's own unhandled-errors block.
    console.log(out.join('\n'))
  }
}
