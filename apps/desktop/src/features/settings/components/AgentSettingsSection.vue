<script setup lang="ts">
/**
 * The agents section: the one control that reaches the shell, and the statements
 * for everything in this tree that has no host half yet.
 *
 * ## Why the page is mostly sentences
 *
 * §10.2's T16 row and §8 give an agent settings tree of seven pages, and every one
 * of them is delivered as a component that takes its facts from an injected
 * `AgentRegistryClient` / `AgentRuntimeClient` / … — a port this build has no
 * implementation of. There is also nothing behind three of them even in the
 * backend: the registry's mutation IPC (nothing in a window can add or disable an
 * engine), the capability join (the negotiated half is not joined to the declared
 * half), and credentials at launch (the start path builds the launch environment
 * without them).
 *
 * A page that mounted one of those components with a fabricated client, or drew a
 * switch whose write goes nowhere, would be claiming a capability this build does
 * not have. That is the one claim this feature must not make, and it is a rule
 * already spelled out twice in this tree — the registry page states what being
 * registered does and does not prove, the pet integration page states its absent
 * capabilities as rows of text — so this page follows it: what cannot be done is
 * *said*, with what it would take, and no control is drawn for it.
 *
 * ## The one control
 *
 * The rail switch is not one of those gaps: it is a real setting with a real
 * effect (the shell reads it; see `stores/settings-agent.ts` for the value, the
 * default and why the default is off), so it is a control. Its hint states the
 * consequence the user cannot see from here — that the chat panel is unmounted
 * while it is on and a reply still streaming is cancelled — because a rollback
 * the user cannot predict is the failure this section exists to prevent.
 */
import { t } from '../../../i18n'
import { useAgentPanel } from '../composables/use-agent-panel'

const { agentPanel, setAgentPanel } = useAgentPanel()

/** The four statements about what is not connected, in the order they are drawn.
 *  A list rather than four `t()` calls in the template, so the set is one thing a
 *  reader can see at once and a fifth gap is one line here. */
const gaps = [
  t('agent.settings.agents.gaps.sections'),
  t('agent.settings.agents.gaps.registry'),
  t('agent.settings.agents.gaps.capabilities'),
  t('agent.settings.agents.gaps.credentials'),
]
</script>

<template>
  <section class="settings-section">
    <span class="settings-label">{{ t('agent.settings.agents.section.title') }}</span>
    <p class="settings-note">
      {{ t('agent.settings.agents.section.hint') }}
    </p>
    <label class="settings-field settings-toggle">
      <span>{{ t('agent.settings.agents.panel.label') }}</span>
      <input
        :checked="agentPanel"
        data-agent-panel-switch
        type="checkbox"
        class="checkbox"
        @change="setAgentPanel(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <p class="settings-note">
      {{ t('agent.settings.agents.panel.hint') }}
    </p>

    <span class="settings-label">{{ t('agent.settings.agents.gaps.title') }}</span>
    <p class="settings-note">
      {{ t('agent.settings.agents.gaps.intro') }}
    </p>
    <!-- Text, not disabled controls: `.agent-gap` is a list item and there is no
         `input`, `button` or `role="switch"` anywhere below. The absence is the
         acceptance — a control that only fails reads as a feature that is broken
         rather than as one that was never built. -->
    <ul class="agent-gaps">
      <li
        v-for="(gap, index) in gaps"
        :key="index"
        class="agent-gap"
      >
        {{ gap }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-label`, `.settings-toggle`, `.settings-field`
   and `.checkbox` are restated here, as every section in this dialog restates
   them: a scoped block belongs to the component that renders the element. */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.settings-section .settings-label:first-child { margin-top: 0; }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.settings-toggle > span { color: var(--app-text); font-size: 12px; }
.checkbox {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--app-accent);
  cursor: pointer;
}
.settings-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted);
}
.agent-gaps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 16px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted);
}
.agent-gap::marker { color: var(--app-accent); }
</style>
