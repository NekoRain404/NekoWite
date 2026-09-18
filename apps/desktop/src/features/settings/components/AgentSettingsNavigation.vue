<script setup lang="ts">
/**
 * The agent settings tree's rail: one row per page this build can show.
 *
 * A file of its own for the reason `SettingsNavigation.vue` is a file of its own — the icons and the
 * labels are the rail's, and the container that switches between the pages stays free of them. It
 * is a second-level rail, under the dialog's own: the dialog's rail switches *sections*, and this
 * one switches the pages inside the agents section.
 *
 * **Every label is the page's own.** Each of the seven components already draws a `section.title` at
 * the top of itself, and each default is a literal `t()` call in that component's own labels file.
 * A rail that wrote its own wording would be a second name for one page, and the two would drift the
 * first time either was edited — resolving the page's own key is what makes the row and the heading
 * the same words. The calls below are literal rather than built from the id, because a key the
 * source constructs cannot be seen missing from the catalogue by the i18n guard: a rename would
 * reach the rail as an id printed where a sentence belongs.
 *
 * **The order and the membership are the caller's.** It renders `pages`, in the order given, which
 * is `AGENT_SETTINGS_SECTIONS`'s — the barrel says that list is "the order a navigation should
 * offer it", and until this rail existed nothing read it for that. A page this build has no client
 * for is not in the list at all: §5.2 forbids a control that leads nowhere, and those sections are
 * *stated* as sentences by the container rather than drawn as rows here.
 */
import { Activity, Cable, FileCog, Globe, Server, ShieldCheck, Wand2 } from 'lucide-vue-next'
import { t } from '../../../i18n'
import type { AgentPageId } from '../types'

defineProps<{ pages: readonly AgentPageId[]; active: AgentPageId }>()
const emit = defineEmits<{ (e: 'update:active', page: AgentPageId): void }>()

/** The page's own heading, so the row and the page cannot say two different things. */
const LABELS: Record<AgentPageId, string> = {
  runtime: t('agent.settings.runtime.section.title'),
  provider: t('agent.settings.provider.section.title'),
  configuration: t('agent.settings.config.section.title'),
  skills: t('agent.settings.skills.section.title'),
  permission: t('agent.settings.permission.section.title'),
  registry: t('agent.registry.section.title'),
  catalogue: t('agent.catalogue.section.title'),
}

/** One icon per page, by what the page is about rather than by which engine it configures. */
const ICONS: Record<AgentPageId, typeof Activity> = {
  runtime: Activity,
  provider: Cable,
  configuration: FileCog,
  skills: Wand2,
  permission: ShieldCheck,
  registry: Server,
  catalogue: Globe,
}
</script>

<template>
  <nav
    class="agents-rail"
    role="tablist"
    :aria-label="t('agent.settings.agents.pages')"
  >
    <button
      v-for="page in pages"
      :key="page"
      type="button"
      role="tab"
      class="agents-tab"
      :class="{ active: page === active }"
      :aria-selected="page === active"
      :data-page="page"
      @click="emit('update:active', page)"
    >
      <component
        :is="ICONS[page]"
        :size="13"
        :stroke-width="1.8"
      />
      <span>{{ LABELS[page] }}</span>
    </button>
  </nav>
</template>

<style scoped>
/* The same vocabulary as the dialog's own rail above it and the pet's sub-navigation beside it: a
   wrapping row of `role="tab"` buttons, the active one carrying the accent. `flex-wrap` so a narrow
   dialog stacks the rows rather than clipping the last one — measured clean at the product's own
   860x560 minimum in `settings-density.spec.ts`. */
.agents-rail {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
  user-select: none;
}
.agents-tab {
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
.agents-tab:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 62%, transparent);
}
.agents-tab:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agents-tab.active {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-elevated));
  color: var(--app-text);
  font-weight: 600;
}
</style>
