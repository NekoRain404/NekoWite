import { beforeEach, describe, expect, it, vi } from 'vitest'

const listMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const createDirMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    list: listMock,
    stat: statMock,
    write: writeMock,
    createDir: createDirMock,
    read: readMock,
  },
}))

import {
  DEFAULT_DAILY_TEMPLATE,
  buildDailyVars,
  dailyNoteFileName,
  dailyNotePath,
  ensureDailyNote,
  listTemplates,
  nextAvailableName,
  nextUntitledName,
  renderTemplate,
} from './noteTemplates'

describe('noteTemplates', () => {
  beforeEach(() => {
    listMock.mockReset()
    statMock.mockReset()
    writeMock.mockReset()
    createDirMock.mockReset()
    readMock.mockReset()
    createDirMock.mockResolvedValue('daily')
    listMock.mockResolvedValue([])
    statMock.mockRejectedValue(new Error('missing'))
    writeMock.mockResolvedValue(undefined)
    readMock.mockResolvedValue('')
  })

  describe('dailyNoteFileName', () => {
    it('formats the filename as YYYY-MM-DD.md', () => {
      expect(dailyNoteFileName(new Date(2026, 0, 5))).toBe('2026-01-05.md')
      expect(dailyNoteFileName(new Date(2026, 11, 31))).toBe('2026-12-31.md')
      expect(dailyNoteFileName(new Date(2026, 2, 9))).toBe('2026-03-09.md')
    })
  })

  describe('dailyNotePath', () => {
    it('builds the path under a daily/ directory', () => {
      expect(dailyNotePath('/vault', new Date(2026, 0, 5))).toBe('/vault/daily/2026-01-05.md')
    })

    it('normalizes a trailing slash in the vault path', () => {
      expect(dailyNotePath('/vault/', new Date(2026, 0, 5))).toBe('/vault/daily/2026-01-05.md')
    })
  })

  describe('buildDailyVars', () => {
    it('zero-pads date and time and fills title and weekday', () => {
      const vars = buildDailyVars(new Date(2026, 0, 5, 9, 7))
      expect(vars.date).toBe('2026-01-05')
      expect(vars.time).toBe('09:07')
      expect(vars.title).toBe('Daily 2026-01-05')
      expect(vars.weekday).toBe('Monday')
    })

    it('applies overrides on top of computed values', () => {
      const vars = buildDailyVars(new Date(2026, 0, 5, 9, 7), { title: 'Custom', weekday: 'Friday' })
      expect(vars.title).toBe('Custom')
      expect(vars.weekday).toBe('Friday')
      expect(vars.date).toBe('2026-01-05')
      expect(vars.time).toBe('09:07')
    })
  })

  describe('renderTemplate', () => {
    it('replaces every known variable', () => {
      const out = renderTemplate('{{date}} {{time}} {{title}} {{weekday}}', {
        date: '2026-01-05',
        time: '09:07',
        title: 'Daily 2026-01-05',
        weekday: 'Monday',
      })
      expect(out).toBe('2026-01-05 09:07 Daily 2026-01-05 Monday')
    })

    it('allows surrounding whitespace inside the braces', () => {
      expect(renderTemplate('{{  date  }}', { date: '2026-01-05' })).toBe('2026-01-05')
    })

    it('leaves unknown placeholders untouched', () => {
      expect(renderTemplate('{{date}} {{unknown}}', { date: '2026-01-05' })).toBe('2026-01-05 {{unknown}}')
    })

    it('leaves known placeholders untouched when the variable is missing', () => {
      expect(renderTemplate('{{date}}', {})).toBe('{{date}}')
    })

    it('returns content unchanged when there are no placeholders', () => {
      expect(renderTemplate('hello world', { date: 'x' })).toBe('hello world')
    })

    it('does not treat $ patterns in variable values as replacement patterns', () => {
      expect(renderTemplate('{{date}}', { date: '$&$1`' })).toBe('$&$1`')
    })

    it('does not match a single brace', () => {
      expect(renderTemplate('{date}', { date: '2026-01-05' })).toBe('{date}')
    })
  })

  describe('nextUntitledName', () => {
    it('returns untitled.md when it is free', () => {
      expect(nextUntitledName([])).toBe('untitled.md')
      expect(nextUntitledName(['a.md'])).toBe('untitled.md')
    })

    it('increments until a free name is found', () => {
      expect(nextUntitledName(['untitled.md'])).toBe('untitled-1.md')
      expect(nextUntitledName(['untitled.md', 'untitled-1.md'])).toBe('untitled-2.md')
    })
  })

  describe('nextAvailableName', () => {
    it('uses the given base name', () => {
      expect(nextAvailableName('todo', [])).toBe('todo.md')
      expect(nextAvailableName('todo', ['todo.md'])).toBe('todo-1.md')
      expect(nextAvailableName('todo', ['todo.md', 'todo-1.md'])).toBe('todo-2.md')
    })
  })

  describe('listTemplates', () => {
    it('lists markdown templates, strips the extension and sorts them', async () => {
      listMock.mockResolvedValue([
        { name: 'daily.md', path: 'templates/daily.md', is_dir: false, is_mdx: true },
        { name: 'note.txt', path: 'templates/note.txt', is_dir: false, is_mdx: false },
        { name: 'sub', path: 'templates/sub', is_dir: true, is_mdx: false },
        { name: 'meeting.MD', path: 'templates/meeting.MD', is_dir: false, is_mdx: true },
      ])
      const out = await listTemplates('/vault')
      expect(listMock).toHaveBeenCalledWith('/vault', 'templates')
      expect(out).toEqual([
        { name: 'daily', path: 'templates/daily.md' },
        { name: 'meeting', path: 'templates/meeting.MD' },
      ])
    })

    it('returns an empty list when the templates directory cannot be listed', async () => {
      listMock.mockRejectedValue(new Error('boom'))
      await expect(listTemplates('/vault')).resolves.toEqual([])
    })
  })

  describe('ensureDailyNote', () => {
    it('returns created=false without writing when the note already exists', async () => {
      statMock.mockResolvedValue({ size: 10, mtime: 1 })
      const res = await ensureDailyNote('/vault', new Date(2026, 0, 5))
      expect(res.created).toBe(false)
      expect(res.path).toBe('/vault/daily/2026-01-05.md')
      expect(writeMock).not.toHaveBeenCalled()
      expect(createDirMock).not.toHaveBeenCalled()
    })

    it('creates the note on first use and renders the default template', async () => {
      const res = await ensureDailyNote('/vault', new Date(2026, 0, 5))
      expect(res.created).toBe(true)
      expect(res.path).toBe('/vault/daily/2026-01-05.md')
      expect(createDirMock).toHaveBeenCalledWith('/vault', 'daily')
      expect(writeMock).toHaveBeenCalledTimes(1)
      const [vault, path, content] = writeMock.mock.calls[0] as [string, string, string]
      expect(vault).toBe('/vault')
      expect(path).toBe('/vault/daily/2026-01-05.md')
      expect(content).toContain('2026-01-05')
      expect(content).toBe(DEFAULT_DAILY_TEMPLATE.replaceAll('{{date}}', '2026-01-05'))
    })
  })
})
