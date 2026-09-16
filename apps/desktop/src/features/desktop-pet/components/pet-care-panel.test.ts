/**
 * The care panel: what it draws from a settled ledger, and what it refuses to draw.
 *
 * The failure this surface is tested against is not a missing feature — it is a page that shows
 * something anyway. §8's 「token 未知不是 0」 and §5.2's 「不能显示可点击但无效果的控件」 are two halves of
 * one rule: a number nobody computed and a control that does nothing both leave the user believing
 * something happened. So the tests below are mostly about absences, and each absence is asserted as a
 * statement that is *there* rather than as silence: no ledger means the sentence that says so and not
 * a zero, one day of unknown usage means the word and not a digit next to the day that reported zero.
 *
 * The last group is §3.4's rule for an unverified capability, applied to a care page: there is no
 * sign-in, no sync and no leaderboard control on it — not a disabled one, not a coming-soon one — and
 * the test asserts there is no control at all, so adding one is a decision rather than a drift.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import {
  PET_CARE_PANEL_LABELS,
  petCareDayKey,
  type PetCareImportResult,
  type PetCarePanelLabels,
  type PetCareProgress,
} from '../services/pet-care-rules'
import PetCarePanel from './PetCarePanel.vue'

const mounted: VueApp[] = []

/** 2026-09-16 12:00 local, so "today" is a fact the test chose rather than one it read. */
const NOW = new Date(2026, 8, 16, 12, 0, 0, 0).getTime()

const PROGRESS: Partial<PetCareProgress> = {
  xp: 2160, // level 5 shown: the curve reaches internal level 6 at 60·6·5 = 1800, and 2160 is half way on
  meals: 3,
  streakDays: 2,
  days: [
    { day: '2026-09-15', completions: 2, tokens: null },
    { day: '2026-09-16', completions: 1, tokens: 4200 },
  ],
  reportedTokens: 4200,
  unreportedRuns: 2,
  lastSettledAt: NOW - 3_600_000,
}

interface Options {
  progress?: Partial<PetCareProgress> | null
  readOnly?: boolean
  preview?: boolean
  importResult?: PetCareImportResult | null
  now?: number
  labels?: Partial<PetCarePanelLabels>
}

async function mount(options: Options = {}): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(PetCarePanel, {
    progress: options.progress === undefined ? PROGRESS : options.progress,
    readOnly: options.readOnly ?? false,
    preview: options.preview ?? false,
    importResult: options.importResult ?? null,
    now: options.now ?? NOW,
    labels: options.labels ?? {},
  })
  app.mount(host)
  mounted.push(app)
  await nextTick()
  return host
}

function query(host: HTMLElement, test: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-test="${test}"]`)
}

function text(host: HTMLElement, test: string): string {
  return query(host, test)?.textContent?.trim() ?? ''
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
})

describe('a build with no ledger', () => {
  it('draws no numbers at all, and says why', async () => {
    const host = await mount({ progress: null })

    expect(text(host, 'pet-care-absent')).toBe(PET_CARE_PANEL_LABELS.absent)
    // No level, no bar, no badges, no days — and, the assertion that actually catches a zero drawn
    // "helpfully", no digit anywhere in the surface. A level 0 and a 0 XP bar are exactly the
    // invented numbers §8 rules out.
    for (const test of ['pet-care-level', 'pet-care-progress', 'pet-care-badge', 'pet-care-day']) {
      expect(query(host, test)).toBeNull()
    }
    expect(host.textContent).not.toMatch(/[0-9]/)
  })

  it('still says what it does not offer, rather than leaving a blank surface', async () => {
    const host = await mount({ progress: null })
    expect(text(host, 'pet-care-online')).toBe(PET_CARE_PANEL_LABELS.online)
  })

  it('keeps a record from a newer build and says it was not written over', async () => {
    const host = await mount({ readOnly: true })

    expect(text(host, 'pet-care-read-only')).toBe(PET_CARE_PANEL_LABELS.readOnly)
    // Shown, not blanked: §10.2's read-only arm means the user's progress is still theirs to look at.
    expect(text(host, 'pet-care-level')).toContain('5')
  })
})

describe('what a settled ledger looks like', () => {
  it('draws the level, the stage and the run of days from the totals', async () => {
    const host = await mount()

    expect(text(host, 'pet-care-level')).toBe('Level 5')
    expect(text(host, 'pet-care-stage')).toBe(PET_CARE_PANEL_LABELS.stages.companion)
    expect(text(host, 'pet-care-streak')).toBe('2 days running')
    expect(text(host, 'pet-care-meals')).toBe('3 completed')
  })

  it('marks today by the caller’s own local calendar', async () => {
    const host = await mount()
    const rows = [...host.querySelectorAll<HTMLElement>('[data-test="pet-care-day"]')]

    expect(rows.map((row) => row.dataset.day)).toEqual(['2026-09-15', '2026-09-16'])
    expect(petCareDayKey(new Date(NOW))).toBe('2026-09-16')
    expect(rows[0]?.textContent).toBe('2026-09-15: 2 done, usage unknown')
    expect(rows[1]?.textContent).toBe('2026-09-16 (today): 1 done, 4200')
  })

  it('shows every badge it knows, earned or not, so a locked one is visible as locked', async () => {
    const host = await mount()
    const badges = [...host.querySelectorAll<HTMLElement>('[data-test="pet-care-badge"]')]

    expect(badges).toHaveLength(14)
    const earned = badges.filter((badge) => badge.dataset.earned === 'yes')
    // 3 completions and a level-5 total earn 'firstMeal' and 'level5'; nothing else qualifies.
    expect(earned.map((badge) => badge.dataset.badge)).toEqual(['firstMeal', 'level5'])
    const locked = badges.filter((badge) => badge.dataset.earned === 'no')
    expect(locked.map((badge) => badge.dataset.badge)).toContain('nightOwl')
    expect(text(host, 'pet-care-achievements')).toBe('2 of 14 earned')
  })

  it('shows a badge the ledger recorded and a badge it cannot name', async () => {
    // `nightOwl` is recorded by settlement, not derived from a total; `streak365` is a badge from a
    // newer build. One has a name here and the other is shown as the id it arrived as.
    const host = await mount({
      progress: { ...PROGRESS, unlocked: ['nightOwl', 'streak365'] },
    })
    const badges = [...host.querySelectorAll<HTMLElement>('[data-test="pet-care-badge"]')]

    expect(badges).toHaveLength(15)
    const owl = badges.find((badge) => badge.dataset.badge === 'nightOwl')
    expect(owl?.dataset.earned).toBe('yes')
    expect(owl?.textContent).toContain('Night Owl')
    expect(badges.at(-1)?.dataset.badge).toBe('streak365')
    expect(badges.at(-1)?.textContent).toContain('streak365')
  })

  it('names the level bar for a screen reader rather than leaving it a colour', async () => {
    const host = await mount()
    const bar = query(host, 'pet-care-progress')

    expect(bar?.getAttribute('role')).toBe('progressbar')
    expect(bar?.getAttribute('aria-valuenow')).toBe('50')
    expect(bar?.getAttribute('aria-label')).toBe('Level 5, 50 percent of the way to the next')
  })
})

describe('usage nobody reported', () => {
  it('says unknown for one day and a digit for another, and never swops them', async () => {
    const host = await mount()
    const rows = [...host.querySelectorAll<HTMLElement>('[data-test="pet-care-day"]')]

    // The 15th: two runs finished and nobody reported usage. The 16th: one run, and a reported total.
    expect(rows[0]?.textContent).toContain(PET_CARE_PANEL_LABELS.dayUnknown)
    expect(rows[0]?.textContent).not.toContain('0 done, 0')
    expect(rows[1]?.textContent).toContain('4200')
  })

  it('reports a known total, and adds how many runs reported none', async () => {
    const host = await mount()
    expect(text(host, 'pet-care-usage')).toBe('4200 reported')
    expect(text(host, 'pet-care-usage-partial')).toBe('2 finished runs reported no usage.')
  })

  it('says nothing has ever reported, rather than showing a zero', async () => {
    const host = await mount({
      progress: { ...PROGRESS, reportedTokens: null, unreportedRuns: 4 },
    })

    expect(text(host, 'pet-care-usage')).toBe(PET_CARE_PANEL_LABELS.usageUnknown)
    // With no known total there is no partial sum to annotate, so the second line is not drawn.
    expect(query(host, 'pet-care-usage-partial')).toBeNull()
  })
})

describe('what an import did', () => {
  it('reports both halves of a merge, in words, so the kept half is visible too', async () => {
    const host = await mount({
      importResult: {
        status: 'merged',
        report: { raised: ['meals', 'streak'], kept: ['xp', 'days'], badgesAdded: 1 },
      },
    })
    const line = text(host, 'pet-care-import')

    expect(line).toContain('completed runs, the streak')
    expect(line).toContain('total XP, recent days')
    // The wording says progress was kept, not that it was found and corrected — an import that
    // "normalised" the user's own progress is the unrecoverable half of the clause.
    expect(line).toContain('Kept as they were')
    expect(line.toLowerCase()).not.toContain('reset')
  })

  it('says a conflicted import wrote nothing', async () => {
    const host = await mount({ importResult: { status: 'conflict', currentRevision: 7 } })
    expect(text(host, 'pet-care-import')).toContain(PET_CARE_PANEL_LABELS.importConflict)
  })

  it('passes on the ledger’s own sentence when it refused the file', async () => {
    const host = await mount({
      importResult: { status: 'refused', detail: 'this progress came from a newer version' },
    })
    const line = text(host, 'pet-care-import')

    expect(line).toContain('this progress came from a newer version')
    expect(line).toContain('Nothing was changed')
  })

  it('says nothing about an import when there has not been one', async () => {
    const host = await mount()
    expect(query(host, 'pet-care-import')).toBeNull()
  })
})

describe('preview', () => {
  it('marks a sample as a sample', async () => {
    const host = await mount({ preview: true })
    expect(text(host, 'pet-care-preview')).toBe(PET_CARE_PANEL_LABELS.preview)
  })

  it('does not touch what it was handed', async () => {
    // §11's 「预览数据隔离」: a preview's totals are a drawing. The surface has no writer and no
    // gateway, so the only way it could reach real progress is by mutating the object it was given —
    // which is what this compares.
    const progress = { ...PROGRESS, days: [...(PROGRESS.days ?? [])] }
    const before = JSON.stringify(progress)
    await mount({ progress, preview: true })

    expect(JSON.stringify(progress)).toBe(before)
  })
})

describe('what the surface may not offer', () => {
  it('has no control on it at all, and says what it does not offer', async () => {
    // §5.2 keeps signing in, syncing and the leaderboard on the Advanced page and off by default;
    // §3.4 forbids offering an unverified capability as if it were there. A disabled button is still
    // an offer, so the assertion is that there is no control — not that the controls are off.
    const host = await mount({ progress: null })

    for (const selector of ['button', 'a', 'input', 'select', 'textarea']) {
      expect(host.querySelectorAll(selector), `${selector} on the care surface`).toHaveLength(0)
    }
    expect(text(host, 'pet-care-online')).toContain('not part of this build')
  })
})

describe('the wording is the caller’s', () => {
  it('takes a label set from the prop, which is where the i18n namespace will plug in', async () => {
    const host = await mount({
      labels: {
        panel: '养成与统计',
        level: '等级 {level}',
        streak: '连续 {days} 天',
        day: '{day}：完成 {count} 次，用量 {tokens}',
        dayToday: '{day}（今天）：完成 {count} 次，用量 {tokens}',
        dayUnknown: '用量未知',
      },
    })

    expect(query(host, 'pet-care-panel')?.getAttribute('aria-label')).toBe('养成与统计')
    expect(text(host, 'pet-care-level')).toBe('等级 5')
    expect(text(host, 'pet-care-streak')).toBe('连续 2 天')
    const rows = [...host.querySelectorAll<HTMLElement>('[data-test="pet-care-day"]')]
    expect(rows[0]?.textContent).toBe('2026-09-15：完成 2 次，用量 用量未知')
  })
})
