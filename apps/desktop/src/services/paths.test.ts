import { describe, expect, it } from 'vitest'
import {
  baseName,
  dirName,
  joinPath,
  samePath,
  stripVaultPrefix,
  usesBackslash,
} from './paths'

// The exact spelling the Rust layer returns on Windows: a verbatim prefix and
// backslash separators. Every helper has to work on this AND on a POSIX path.
const WIN = '\\\\?\\C:\\Users\\Lenovo\\Documents\\vault\\notes\\hello.md'
const WIN_DIR = '\\\\?\\C:\\Users\\Lenovo\\Documents\\vault\\notes'
const POSIX = '/home/me/vault/notes/hello.md'

describe('baseName', () => {
  it('returns the file name for a Windows path', () => {
    // The whole reason this module exists: `split('/').pop()` returned the
    // ENTIRE absolute path, which the tab bar and note list then rendered as
    // the document's name.
    expect(baseName(WIN)).toBe('hello.md')
  })

  it('returns the file name for a POSIX path', () => {
    expect(baseName(POSIX)).toBe('hello.md')
  })

  it('handles a trailing separator and a bare name', () => {
    expect(baseName('C:\\vault\\notes\\')).toBe('notes')
    expect(baseName('/vault/notes/')).toBe('notes')
    expect(baseName('hello.md')).toBe('hello.md')
    expect(baseName('')).toBe('')
  })

  it('keeps a name that merely contains a dot', () => {
    expect(baseName('C:\\vault\\v1.2.3.md')).toBe('v1.2.3.md')
  })
})

describe('dirName', () => {
  it('returns the parent directory for both separators', () => {
    expect(dirName(WIN)).toBe(WIN_DIR)
    expect(dirName(POSIX)).toBe('/home/me/vault/notes')
  })

  it('returns the input unchanged when there is no separator', () => {
    expect(dirName('hello.md')).toBe('hello.md')
  })

  it('handles a trailing separator', () => {
    expect(dirName('C:\\vault\\notes\\')).toBe('C:\\vault')
  })
})

describe('joinPath', () => {
  it('joins with a backslash for a Windows directory', () => {
    // A mixed `C:\dir/name` spelling is what made the rename destination look
    // wrong; the separator has to match the directory it extends.
    expect(joinPath(WIN_DIR, 'new.md')).toBe(WIN_DIR + '\\new.md')
  })

  it('joins with a slash for a POSIX directory', () => {
    expect(joinPath('/vault/notes', 'new.md')).toBe('/vault/notes/new.md')
  })

  it('never doubles the separator', () => {
    expect(joinPath('C:\\vault\\', 'a.md')).toBe('C:\\vault\\a.md')
    expect(joinPath('/vault/', 'a.md')).toBe('/vault/a.md')
  })

  it('handles an empty directory', () => {
    expect(joinPath('', 'a.md')).toBe('a.md')
  })
})

describe('stripVaultPrefix', () => {
  it('strips a Windows vault prefix and answers with forward slashes', () => {
    expect(stripVaultPrefix(WIN, '\\\\?\\C:\\Users\\Lenovo\\Documents\\vault')).toBe('notes/hello.md')
  })

  it('strips a POSIX vault prefix', () => {
    expect(stripVaultPrefix(POSIX, '/home/me/vault')).toBe('notes/hello.md')
  })

  it('tolerates a trailing separator on the vault', () => {
    expect(stripVaultPrefix(WIN, '\\\\?\\C:\\Users\\Lenovo\\Documents\\vault\\')).toBe('notes/hello.md')
    expect(stripVaultPrefix(POSIX, '/home/me/vault/')).toBe('notes/hello.md')
  })

  it('leaves a path outside the vault alone (minus leading separators)', () => {
    expect(stripVaultPrefix('D:\\other\\a.md', 'C:\\vault')).toBe('D:/other/a.md')
  })

  it('handles the vault root itself', () => {
    expect(stripVaultPrefix('C:\\vault', 'C:\\vault')).toBe('')
  })
})

describe('usesBackslash', () => {
  it('detects the separator style', () => {
    expect(usesBackslash(WIN)).toBe(true)
    expect(usesBackslash(POSIX)).toBe(false)
  })
})

describe('samePath', () => {
  it('treats Windows spellings of one folder as the same vault', () => {
    // The stored session and the open vault can differ in case or separators for
    // the SAME folder (mapped drive, re-typed capitalisation). A raw `!==`
    // dropped the whole restored tab set and then overwrote the session.
    expect(samePath('C:\\Vault', 'c:\\vault')).toBe(true)
    expect(samePath('C:\\Vault\\', 'C:\\Vault')).toBe(true)
    expect(samePath('C:/Vault', 'C:\\Vault')).toBe(true)
    expect(samePath('\\\\server\\share\\v', '\\\\SERVER\\SHARE\\V')).toBe(true)
  })

  it('keeps POSIX paths case-sensitive', () => {
    // Folding case there would merge two genuinely different directories.
    expect(samePath('/home/u/Vault', '/home/u/vault')).toBe(false)
    expect(samePath('/home/u/vault', '/home/u/vault/')).toBe(true)
  })

  it('does not merge different folders', () => {
    expect(samePath('C:\\Vault', 'C:\\Vault2')).toBe(false)
    expect(samePath('/a/b', '/a/c')).toBe(false)
  })
})
