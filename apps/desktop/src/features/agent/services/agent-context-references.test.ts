/**
 * The `+` menu's path rules: what a row may name, what a chosen row becomes, and where the text
 * lands in the message.
 *
 * Three of these are the ones a passing exit code would not show on its own — an entry outside the
 * vault, a folder that is inserted instead of walked into, and a reference fused to the word it was
 * dropped against — so each is asserted as the value that would be wrong rather than as "it
 * returned something".
 */
import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../../platform/gateways/contracts'
import {
  insertReferenceText,
  parentDirectory,
  referenceText,
  toFolder,
  toReference,
} from './agent-context-references'

const VAULT = '/home/user/vault'

function entry(path: string, name: string, isDir = false): FileEntry {
  return { name, path, is_dir: isDir, is_mdx: !isDir && name.endsWith('.md') }
}

describe('the directory a folder row leads to', () => {
  it('answers null at the vault root, so the root has no row up', () => {
    expect(parentDirectory('')).toBeNull()
  })

  it('walks one level at a time', () => {
    expect(parentDirectory('notes')).toBe('')
    expect(parentDirectory('notes/deep')).toBe('notes')
    expect(parentDirectory('notes/deep/er')).toBe('notes/deep')
  })
})

describe('what a listing row may name', () => {
  it('is the vault-relative path the engine resolves against its own folder', () => {
    expect(toReference(entry('/home/user/vault/notes/a.md', 'a.md'), VAULT)).toEqual({
      path: 'notes/a.md',
      name: 'a.md',
      isDirectory: false,
    })
  })

  it('drops an entry that is not inside the vault rather than inserting an absolute path', () => {
    // The host confines `list_dir` to the registered vault, so this is the guard behind that
    // confinement: a row that named /etc/hosts would be the composer telling the engine to read a
    // file the user never put in front of it.
    expect(toReference(entry('/etc/hosts', 'hosts'), VAULT)).toBeNull()
  })

  it('drops the vault root itself, which has no relative path to offer', () => {
    expect(toReference(entry(VAULT, 'vault'), VAULT)).toBeNull()
  })
})

describe('a listing', () => {
  it('carries the parent and only the entries inside the vault', () => {
    const folder = toFolder(
      'notes',
      [
        entry('/home/user/vault/notes/deep', 'deep', true),
        entry('/home/user/vault/notes/a.md', 'a.md'),
        entry('/somewhere/else/b.md', 'b.md'),
      ],
      VAULT,
    )
    expect(folder.directory).toBe('notes')
    expect(folder.parent).toBe('')
    expect(folder.entries.map((row) => row.path)).toEqual(['notes/deep', 'notes/a.md'])
  })
})

describe('what a chosen row becomes', () => {
  it('is the path for a file', () => {
    expect(referenceText({ path: 'notes/a.md', name: 'a.md', isDirectory: false })).toBe('notes/a.md')
  })

  it('is nothing for a folder: selecting one walks into it', () => {
    expect(referenceText({ path: 'notes', name: 'notes', isDirectory: true })).toBeNull()
  })
})

describe('putting a reference into the message', () => {
  it('inserts at the caret and separates the path from the words around it', () => {
    expect(insertReferenceText('read this now', 5, 'notes/a.md')).toEqual({
      text: 'read notes/a.md this now',
      caret: 16,
    })
  })

  it('adds no second space where the neighbour is already one', () => {
    // Typed after the space that was already there, so only the trailing one is added.
    expect(insertReferenceText('read ', 5, 'notes/a.md')).toEqual({
      text: 'read notes/a.md ',
      caret: 16,
    })
    // Between two spaces: the path takes the place of neither, and nothing doubles.
    expect(insertReferenceText('read  please', 5, 'notes/a.md')).toEqual({
      text: 'read notes/a.md please',
      caret: 15,
    })
  })

  it('appends a trailing space at the end of the message, so the next word is a word', () => {
    // `selectionStart` is null on a field nobody has clicked into, and a caller that passed it
    // through would splice at 0 — in front of the sentence the reader had already typed.
    expect(insertReferenceText('summarise this', 14, 'notes/a.md')).toEqual({
      text: 'summarise this notes/a.md ',
      caret: 26,
    })
  })

  it('clamps a caret past the end instead of losing the tail of the message', () => {
    expect(insertReferenceText('read', 99, 'notes/a.md')).toEqual({
      text: 'read notes/a.md ',
      caret: 16,
    })
  })
})
