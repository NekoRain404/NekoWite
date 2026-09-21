import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { INSTRUMENTS } from './agent-scroll-instrument.mjs'

async function measure(scale) {
  const crops = []
  const window = {}
  class Screenshot {
    width = 200 * scale
    height = 100 * scale
    set src(value) { this.value = value; this.onload() }
  }
  const document = {
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 50, top: 30, right: 90, bottom: 50 }) }),
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData(x, y, width, height) {
          crops.push([x, y, width, height])
          return { data: new Uint8ClampedArray(width * height * 4) }
        },
      }),
    }),
  }
  runInNewContext(INSTRUMENTS, { window, document, Image: Screenshot, innerWidth: 200, innerHeight: 100 })
  const result = await new Promise((resolve) => window.__nkwPixelDiff({ sel: '.target', before: 'a', after: 'b' }, resolve))
  assert.equal(result.why, undefined)
  return crops
}

test('CSS-pixel screenshots preserve CSS coordinates', async () => {
  assert.deepEqual(await measure(1), [[38, 18, 64, 44], [38, 18, 64, 44]])
})

test('HiDPI screenshots crop the element in raster coordinates', async () => {
  assert.deepEqual(await measure(2), [[76, 36, 128, 88], [76, 36, 128, 88]])
})
