import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The desktop entry this app installs, asserted at the level it can be asserted
 * without a build: the files the bundler reads.
 *
 * It exists because the previous verification read `MimeType=` — the field it
 * expected to be wrong — quoted it, and confirmed it, twice, in two bundle
 * formats, while `Exec=` sat on the line above with no field code. Per the
 * Desktop Entry specification a path reaches the process *only* through
 * `%f`/`%F`/`%u`/`%U`, so a file manager launched the app as `argv ==
 * ["nekowite"]`, `markdown_arg` skipped `argv[0]` and found nothing, and every
 * bundle built from that tree shipped an association that could not deliver a
 * file. The `Exec=` line is therefore the one that gets an assertion here.
 *
 * What this file can and cannot prove. It reads the checked-in template and
 * `tauri.conf.json`, so it pins that the template carries the field code and
 * that the config points the bundler at it — and it fails if either is undone.
 * It does NOT prove the emitted `.desktop` carries them: that needs
 * `pnpm package:linux` and an extraction from the built bundle, and is the
 * evidence a change here has to be closed with.
 */

const TAURI_DIR = resolve(__dirname, '../../src-tauri')
const CONFIG_PATH = resolve(TAURI_DIR, 'tauri.conf.json')
const TEMPLATE_PATH = resolve(TAURI_DIR, 'linux/nekowite.desktop.hbs')

// Both read inside the tests rather than at module load: with the template
// missing, a top-level read fails the whole file and hides every other
// assertion behind one stack trace.
const readTemplate = (): string => readFileSync(TEMPLATE_PATH, 'utf8')

// Only the fields these tests read. `mimeType` is optional in the schema —
// `ext` is the sole required key — and the `.mdx` entry below relies on it.
interface FileAssociation {
  ext: string[]
  mimeType?: string
}

interface Config {
  bundle: {
    fileAssociations: FileAssociation[]
    linux: {
      deb: { desktopTemplate?: string }
      rpm: { desktopTemplate?: string }
    }
  }
}

const readConfig = (): Config => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))

/**
 * The template's actual content, stripped of the two things that do not reach
 * the entry: `#` comments (the Desktop Entry spec ignores them) and Handlebars
 * control lines. What is left is the entry key for key, which is how "this is
 * the built-in template plus one field code" stays checkable.
 */
const entryKeys = (template: string): string[] =>
  template
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('{{#') && !line.startsWith('{{/'))

describe('the desktop entry template', () => {
  it('carries a field code on Exec, which is the only way a path reaches the process', () => {
    const execLines = entryKeys(readTemplate()).filter((line) => line.startsWith('Exec='))

    expect(execLines).toEqual(['Exec={{exec}} %F'])
  })

  it('is the built-in entry otherwise, so nothing else drifts from what the CLI emits', () => {
    expect(entryKeys(readTemplate())).toEqual([
      '[Desktop Entry]',
      'Categories={{categories}}',
      'Comment={{comment}}',
      'Exec={{exec}} %F',
      'StartupWMClass={{exec}}',
      'Icon={{icon}}',
      'Name={{name}}',
      'Terminal=false',
      'Type=Application',
      'MimeType={{mime_type}}',
    ])
  })

  it('renders MimeType from the config rather than restating it', () => {
    // `mime_type` is the bundler's join of every `mimeType` in
    // `bundle.fileAssociations`; keeping it a variable is what makes dropping
    // `text/mdx` a config change and not two changes that can disagree.
    expect(readTemplate()).toContain('MimeType={{mime_type}}')
  })
})

describe('tauri.conf.json', () => {
  it('points deb, rpm and AppImage at the template', () => {
    const { bundle } = readConfig()

    // deb and rpm are separate settings on the bundler side — debian.rs reads
    // `settings.deb().desktop_template`, rpm.rs reads `settings.rpm()` — and the
    // AppImage has no template setting of its own: its bundler calls
    // `debian::generate_data`, so it follows the deb one. Setting only one of
    // the two leaves a shipped bundle on the built-in template.
    expect(bundle.linux.deb.desktopTemplate).toBe('linux/nekowite.desktop.hbs')
    expect(bundle.linux.rpm.desktopTemplate).toBe('linux/nekowite.desktop.hbs')
  })

  it('declares text/markdown and never text/mdx', () => {
    const { bundle } = readConfig()
    const mimeTypes = bundle.fileAssociations.flatMap((a) => a.mimeType ?? [])

    expect(mimeTypes).toEqual(['text/markdown'])
    // Measured: `xdg-mime query filetype x.mdx` is `application/x-genesis-32x-rom`
    // — `*.mdx` belongs to 32X ROM images in /usr/share/mime/globs — so
    // `text/mdx` is a type no Linux system has, and declaring it advertised this
    // app as a handler for a file it cannot read.
    expect(readFileSync(CONFIG_PATH, 'utf8')).not.toContain('text/mdx')
  })

  it('keeps .mdx as an association with no mime type, so the omission reads as a decision', () => {
    const { bundle } = readConfig()
    const mdx = bundle.fileAssociations.find((a) => a.ext.includes('mdx'))

    // `toBeDefined` is the assertion that `find` matched, not a narrowing —
    // TypeScript still sees `mdx` as possibly undefined, hence the `?.` here.
    expect(mdx).toBeDefined()
    expect(mdx?.mimeType).toBeUndefined()
  })

  it('leaves MARKDOWN_EXTENSIONS accepting .mdx, which argv reaches without MIME routing', () => {
    // The Rust comment beside the constant says the list mirrors
    // `bundle.fileAssociations`. It should go on mirroring it — `nekowite
    // note.mdx` from a terminal is a launch that works, and it needs no MIME
    // type to work — so the two halves are checked against each other rather
    // than one being quietly trimmed to match the other.
    const source = readFileSync(resolve(TAURI_DIR, 'src/open_file.rs'), 'utf8')
    const declaration = source.match(/MARKDOWN_EXTENSIONS[^=]*=\s*\[[^\]]*\]/)

    expect(declaration?.[0]).toContain('"mdx"')
  })
})
