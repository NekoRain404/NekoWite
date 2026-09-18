<script lang="ts">
/**
 * The desktop pet's settings container: §5.1's sub-navigation, and the one place a settings
 * session is created.
 *
 * A section of `SettingsPanel`, not a second settings window (§5.1: 「这是同一个设置容器内的
 * 子导航，不再开独立设置程序」). `page` is the sub-page a caller may open it on, so the pet's
 * right-click can land on a named page without this component knowing how it was opened.
 *
 * **Ownership.** `general` and `notification` are this task's pages and are rendered directly.
 * The other five are slot content — their components belong to other tasks, and a container that
 * imported them could not be written until they were. A page with no component behind it is *not
 * offered at all*: §5.2 forbids a control that leads nowhere, so a row for a page that would
 * render nothing is a row that must not exist, and the note under the rail says which pages have
 * not landed rather than leaving them out silently.
 *
 * **One session per domain, created here.** A page does not make its own: two sessions on one
 * domain are two revisions, and the second write comes back as a conflict against the first
 * (§5.3, and `use-pet-settings.ts` documents the same rule from its side). It also is what makes
 * the preview live — it reads the *draft* the page is editing, through the same object, so a
 * slider moves the stage before anything is written.
 *
 * **How a page is handed its context.** As a `context` prop, from the scoped slot the container
 * renders for it. Injection was the alternative and is deliberately not used: the built-in pages
 * take the same prop, so there is one way for a page to reach its session and not two, and no
 * page has to import this file to get one.
 */
import type { ShallowRef } from 'vue'
import type {
  PetCapabilityReport,
  PetGateway,
  PetSettingsDomain,
  PetSettingsPage,
} from '../../../platform/gateways/pet-contracts'
import type { PetSettingsSession } from '../composables/use-pet-settings'

/** One session per domain, under the domain it is a session of. */
export interface PetSettingsSessions {
  general: PetSettingsSession<'general'>
  character: PetSettingsSession<'character'>
  view: PetSettingsSession<'view'>
  message: PetSettingsSession<'message'>
  notification: PetSettingsSession<'notification'>
  care: PetSettingsSession<'care'>
  project: PetSettingsSession<'project'>
}

/**
 * What every page under this container is handed, and the whole of what it may reach.
 *
 * There is no method here that writes, deletes or hides anything: §4's rollback is the
 * `general.enabled` switch, and the surface a page is given must not be able to do what the
 * rollback is defined as *not* doing — deleting a character, care progress or history.
 */
export interface PetSettingsContext {
  /** The host connection: the only thing that reads or writes a domain. */
  readonly gateway: PetGateway
  readonly sessions: PetSettingsSessions
  /**
   * §7.2's report, read once for the whole container. Empty until the host answers, which a
   * page reads as "nothing was reported" — the conservative direction, and the same reading
   * `gateRoamMode` gives an absent finding in D11a.
   */
  readonly capabilities: ShallowRef<PetCapabilityReport[]>
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, useSlots, watch } from 'vue'
import { Bell, FolderKanban, Heart, MessageSquare, PawPrint, SlidersHorizontal, Wrench } from 'lucide-vue-next'
import { PET_SETTINGS_PAGES } from '../../../platform/gateways/pet-contracts'
import { t } from '../../../i18n'
// The settings dialog's own rule, taken from where it lives rather than restated: this rail swaps
// the page inside that dialog's one scroll container, which is the same act the dialog's rail and
// the agents tree's rail perform. `content-scroll.ts` finds the box from the content being swapped
// into it, so neither feature has to spell the other's class.
import { resetContentScroll } from '../../settings/composables/content-scroll'
import { usePetSettings } from '../composables/use-pet-settings'
import PetGeneralSettings from './PetGeneralSettings.vue'
import PetNotificationSettings from './PetNotificationSettings.vue'
import PetSettingsPreview from './PetSettingsPreview.vue'

const props = withDefaults(
  defineProps<{
    /**
     * The host connection. Absent means unwired rather than broken, and the container says
     * which: `desktop-pet-composition.ts` supplies it (§10.1, the integrator's), and a page
     * that rendered defaults as if they were the user's settings would be worse than a page
     * that says it has nothing to read.
     */
    gateway?: PetGateway | null
    /** The sub-page to open on. §5.1: the pet's right-click names one. */
    page?: PetSettingsPage
  }>(),
  { gateway: null, page: 'general' },
)

const emit = defineEmits<{ (e: 'update:page', page: PetSettingsPage): void }>()

/** Which pages this task renders itself. The rest are slot content. */
const OWN_PAGES: readonly PetSettingsPage[] = ['general', 'notification']

/** Which of §5.1's pages each page's controls belong to, as the schemas they write. */
const PAGE_DOMAINS: { [P in PetSettingsPage]: readonly PetSettingsDomain[] } = {
  general: ['general', 'view'],
  character: ['character'],
  bubble: ['message'],
  notification: ['notification'],
  care: ['care'],
  project: ['project'],
  // §5.1's 高级与集成 has no schema of its own: `config.ts` keeps its contents in their own
  // sub-plans pending a privacy review, so there is nothing here to read.
  advanced: [],
}

/**
 * The domains the preview reads, and therefore the ones this container reads before any page
 * is opened. The preview is on screen from the first frame, so "a page that is not on screen
 * should not read" does not apply to it — the panel below is the page that is on screen.
 */
const PREVIEW_DOMAINS: readonly PetSettingsDomain[] = ['general', 'character', 'view', 'message']

const PAGE_ICONS: { [P in PetSettingsPage]: typeof SlidersHorizontal } = {
  general: SlidersHorizontal,
  character: PawPrint,
  bubble: MessageSquare,
  notification: Bell,
  care: Heart,
  project: FolderKanban,
  advanced: Wrench,
}

const slots = useSlots()

const authority = props.gateway
const capabilities = shallowRef<PetCapabilityReport[]>([])
/** The last load that rejected, so a host that answered nothing is stated rather than blank. */
const loadError = ref<string | null>(null)
/** The domains already asked for, so a page reopened does not read again. */
const requested = new Set<PetSettingsDomain>()

const context: PetSettingsContext | null =
  authority === null
    ? null
    : {
        gateway: authority,
        capabilities,
        // Built once, in setup order, so every session's `onScopeDispose` lands on this
        // component's scope. `load()` is not called here — the watcher and the mount hook below
        // decide which domains are read, and a session that was never loaded holds defaults and
        // says `loading`, which is exactly what "nobody has read this yet" should look like.
        sessions: {
          general: usePetSettings({ authority, domain: 'general' }),
          character: usePetSettings({ authority, domain: 'character' }),
          view: usePetSettings({ authority, domain: 'view' }),
          message: usePetSettings({ authority, domain: 'message' }),
          notification: usePetSettings({ authority, domain: 'notification' }),
          care: usePetSettings({ authority, domain: 'care' }),
          project: usePetSettings({ authority, domain: 'project' }),
        },
      }

/** The pages that have something to render, in §5.1's order. */
const available = computed(() =>
  PET_SETTINGS_PAGES.filter((page) => OWN_PAGES.includes(page) || Boolean(slots[page])),
)
const missing = computed(() => PET_SETTINGS_PAGES.filter((page) => !available.value.includes(page)))
const missingLabels = computed(() => missing.value.map((page) => t(`settings.pet.page.${page}`)).join(', '))

/**
 * Where a request to open a page actually lands.
 *
 * A caller — the pet's right-click, or the host restoring a remembered position — may name a
 * page this build has nothing behind. Falling back rather than showing a blank content area is
 * the same rule as not offering the row: the page does not exist here, and the note under the
 * rail is where that is said.
 */
function landing(page: PetSettingsPage): PetSettingsPage {
  if (available.value.includes(page)) return page
  return available.value[0] ?? 'general'
}

const active = ref<PetSettingsPage>(landing(props.page))
watch(
  () => props.page,
  (page) => { active.value = landing(page) },
)
watch(available, () => { active.value = landing(active.value) }, { immediate: true })

function ensureLoaded(domain: PetSettingsDomain): void {
  if (context === null || requested.has(domain)) return
  requested.add(domain)
  context.sessions[domain].load().catch((error: unknown) => {
    // `usePetSettings` keeps the session at `loading` when the host rejects, so the page would
    // otherwise sit on a spinner for ever with nothing to read. The session is left dirty rather
    // than adopted from a half-answer, and the message goes where the user can see it.
    loadError.value = error instanceof Error ? error.message : String(error)
  })
}

function open(page: PetSettingsPage): void {
  active.value = page
  emit('update:page', page)
}

watch(active, (page) => {
  for (const domain of PAGE_DOMAINS[page]) ensureLoaded(domain)
}, { immediate: true })

/** This container's own element, which `resetContentScroll` walks up from to find the dialog's
 *  scroll box. */
const root = ref<HTMLElement | null>(null)

/**
 * The rail's viewport rule: the reader arrives at the top of the page they opened.
 *
 * **Measured, because a report of this one had only been read.** Nothing in this directory touched
 * the offset, and the section is the third rail to reuse `.dialog-content` — but the magnitude is
 * not the other two's. `.pet-settings__rail` is not sticky, so a reader can only press a row while
 * the rail is inside the box: at rest its top is 16px below the box's, so **16px** is the most the
 * container can be scrolled with the whole rail still on screen. Pressed there, the page that was
 * opened arrived at `108` against its own at-rest `108` — 16px past its top, with its first row cut
 * off. `settings-scroll-reset.spec.ts` reads both numbers off the boxes rather than choosing them,
 * so the day this rail moves (a section label above it, a sticky rail, a taller tab strip) the
 * offset a reader can reach is measured again rather than assumed.
 *
 * A watcher and not a handler on the rail's click, so the two ways `active` can move are one path:
 * the row the reader presses, and `landing` re-homing a page whose component this build does not
 * have. The second is not the reader's gesture and it is still a page they have never seen.
 */
watch(active, () => { resetContentScroll(root.value) })

onMounted(() => {
  if (context === null) return
  for (const domain of PREVIEW_DOMAINS) ensureLoaded(domain)
  context.gateway.capabilities().then(
    // An answer that is not an array is not a report: a host that resolved `undefined` — which is
    // what a stub that has no case for this command does, and how the crash below was found —
    // reported nothing, and storing that answer as-is is what made every page that reads this ref
    // throw while rendering. The empty list is the truth here, and it is rendered as "nothing was
    // reported" rather than as "none of these work" (§7.2).
    (report) => { capabilities.value = Array.isArray(report) ? report : [] },
    () => { capabilities.value = [] },
  )
})
</script>

<template>
  <section
    ref="root"
    class="pet-settings"
  >
    <p
      v-if="!context"
      class="settings-note pet-settings__absence"
    >
      {{ t('settings.pet.noGateway') }}
    </p>

    <!-- `v-if="context"` on each element rather than on a `<template>`: it is what lets the
         bindings below pass `context` as the non-null prop the pages declare, without a cast
         that would hide the day the guard stops being true. -->
    <nav
      v-if="context"
      class="pet-settings__rail"
      role="tablist"
      :aria-label="t('settings.pet.pages')"
    >
      <button
        v-for="entry in available"
        :key="entry"
        class="pet-settings__tab"
        :class="{ active: entry === active }"
        type="button"
        role="tab"
        :aria-selected="entry === active"
        :data-page="entry"
        @click="open(entry)"
      >
        <component
          :is="PAGE_ICONS[entry]"
          :size="13"
          :stroke-width="1.8"
        />
        <span>{{ t(`settings.pet.page.${entry}`) }}</span>
      </button>
    </nav>

    <p
      v-if="context && loadError"
      class="settings-note pet-settings__alert"
    >
      {{ t('settings.pet.loadFailed', { msg: loadError }) }}
    </p>

    <div
      v-if="context"
      class="pet-settings__body"
    >
      <div class="pet-settings__page">
        <!-- One keyed wrapper, so the swap is one element changing rather than five
             alternatives for `<Transition>` to guess between — and so a slot page and a
             built-in page arrive the same way. -->
        <Transition name="pet-swap">
          <div
            :key="active"
            class="pet-settings__content"
          >
            <PetGeneralSettings
              v-if="active === 'general'"
              :context="context"
            />
            <PetNotificationSettings
              v-else-if="active === 'notification'"
              :context="context"
            />
            <!-- The remaining pages are slot content, and the slot is named by the page —
                 so a page that lands later is reachable without a line being added here,
                 and the two branches above are only the ones this task owns itself. -->
            <slot
              v-else
              :name="active"
              :context="context"
            />
          </div>
        </Transition>
      </div>
      <PetSettingsPreview
        class="pet-settings__preview"
        :context="context"
      />
    </div>

    <p
      v-if="context && missing.length"
      class="settings-note pet-settings__pending"
    >
      {{ t('settings.pet.notLanded', { pages: missingLabels }) }}
    </p>
  </section>
</template>

<style scoped>
.pet-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.pet-settings__absence { margin: 0; }
.pet-settings__alert { margin: 0; color: var(--app-danger); }
.pet-settings__pending { margin: 0; }

.pet-settings__rail {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  user-select: none;
}
.pet-settings__tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--app-radius-lg);
  background: transparent;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  font-family: var(--app-font);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.pet-settings__tab:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 62%, transparent);
}
.pet-settings__tab:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.pet-settings__tab.active {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-elevated));
  color: var(--app-text);
  font-weight: 600;
}

.pet-settings__body {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.pet-settings__page {
  position: relative;
  flex: 1 1 260px;
  min-width: 0;
}
.pet-settings__preview { flex: 0 0 176px; }

/* The sub-page swap, on §7.3's rungs: it is a *page*, so the one leaving fades out of flow at
   the same top edge the incoming one lands on — otherwise the panel would hold both and the
   preview beside it would jump by whichever was taller. */
.pet-swap-enter-active {
  transition: opacity var(--app-motion-fade) var(--app-ease),
              translate var(--app-motion) var(--app-ease-surface);
}
.pet-swap-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  pointer-events: none;
  transition: opacity var(--app-motion-exit) var(--app-ease-exit),
              translate var(--app-motion-exit) var(--app-ease-exit);
}
.pet-swap-enter-from {
  opacity: 0;
  translate: 0 var(--app-motion-travel);
}
.pet-swap-leave-to {
  opacity: 0;
  translate: 0 calc(var(--app-motion-travel) / 3);
}
</style>
