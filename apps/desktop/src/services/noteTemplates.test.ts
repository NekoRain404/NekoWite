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
  DEFAULT_TEMPLATES,
  buildDailyVars,
  dailyNoteFileName,
  dailyNotePath,
  ensureDailyNote,
  listTemplates,
  nextAvailableName,
  nextUntitledName,
  readTemplate,
  renderTemplate,
  templateFileBase,
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
    it('returns the ten built-in templates when the vault has no templates', async () => {
      const out = await listTemplates('/vault')
      expect(out).toEqual(DEFAULT_TEMPLATES)
      expect(out.map((entry) => entry.name)).toEqual([
        '每日日记',
        '每周复盘',
        '会议记录',
        '学习笔记',
        '读书笔记',
        '实验记录',
        '文献阅读',
        '研究计划',
        '测试用例',
        '决策记录',
      ])
    })

    it('lists user markdown templates after the built-ins and strips the extension', async () => {
      listMock.mockResolvedValue([
        { name: 'custom.md', path: 'templates/custom.md', is_dir: false, is_mdx: true },
        { name: 'daily.md', path: 'templates/daily.md', is_dir: false, is_mdx: true },
        { name: 'note.txt', path: 'templates/note.txt', is_dir: false, is_mdx: false },
        { name: 'sub', path: 'templates/sub', is_dir: true, is_mdx: false },
        { name: 'meeting.MD', path: 'templates/meeting.MD', is_dir: false, is_mdx: true },
      ])
      const out = await listTemplates('/vault')
      expect(listMock).toHaveBeenCalledWith('/vault', 'templates')
      expect(out).toEqual([
        ...DEFAULT_TEMPLATES,
        { name: 'custom', path: 'templates/custom.md' },
        { name: 'daily', path: 'templates/daily.md' },
        { name: 'meeting', path: 'templates/meeting.MD' },
      ])
    })

    it('keeps built-in templates when the templates directory cannot be listed', async () => {
      listMock.mockRejectedValue(new Error('boom'))
      await expect(listTemplates('/vault')).resolves.toEqual(DEFAULT_TEMPLATES)
    })

    it('lets a user template override the built-in template with the same name', async () => {
      listMock.mockResolvedValue([
        { name: '每日日记.md', path: 'templates/每日日记.md', is_dir: false, is_mdx: true },
      ])
      const out = await listTemplates('/vault')
      expect(out).toHaveLength(DEFAULT_TEMPLATES.length)
      expect(out[0]).toEqual({ name: '每日日记', path: 'templates/每日日记.md' })
    })
  })

  describe('templateFileBase', () => {
    it('uses the built-in slug so output filenames stay ASCII', () => {
      const daily = DEFAULT_TEMPLATES.find((entry) => entry.name === '每日日记')
      if (!daily) throw new Error('built-in daily template missing')
      expect(templateFileBase(daily)).toBe('daily')
    })

    it('uses the display name for user templates without a slug', () => {
      expect(templateFileBase({ name: '我的模板', path: 'templates/我的模板.md' })).toBe('我的模板')
    })
  })

  describe('readTemplate', () => {
    it('returns the built-in body without touching the vault', async () => {
      const entry = DEFAULT_TEMPLATES.find((item) => item.name === '每日日记')
      if (!entry) throw new Error('built-in daily template missing')
      const body = await readTemplate('/vault', entry)
      expect(body).toContain('# {{title}}')
      expect(readMock).not.toHaveBeenCalled()
    })

    it('reads a user template from the vault templates directory', async () => {
      readMock.mockResolvedValue('user body')
      const body = await readTemplate('/vault', { name: 'custom', path: 'templates/custom.md' })
      expect(body).toBe('user body')
      expect(readMock).toHaveBeenCalledWith('/vault', 'templates/custom.md')
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
