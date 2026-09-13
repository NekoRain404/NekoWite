/**
 * Whether a rail section is currently displayed.
 *
 * The info rail mounts every section and switches between them with `v-show`,
 * so "mounted" says nothing about what the user can see: a hidden section still
 * re-renders and still runs its computeds on every edit. Work that only feeds a
 * visible section (parsing the outline, reading the version list) has to know
 * whether the section is on screen, and that has to be observed rather than
 * assumed — the component is present either way.
 *
 * `v-show` expresses hiddenness as the element's own inline `display`, which is
 * exactly what this tracks: a `MutationObserver` on the section's root element's
 * `style` attribute. Nothing else in the rail hides a section (the rail itself
 * is unmounted with `v-if`, so when the rail is closed these panels do not
 * exist), and the observer only fires when that one attribute changes.
 *
 * Until the element exists the answer is "shown", which is the safe default for
 * a panel mounted outside the rail (a test, or a future host that renders it
 * unconditionally): it computes, exactly as it did before.
 */

import { onBeforeUnmount, onMounted, ref, type ComponentPublicInstance, type Ref } from 'vue'

export interface SectionShown {
  /** Bind to the section's root element: `<section :ref="sectionRef">`. */
  sectionRef: (el: Element | ComponentPublicInstance | null) => void
  /** True while the section is displayed. */
  shown: Ref<boolean>
}

export function useSectionShown(): SectionShown {
  const shown = ref(true)
  let element: HTMLElement | null = null
  let observer: MutationObserver | null = null

  /** What `v-show` leaves behind on a hidden element. */
  function read(): void {
    shown.value = element === null || element.style.display !== 'none'
  }

  function sectionRef(el: Element | ComponentPublicInstance | null): void {
    element = el instanceof HTMLElement ? el : null
  }

  onMounted(() => {
    read()
    // Without MutationObserver (a non-DOM environment) the panel keeps the
    // "shown" default rather than silently freezing its values.
    if (element === null || typeof MutationObserver === 'undefined') return
    observer = new MutationObserver(read)
    observer.observe(element, { attributes: true, attributeFilter: ['style'] })
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return { sectionRef, shown }
}
