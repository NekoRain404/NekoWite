<script setup lang="ts">
/**
 * The live preview: what the pet looks like with the settings as they are being edited.
 *
 * §5.1 puts it in the settings content area rather than in a window of its own (「预览放当前设置
 * 内容区，不套新的完整应用窗口」), and §5.3 makes it the other half of the same rule: 「试调外观即时
 * 预览，提交持久化成功后确认」 — the stage follows the *draft*, and the draft is the session's,
 * so a slider moves the pet before anything is written and the saved state is never what the
 * preview was showing.
 *
 * **Nothing here delivers anything.** There is no call in this file that could raise a system
 * notification or play a sound, and there cannot be one: the gateway it reads through
 * (`PetGateway`) has no delivery method at all, because §6.3 gives delivery to one backend
 * ledger and makes every window a pure display. A preview that could notify would be a second
 * authority on whether the user was told — so the test beside this file asserts that the only
 * thing the stage ever asks the host for is a settings read.
 *
 * **Motion is never turned up.** §5.2's rule is that the pet may reduce further than the system
 * asks for and never less, so `reduced` is true when the stored setting says so *or* when the
 * system's `prefers-reduced-motion` does. There is no branch that re-enables it.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../../../i18n'
import { useAppearanceStore } from '../../../stores/appearance'
import { PetBubble } from '../../desktop-pet'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

const props = defineProps<{
  /** The container's sessions, so the stage reads the drafts the pages are editing. */
  context: PetSettingsContext
}>()

const { general, character, view, message } = props.context.sessions

const generalValues = computed(() => general.values.value)
const characterValues = computed(() => character.values.value)
const messageValues = computed(() => message.values.value)

/**
 * Whether every domain the stage draws from has answered. A session that was never loaded sits
 * at `loading`, so this is also what keeps the stage from drawing this build's defaults as if
 * they were the user's settings.
 */
const ready = computed(() =>
  [general, character, view, message].every((session) => session.status.value !== 'loading'),
)

const enabled = computed(() => generalValues.value.enabled)
const size = computed(() => characterValues.value.size)
const noCharacter = computed(() => characterValues.value.characterId === null)
const seconds = computed(() => messageValues.value.bubbleSeconds)

/**
 * The bubble the stage draws **is the desktop's bubble** — the same component the pet window mounts,
 * handed the draft's own two numbers.
 *
 * It used to be a `<p>` of this file's own, and that is the whole of why this page could not be
 * trusted about the bubble's appearance. Two rounds were spent on the halves of it: the colour first
 * (a light/dark pair of literals that is the app's palette nowhere), then the size (`font-size: 11px`
 * against `message.fontSize`, the setting on this very page), and each fix was a `.pet-preview__bubble`
 * declaration made to agree with `PetBubble.vue`'s by hand. What the third round found is that the
 * *box* had never agreed at all — `padding: 5px 8px`, `line-height: 1.4`, `var(--app-radius-lg)` and
 * no shadow or family against the desktop's `6px 8px`, `1.5`, `var(--app-radius)`,
 * `var(--app-shadow-card)` and `var(--app-font)` — and the reason it kept happening is that there
 * were two declarations to keep in step.
 *
 * There is one now. The alpha and the size travel as props instead of as custom properties this file
 * binds (`PetBubble.vue`'s `surfaceStyle` writes both onto its own element from the same props the
 * pet window passes), so every number and every box rule is `PetBubble.vue`'s and a change there
 * reaches the preview in the same commit or not at all.
 */
const bubbleValues = computed(() => ({
  opacity: messageValues.value.opacity,
  fontSize: messageValues.value.fontSize,
}))

/** The largest figure this panel can draw, in CSS pixels. */
const STAGE_MAX_PX = 132

/**
 * The figure at the character's size, scaled down when the panel is smaller than the setting.
 *
 * The scale is not cosmetic: `character.size` reaches 320px and this column is 176px, so
 * drawing it at 320 would either overflow the dialog or silently draw a different number than
 * the setting says. It is scaled and the caption says by how much, which is the honest version
 * of the same compromise §5.2 makes everywhere else.
 */
const scale = computed(() => Math.min(1, STAGE_MAX_PX / Math.max(1, size.value)))
const scaledPercent = computed(() => (scale.value < 1 ? Math.round(scale.value * 100) : null))
const figureStyle = computed(() => ({
  width: `${Math.round(size.value * scale.value)}px`,
  height: `${Math.round(size.value * scale.value)}px`,
}))

/**
 * The four axes the *pet window* draws with, put on the stage — which is what makes this preview
 * show the bubble the desktop will show rather than a table of its own.
 *
 * The stage is an element **inside** the app's page, and that is the whole difficulty: the app's own
 * root already carries an appearance (its theme, scheme, accent and contrast), and the bubble may
 * have been pinned to the other palette (§5.2's 「保留明确的局部外观覆盖」). So the stage names all
 * four axes itself, exactly as the pet window's root does (`usePetPageAppearance` writes the same
 * four there), and `palettes.css` — whose light half answers to `[data-theme="light"]` as well as
 * `:root` — resolves them to the same numbers on both. Nothing here is a colour: this component used
 * to write `#f7f7f5` / `#23211f` for exactly this override, which is a preview that lies about the
 * one thing the user is looking at it to decide.
 *
 * `system` resolves to the app's own effective theme, which is what the pet window resolves it to as
 * well: the pet window follows the *app* (the host publishes the setting, `pet-bubble-theme.ts` puts
 * the two together), so the two pages agree on every member of the control.
 */
const appearance = useAppearanceStore()
const previewTheme = computed<string>(() => {
  const theme = messageValues.value.theme
  if (theme === 'light' || theme === 'dark') return theme
  return appearance.effectiveTheme()
})
const stageAppearance = computed(() => ({
  'data-theme': previewTheme.value,
  'data-color-scheme': appearance.colorScheme,
  'data-accent': appearance.effectiveAccent(),
  'data-contrast': appearance.highContrast ? 'high' : 'normal',
}))


/**
 * Whether the system asked for less motion. Read once — a preference change mid-session is not
 * something the app re-reads anywhere else either, and re-reading it per frame would be the
 * layout-thrashing §7.3 rules out.
 */
const systemReduced = ref(false)
onMounted(() => {
  systemReduced.value =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
})

const reduced = computed(() => generalValues.value.motion === 'reduced' || systemReduced.value)

/**
 * §10.2: a store from a newer build is not drawn as a pet at all, for the same reason the pages
 * drop their controls — a refused read answers with *this build's* defaults, and a stage that
 * showed them would be showing a pet the user did not configure.
 */
const readOnly = computed(() =>
  [general, character, view, message].some((session) => session.status.value === 'read-only'),
)

/**
 * The bubble, shown on request and taken away by §6.3's own life for it — the draft's
 * `bubbleSeconds`, not a number this component picked. It is the one part of the preview that
 * has to be asked for: a bubble that appeared on its own would be the *sound and popup* half of
 * a reminder, which this page must not imitate.
 */
const bubbleOpen = ref(false)
let bubbleTimer: ReturnType<typeof setTimeout> | null = null

function showBubble(): void {
  bubbleOpen.value = true
  if (bubbleTimer !== null) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    bubbleOpen.value = false
    bubbleTimer = null
  }, seconds.value * 1000)
}

onBeforeUnmount(() => {
  if (bubbleTimer !== null) clearTimeout(bubbleTimer)
  bubbleTimer = null
})
</script>

<template>
  <div class="pet-preview">
    <span class="settings-label">{{ t('settings.pet.preview.title') }}</span>
    <p
      v-if="readOnly"
      class="settings-note"
    >
      {{ t('settings.pet.readOnly') }}
    </p>
    <p
      v-else-if="!ready"
      class="settings-note"
    >
      {{ t('settings.pet.preview.loading') }}
    </p>
    <template v-else>
      <div
        class="pet-preview__stage"
        v-bind="stageAppearance"
      >
        <p
          v-if="!enabled"
          class="pet-preview__notice"
        >
          {{ t('settings.pet.preview.off') }}
        </p>
        <template v-else>
          <Transition name="pet-bubble">
            <PetBubble
              v-if="bubbleOpen"
              class="pet-preview__bubble"
              :line="t('settings.pet.preview.bubbleText')"
              :bubble-opacity="bubbleValues.opacity"
              :font-size="bubbleValues.fontSize"
            />
          </Transition>
          <div
            class="pet-preview__figure"
            :class="{ 'is-static': reduced }"
            :style="figureStyle"
            :data-reduced="reduced ? 'true' : 'false'"
          />
        </template>
      </div>
      <button
        v-if="enabled"
        class="btn btn-secondary btn-sm pet-preview__ask"
        type="button"
        @click="showBubble"
      >
        {{ t('settings.pet.preview.bubble') }}
      </button>
      <span class="settings-note">{{ t('settings.pet.preview.caption', { size, seconds }) }}</span>
      <span
        v-if="scaledPercent !== null"
        class="settings-note"
      >{{ t('settings.pet.preview.scaled', { pct: scaledPercent }) }}</span>
      <span
        v-if="noCharacter"
        class="settings-note"
      >{{ t('settings.pet.preview.noCharacter') }}</span>
      <span
        v-if="reduced"
        class="settings-note"
      >{{ t('settings.pet.preview.reduced') }}</span>
    </template>
  </div>
</template>

<style scoped>
.pet-preview { display: flex; flex-direction: column; gap: 6px; }
.settings-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }

.pet-preview__stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-height: 168px;
  padding: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-canvas) 60%, var(--app-panel));
}
.pet-preview__notice {
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}
.pet-preview__figure {
  flex: none;
  border-radius: 42% 42% 34% 34%;
  background: color-mix(in srgb, var(--app-accent) 42%, var(--app-elevated));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 30%, transparent);
  animation: pet-bob var(--app-motion-slow) var(--app-ease) infinite alternate;
}
/* §7.3: a reduced-motion user keeps the static state and loses the movement, and this is the
   only animation the preview has to lose. */
.pet-preview__figure.is-static { animation: none; }

/* `.pet-preview__bubble` is the class this component *adds* to the surface `PetBubble` renders —
   Vue merges a parent's class onto a child component's root — so the settings suites and the e2e
   specs have a name for "the bubble in the stage" that is not the desktop's own. **No declaration
   belongs here.** The box, the colour, the family and the size are `PetBubble.vue`'s; the palette
   they resolve against is the *stage's* four axes above, and the transition below is the stage's own
   because §6.3's reminder is the one thing the preview does that the window does not.
   What the two rounds before this one left here was `padding`, `border-radius`, `box-shadow`,
   `line-height`, `max-width`, `background`, `color` and `font-size` — a second bubble built out of
   the first one's parts, which is what a preview must never be. */

.pet-preview__ask { align-self: flex-start; }

.pet-bubble-enter-active { transition: opacity var(--app-motion-fade) var(--app-ease); }
.pet-bubble-leave-active { transition: opacity var(--app-motion-exit) var(--app-ease-exit); }
.pet-bubble-enter-from,
.pet-bubble-leave-to { opacity: 0; }

@keyframes pet-bob {
  from { translate: 0 0; }
  to { translate: 0 -4px; }
}
</style>
