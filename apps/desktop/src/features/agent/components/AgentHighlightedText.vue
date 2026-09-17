<script lang="ts">
/**
 * One string of one row, with the search hits marked inside it.
 *
 * It exists so that a hit is painted *in the text it was found in* rather than beside it: the
 * transcript is the panel's body, and a "found it" that pointed at a row without showing where in
 * the row would be a claim about the row rather than about the words (§5.3). Every other part of
 * the find box — which rows, which words, how many — is decided in
 * `services/agent-conversation-search.ts`; this file only turns ranges into elements.
 *
 * **A plain run renders inside a `span` rather than as a bare text node**, and that is not
 * stylistic: Vue condenses whitespace in a text node of its own, and these rows are
 * `white-space: pre-wrap`, so a leading or trailing space of a run is content the reader's eye
 * depends on. Inside an element, the text is exactly the interpolation's value.
 */
export interface AgentHitRange {
  /** Index in `text` of the first character of the hit. */
  readonly start: number
  /** Index just past its last character. */
  readonly end: number
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** The string as the row holds it. Drawn whole: nothing here trims, folds or re-wraps it. */
  text: string
  /** This string's hits, in ascending order — `hitsIn`'s answer, already narrowed to one field. */
  hits?: readonly AgentHitRange[]
  /**
   * Which of `hits` the reader is on, or `-1`.
   *
   * The element carrying `data-agent-hit="active"` is how the transcript finds the hit to take
   * them to, so exactly one element in the whole transcript may carry it — which is why this is
   * an index into this string's own hits rather than a flag a caller could set twice.
   */
  active?: number
}>()

interface Segment {
  readonly text: string
  /** The hit's index in `hits`, or `-1` for the text between hits. */
  readonly hit: number
}

/**
 * The string cut at its hit boundaries.
 *
 * Ranges are taken as the rule hands them over — ascending, non-overlapping — and a range that
 * falls outside the string (which the rule cannot produce, and which is not this component's to
 * repair) would only ever skip text it cannot address: the loop takes `text.slice(from, start)`
 * and then advances to `end`, so the drawn string still covers everything between the marks.
 */
const segments = computed<readonly Segment[]>(() => {
  const ranges = props.hits ?? []
  if (ranges.length === 0) return [{ text: props.text, hit: -1 }]
  const out: Segment[] = []
  let at = 0
  ranges.forEach((range, index) => {
    if (range.start > at) out.push({ text: props.text.slice(at, range.start), hit: -1 })
    out.push({ text: props.text.slice(range.start, range.end), hit: index })
    at = range.end
  })
  if (at < props.text.length) out.push({ text: props.text.slice(at), hit: -1 })
  return out
})
</script>

<template>
  <template
    v-for="(segment, index) in segments"
    :key="index"
  >
    <!-- A hit, and the one the reader is on: the attribute is what the transcript looks up to
         take them to it, so it is set on this element and nowhere else. -->
    <mark
      v-if="segment.hit !== -1"
      class="agent-hit"
      :class="{ 'is-active': segment.hit === (active ?? -1) }"
      :data-agent-hit="segment.hit === (active ?? -1) ? 'active' : null"
    >{{ segment.text }}</mark>
    <span
      v-else
      class="agent-hit-plain"
    >{{ segment.text }}</span>
  </template>
</template>

<style scoped>
/* A hit is drawn with the app's own find vocabulary — the same token pair the source editor's
   search uses (`services/cm-source-view.ts`: `--app-code-number` at 32% and 52%) — so a match
   looks like a match wherever the reader meets one, and the active one is the same colour one
   step up rather than a second colour that would read as a second kind of hit. */
.agent-hit {
  border-radius: 2px;
  background: color-mix(in srgb, var(--app-code-number) 32%, transparent);
  color: inherit;
}
.agent-hit.is-active {
  background: color-mix(in srgb, var(--app-code-number) 52%, transparent);
}
/* No rule of its own: the plain run is an element for the reason in this file's header and must
   draw exactly like the text around it. */
</style>
