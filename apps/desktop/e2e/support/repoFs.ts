/**
 * Absolute-path imports for e2e specs.
 *
 * Some specs need a module the app itself never imports (the clipboard writer,
 * the export renderer, the image resolver) so they can call into it directly.
 * The Vite dev server serves any absolute path under the `/@fs/` prefix, which
 * means the spec has to know where the repository is - and hardcoding one
 * developer's checkout made those specs fail on every other machine and in CI.
 *
 * The path is derived from this file's own location instead, so a clone
 * anywhere (Windows or POSIX) resolves to its own tree.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

/** `e2e/support` -> the repository root (support -> e2e -> desktop -> apps -> root). */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
)

/**
 * A Vite `/@fs/` URL for a file in this repository.
 *
 * Vite wants forward slashes even on Windows, and the leading slash before the
 * drive letter is what makes it an absolute URL path rather than a request
 * relative to the dev server root.
 */
export function repoFsUrl(...segments: string[]): string {
  // Vite wants forward slashes on every platform; on POSIX the resolved path
  // already begins with one, which is the form Vite expects there.
  const absolute = path.resolve(REPO_ROOT, ...segments).split(path.sep).join("/")
  return "/@fs/" + absolute
}
