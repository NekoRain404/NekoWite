<script lang="ts">
/**
 * The row's copy, overridable by whoever wires it up — the arrangement
 * {@link AgentCommandMenuLabels} uses: the defaults come from the catalogue, and a caller may
 * say more than the generic sentence can.
 */
export interface AgentConfigRowLabels {
  /** Names the group for a screen reader: what the controls in it are. */
  group: string
  /** Why a control cannot be used — drawn on one whose option no call in this contract
   *  addresses. */
  unavailable: string
  /** A value that was chosen and did not take. `{reason}` is the host's or the engine's own
   *  sentence, which is reported rather than summarised. */
  failed: string
}
</script>

<script setup lang="ts">
/**
 * The session's own options, as the composer's control row draws them.
 *
 * This is Zed's `ConfigOptionsView` (`zed-main/crates/agent_ui/src/config_options.rs:33`,
 * rendered at `:275`): the session's configuration options in the order the engine reported
 * them, one control each — a select opening a picker, a boolean as a switch — and **nothing at
 * all when the session reports none**, which is the case that file returns an empty element for.
 * It is what the composer's control row shows on the right, in the place Zed's thread view puts
 * it (`conversation_view/thread_view.rs:4458-4476`: usage, profile, then the config options
 * *instead of* a mode selector and a model selector, then the send button) — and like Zed's, the
 * row's contents are the engine's report rather than a list this app decided on. An engine that
 * reports a model and a mode gets two controls; one that reports four gets four; one that
 * reports none gets none, and the row is simply not there.
 *
 * Props in, events out (§10.2): `services/agent-config-options.ts` decides what each control is
 * and whether this build can move it, and a choice leaves as an event. Nothing here reads a
 * frame, a store or a gateway.
 */
import { computed } from 'vue'
import type { AgentConfigControl } from '../services/agent-config-options'
import { t } from '../../../i18n'
import AgentConfigPicker from './AgentConfigPicker.vue'

const props = defineProps<{
  /** What to draw, in the order to draw it. Empty means this session reported no options. */
  controls: readonly AgentConfigControl[]
  /** The key of the control whose value is being set right now, or null. */
  busy: string | null
  /**
   * The set that did not take: which control, and the reason as it arrived.
   *
   * It stays until the next attempt, because what it says is still true — the control is still
   * showing the engine's value, which is still the one in force.
   */
  failure: { key: string; message: string } | null
  /** Overrides for the default copy; see {@link AgentConfigRowLabels}. */
  labels?: Partial<AgentConfigRowLabels>
}>()

const emit = defineEmits<{
  /** The reader settled on a value for one of the session's options. */
  set: [key: string, value: string | boolean]
}>()

const copy = computed((): AgentConfigRowLabels => ({
  group: t('agent.panel.composer.config.group'),
  unavailable: t('agent.panel.composer.config.unavailable'),
  failed: t('agent.panel.composer.config.failed', { reason: props.failure?.message ?? '' }),
  ...props.labels,
}))

/** The sentence for a failed set, or null — one place, so the trigger's tooltip and the
 *  announcement beside it cannot say different things. */
function failureFor(key: string): string | null {
  return props.failure !== null && props.failure.key === key ? copy.value.failed : null
}

/** The reason an option cannot be moved at all, or null. See the service's header: `movable`
 *  is false only for an option whose value this app has no way to report — an engine's boolean
 *  option, which the contract's one setter cannot express. */
function unavailableFor(control: AgentConfigControl): string | null {
  return control.movable ? null : copy.value.unavailable
}
</script>

<template>
  <!-- Nothing when the session reported nothing: a row of controls that are not the engine's
       would be this app inventing options, which is the one thing the row must not do. -->
  <div
    v-if="controls.length > 0"
    class="agent-config-row"
    role="group"
    :aria-label="copy.group"
    data-agent-config
  >
    <template
      v-for="control in controls"
      :key="control.key"
    >
      <AgentConfigPicker
        v-if="control.kind === 'select'"
        :control="control"
        :busy="busy === control.key"
        :unavailable="unavailableFor(control)"
        :failure="failureFor(control.key)"
        @select="emit('set', control.key, $event)"
      />
      <!-- A boolean option is a switch carrying the option's own name (Zed's `Boolean` arm,
           `config_options.rs:531`): the value is whether-or-not, so there is nothing to list. -->
      <button
        v-else
        class="agent-config-toggle"
        type="button"
        role="switch"
        :aria-checked="control.current"
        :aria-label="control.name"
        :disabled="busy === control.key || !control.movable"
        :title="[control.name, control.description, unavailableFor(control)].filter(Boolean).join('\n')"
        :data-option="control.key"
        @click="emit('set', control.key, !control.current)"
      >
        <span class="agent-config-toggle-label">{{ control.name }}</span>
        <span
          class="agent-config-toggle-track"
          :class="{ 'is-on': control.current }"
          aria-hidden="true"
        />
      </button>
    </template>
    <!-- The failed set, announced rather than only hoverable: the visible state is the engine's
         unchanged value, so a reader who cannot see the trigger's mark has to hear why. -->
    <p
      v-if="failure !== null"
      class="agent-config-status"
      role="status"
    >
      {{ copy.failed }}
    </p>
  </div>
</template>

<style scoped>
/* Sized by its own controls and never grown into the bar's free space: the hint beside it is the
   thing that gives way when the panel is narrow (it ellipsises), and a row that took the slack
   would paint its controls over the sentence — which is what the first WebKitGTK render of this
   row showed.

   `flex: 0 1 auto` — not the `0 0 auto` this row carried until the rail's narrow end was
   measured — is the narrow-panel case this comment has always claimed. The row may be given
   LESS than its controls ask for, and when it is, the `flex-wrap` below puts them on a second
   line rather than letting one be pushed off the edge. `min-width: 0` is the other half of that
   and not decoration: a flex item's automatic minimum is its min-content width, so without the
   release this row refuses the smaller box it is offered and overflows the bar — which is how
   the send button was being drawn past the window, out of reach, at every width from
   `RAIL_WIDTH_MIN` (220) up to 267.

   That is Zed's arrangement of the same row, and the reason to copy it rather than invent one:
   `ConfigOptionsView` is `h_flex().min_w_0().flex_wrap()`
   (`zed-main/crates/agent_ui/src/config_options.rs:275-288`) over buttons that `ButtonLike`
   pins at `flex_none` (`crates/ui/src/components/button/button_like.rs:785`) — the collection
   wraps, the controls inside it never shrink, and nothing is hidden or scrolled sideways. The
   cap on a single control is the other half of that: see `AgentConfigPicker.vue`'s
   `max-width`, which keeps one long model name from asking the row for room it does not have.
   (§5.3's 「不能把所有项都做成文字胶囊按钮」 is about capsules, not about wrapping.) */
.agent-config-row {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  max-width: 100%;
}
.agent-config-toggle {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 6px;
  /* No wider than the row it is in. The row can be given less than its controls ask for (see
     above), and a control that kept its own width in that box would be drawn past the row's
     edge — over the send button, or off the window. Clamped, it ellipsises its name instead
     (`.agent-config-toggle-label`). */
  max-width: 100%;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 11px;
  cursor: pointer;
}
.agent-config-toggle:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
  color: var(--app-text);
}
.agent-config-toggle:disabled {
  cursor: default;
  opacity: 0.55;
}
.agent-config-toggle:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-config-toggle-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-config-toggle-track {
  position: relative;
  flex: none;
  width: 22px;
  height: 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--app-border) 80%, var(--app-elevated));
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-config-toggle-track.is-on {
  background: var(--app-accent);
}
.agent-config-toggle-track::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--app-panel);
  content: '';
  transition: transform var(--app-motion-fast) var(--app-ease);
}
.agent-config-toggle-track.is-on::after {
  transform: translateX(10px);
}
/* Announced, not read: it explains a mark on a control that already shows the engine's own
   value, and a line of run-time text between the field and the send button would move both. */
.agent-config-status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
