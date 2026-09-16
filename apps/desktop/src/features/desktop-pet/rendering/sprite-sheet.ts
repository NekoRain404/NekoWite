/**
 * The current character's spritesheet: loading it, slicing it, and letting it go.
 *
 * Ported from `references/desktop-pet/windows/src/pet.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`, `load` (165-198) and the fields it wrote
 * (`img`, `clips`, `clipMaxW`, `loaded`, lines 116-134): the `crossOrigin = "anonymous"`
 * load, the plain retry for a pre-CORS cached copy, the cache-busting query, and the
 * "no clips" signal that makes the caller draw from the fixed grid.
 *
 * It is a module of its own because the frame loop and the sheet's lifetime are different
 * responsibilities, and because the plan splits files rather than accreting them (§9:
 * 不得先复制超长文件再承诺以后整理) - the resource rule it implements is §7.3's
 * 只加载当前角色……角色切换后释放旧图片、Object URL.
 *
 * Three things upstream did not have, all in the port's stated adaptations (plan §3):
 *   - an epoch, so a slow load cannot commit over a newer one;
 *   - a destruction path - upstream kept its sheet for the window's whole lifetime, but a
 *     Vue component unmounts (§7.1: 销毁监听/计时器);
 *   - a failure path that leaves the pet animating instead of frozen (see `retryPlain`).
 *
 * Upstream logged its load failures through the Tauri global (179-183); the plan (§9) keeps
 * platform code out of the rendering layer, so failures are reported to the caller.
 */
import {
  readSheetPixels,
  sliceSheet,
  type Rect,
  type SheetPixelReader,
  type SpriteImageLike,
} from './sprite-slicer'

/**
 * What loading touches on an image element. Structural, so a test can drive the load races
 * and failures that a real `Image` only produces when a network is involved.
 */
export interface LoadableImage extends SpriteImageLike {
  crossOrigin: string | null
  src: string
  onload: ((ev: Event) => void) | null
  onerror: ((ev: Event) => void) | null
}

export type ImageFactory = () => LoadableImage

/**
 * A sheet that could not be loaded. `cors` is the first attempt, `plain` the retry.
 *
 * Both are reported; which one a caller acts on is the caller's. The pet window acts on the first
 * - see `retryPlain` for what that leaves the retry with.
 */
export interface LoadFailure {
  url: string
  phase: 'cors' | 'plain'
}

export interface SheetLoaderDeps {
  /** Image factory. Defaults to `new Image()`. */
  createImage?: ImageFactory
  /** Sheet pixel reader. Defaults to the canvas-based one; injected for tests. */
  readPixels?: SheetPixelReader
  /** Both load attempts failed. Reported so the shell can log or fall back, not silently. */
  onLoadError?: (failure: LoadFailure) => void
  /**
   * Releases the URL of a sheet that is no longer displayed (§7.3: 角色切换后释放旧图片、
   * Object URL). Upstream never created one, so this is a hook for the resource owner: the
   * loader only ever holds a URL it was given, and revoking someone else's is not its call.
   */
  releaseUrl?: (url: string) => void
}

/** `new Image()`, typed as the narrow interface the loader uses. */
const createBrowserImage: ImageFactory = () => new Image() as unknown as LoadableImage

/**
 * Upstream cache-busted every non-`data:` URL so the request would carry CORS headers
 * instead of replaying a cached non-CORS response (193-197). A query is only meaningful
 * where there is an HTTP cache: `blob:` and Tauri's asset URLs are per-document
 * identifiers, not cache keys, and a query appended to one is not guaranteed to resolve.
 */
export function cacheBustedUrl(url: string): string {
  if (url.startsWith('data:') || !/^https?:/i.test(url)) return url
  return url + (url.includes('?') ? '&' : '?') + 'cors=1'
}

export class SheetLoader {
  private image: LoadableImage | null = null
  private clips: Rect[][] = []
  private loaded = false
  private loadedUrl: string | null = null
  private pending: LoadableImage | null = null
  private epoch = 0
  private destroyed = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: SheetLoaderDeps) {}

  /** The loaded sheet, for whoever draws it. */
  get currentImage(): LoadableImage | null {
    return this.image
  }

  /** The sliced clips of the loaded sheet; empty means "draw from the fixed grid". */
  get currentClips(): Rect[][] {
    return this.clips
  }

  /** Whether a sheet is on screen and usable. */
  get isLoaded(): boolean {
    return this.loaded
  }

  /** Called whenever the sheet behind the pet changes (a commit, or an unload). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Load a spritesheet (upstream 165-198). The previous sheet stays on screen, frozen,
   * until the new one has decoded - upstream set `loaded = false` first for the same
   * reason, so switching characters does not flash an empty window.
   *
   * The epoch is the port's addition: upstream's handlers captured nothing, so a slow
   * first load could commit over a newer one. A load that is no longer the current one
   * commits nothing - whether it succeeds or fails.
   */
  load(url: string): void {
    const epoch = ++this.epoch
    const hadSheet = this.loaded
    this.loaded = false
    this.detach(this.pending)

    const img = this.deps.createImage?.() ?? createBrowserImage()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (!this.isCurrent(epoch)) return
      this.commit(img, url, sliceSheet(img, this.deps.readPixels ?? readSheetPixels))
    }
    img.onerror = () => {
      if (!this.isCurrent(epoch)) return
      // Reported *before* the retry starts, so a caller that acts on this report takes the loader
      // (and with it the retry) with it, and the retry then has nobody left to commit to.
      this.deps.onLoadError?.({ url, phase: 'cors' })
      this.retryPlain(url, epoch, hadSheet)
    }
    this.pending = img
    img.src = cacheBustedUrl(url)
  }

  /**
   * Upstream's retry (177-192): a pre-CORS cached copy makes the `crossOrigin` load fail,
   * and the plain load succeeds - displayable, but its pixels are unreadable, so slicing
   * is skipped (`clips = []`) and the caller draws from the fixed grid.
   *
   * It is for a sheet the webview fetches itself over `http(s)`: a server that sends no
   * `Access-Control-Allow-Origin`, or a cache entry from before it did. The product has no such
   * sheet - the host hands over an absolute path, the adapter turns that into `asset://`, and
   * `cacheBustedUrl` leaves a non-`http(s)` URL alone - so there the two attempts are the same
   * request and the second cannot win what the first lost. (Measured in WebKitGTK 2.52.6: a
   * `crossOrigin` load of a registered scheme succeeds when the handler answers with that header,
   * which Tauri's asset protocol always does - `tauri-2.11.5/src/protocol/asset.rs:39` - and fails
   * when it does not, so an `asset://` failure is one this repeats rather than one it repairs.)
   *
   * It cannot commit in the pet window either: `DesktopPetRoot` refuses the sprite branch on the
   * report above, which unmounts the sprite and destroys this loader (epoch and `destroyed`) before
   * the retry's callbacks land. Nothing repaints, so what a user loses by that refusal is the
   * sentence's arrival time, not a character that would have drawn. The one mount site that could
   * reach it is `PetFloatingBall.vue`, which passes no `on-load-error` and which nothing mounts.
   *
   * Kept because it is upstream's behaviour for a URL this loader is still willing to be given, and
   * because `LoadFailure.phase` - which the window's sentence prints - would have one arm without
   * it.
   */
  private retryPlain(url: string, epoch: number, hadSheet: boolean): void {
    const plain = this.deps.createImage?.() ?? createBrowserImage()
    plain.onload = () => {
      if (!this.isCurrent(epoch)) return
      // An empty clip list is the contract for "pixels unknown" (upstream 188).
      this.commit(plain, url, [])
    }
    plain.onerror = () => {
      if (!this.isCurrent(epoch)) return
      this.deps.onLoadError?.({ url, phase: 'plain' })
      this.pending = null
      // Upstream left the retry's error unhandled (184-192), so a failed character switch
      // froze the pet on the old sprite forever with no way back. Keep whatever was on
      // screen animating instead, and let the caller report the failure.
      this.loaded = hadSheet
    }
    plain.src = url
    this.pending = plain
  }

  private commit(image: LoadableImage, url: string, clips: Rect[][]): void {
    this.image = image
    this.clips = clips
    this.loaded = true
    this.pending = null
    this.loadedUrl = url
    this.announce()
  }

  /**
   * Forget the current sheet (character removed, preview closed). Upstream had exactly one
   * spritesheet per window for its whole lifetime, so there was no equivalent; §7.3 wants
   * the image released once it is no longer displayed.
   */
  unload(): void {
    this.epoch++
    this.detach(this.pending)
    this.pending = null
    if (this.loadedUrl !== null) this.deps.releaseUrl?.(this.loadedUrl)
    this.detach(this.image)
    this.image = null
    this.clips = []
    this.loaded = false
    this.loadedUrl = null
    this.announce()
  }

  /** Cancel a load in flight and drop the sheet; no further callback can arrive. */
  destroy(): void {
    this.destroyed = true
    this.unload()
    this.listeners.clear()
  }

  private isCurrent(epoch: number): boolean {
    return !this.destroyed && epoch === this.epoch
  }

  /** Detach an image's handlers, so a dropped element cannot call back into the loader. */
  private detach(img: LoadableImage | null): void {
    if (!img) return
    img.onload = null
    img.onerror = null
  }

  private announce(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
