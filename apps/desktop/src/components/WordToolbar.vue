<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getToolbar } from '@nekowite/editor-core'
import {
  Bold,
  Braces,
  Code,
  Heading2,
  Image as ImageIcon,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  MessageSquareQuote,
  Minus,
  Quote,
  Sigma,
  Sparkles,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Boxes,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { COMMAND_KEYS } from '../ui/command-catalog'
import { rewriteSelection } from '../services/ai-edit'
import type { EditAction } from '../services/ai-edit'
import { t } from '../i18n'

const emit = defineEmits<{ (e: 'command', id: string): void }>()

const headingMenuOpen = ref(false)
const headingEl = ref<HTMLElement | null>(null)

const aiMenuOpen = ref(false)
const aiMenuEl = ref<HTMLElement | null>(null)

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6]

function toggleHeadingMenu(): void {
  headingMenuOpen.value = !headingMenuOpen.value
}

function pickHeading(level: number): void {
  headingMenuOpen.value = false
  emit('command', `heading:h${level}`)
}

function toggleAiMenu(): void {
  aiMenuOpen.value = !aiMenuOpen.value
}

function runAi(action: EditAction): void {
  aiMenuOpen.value = false
  void rewriteSelection(action)
}

function onDocPointerDown(e: PointerEvent): void {
  if (!headingMenuOpen.value && !aiMenuOpen.value) return
  if (headingEl.value && headingEl.value.contains(e.target as Node)) {
    return
  }
  if (aiMenuEl.value && aiMenuEl.value.contains(e.target as Node)) {
    return
  }
  headingMenuOpen.value = false
  aiMenuOpen.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))

const registryItems = getToolbar()

const REGISTRY_ICONS: Record<string, Component> = {
  'math.insert': Sigma,
  'table.insert': TableIcon,
  'callout.insert': MessageSquareQuote,
  'floatbox.insert': Boxes,
}

/**
 * Tooltip / label for a registry (plugin or builtin) toolbar item.
 *
 * Registration happens in editor-core, which has no i18n, so the builtin
 * "Table" button shipped an English tooltip in an otherwise localized toolbar.
 * `COMMAND_KEYS` already maps the command ids to message keys for the command
 * palette, so reuse it and fall back to the registered label for a
 * third-party plugin (which brings its own text).
 */
function registryLabel(item: { id: string; label: string }): string {
  const key = COMMAND_KEYS[item.id]
  return key ? t(key) : item.label
}

function run(id: string): void {
  emit('command', id)
}

/**
 * Plugin/registry buttons resolve their own view, which is the rendered one —
 * in source mode that edit would be lost. Routing them through the same
 * `command` event as the builtin buttons puts them on the shared, mode-aware
 * path.
 */
function runRegistry(id: string): void {
  emit('command', id)
}
</script>

<template>
  <div
    class="word-toolbar"
    role="toolbar"
  >
    <div
      ref="headingEl"
      class="heading-menu-wrap"
    >
      <button
        class="toolbar-btn"
        :title="t('toolbar.heading')"
        :aria-label="t('toolbar.heading')"
        @click="toggleHeadingMenu"
      >
        <Heading2
          :size="15"
          :stroke-width="1.8"
        />
      </button>
      <Transition name="menu">
        <div
          v-if="headingMenuOpen"
          class="heading-menu"
        >
          <button
            v-for="level in HEADING_LEVELS"
            :key="level"
            class="heading-option"
            @click="pickHeading(level)"
          >
            <span
              class="heading-preview"
              :data-level="level"
            >H{{ level }}</span>
            {{ t('toolbar.headingLevel', { n: level }) }}
          </button>
        </div>
      </Transition>
    </div>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.bold')"
      :aria-label="t('toolbar.bold')"
      @mousedown.prevent
      @click="run('bold')"
    >
      <Bold
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.italic')"
      :aria-label="t('toolbar.italic')"
      @mousedown.prevent
      @click="run('italic')"
    >
      <Italic
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.strike')"
      :aria-label="t('toolbar.strike')"
      @mousedown.prevent
      @click="run('strike')"
    >
      <Strikethrough
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.inlineCode')"
      :aria-label="t('toolbar.inlineCode')"
      @mousedown.prevent
      @click="run('inline-code')"
    >
      <Code
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.link')"
      :aria-label="t('toolbar.link')"
      @mousedown.prevent
      @click="run('link')"
    >
      <Link
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.image')"
      :aria-label="t('toolbar.image')"
      @mousedown.prevent
      @click="run('image')"
    >
      <ImageIcon
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.listUnordered')"
      :aria-label="t('toolbar.listUnordered')"
      @mousedown.prevent
      @click="run('list-unordered')"
    >
      <List
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.listOrdered')"
      :aria-label="t('toolbar.listOrdered')"
      @mousedown.prevent
      @click="run('list-ordered')"
    >
      <ListOrdered
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.listTask')"
      :aria-label="t('toolbar.listTask')"
      @mousedown.prevent
      @click="run('list-task')"
    >
      <ListTodo
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.quote')"
      :aria-label="t('toolbar.quote')"
      @mousedown.prevent
      @click="run('quote')"
    >
      <Quote
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.codeBlock')"
      :aria-label="t('toolbar.codeBlock')"
      @mousedown.prevent
      @click="run('code-block')"
    >
      <SquareCode
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.hr')"
      :aria-label="t('toolbar.hr')"
      @mousedown.prevent
      @click="run('hr')"
    >
      <Minus
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.insertComponent')"
      :aria-label="t('toolbar.insertComponent')"
      @mousedown.prevent
      @click="run('insert-component')"
    >
      <Braces
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <div
      ref="aiMenuEl"
      class="heading-menu-wrap"
    >
      <button
        class="toolbar-btn"
        :title="t('ai.title')"
        :aria-label="t('ai.title')"
        @click="toggleAiMenu"
      >
        <Sparkles
          :size="15"
          :stroke-width="1.8"
        />
      </button>
      <Transition name="menu">
        <div
          v-if="aiMenuOpen"
          class="heading-menu"
        >
          <button
            class="heading-option"
            @click="runAi('rewrite')"
          >
            <span class="heading-preview">RW</span>
            {{ t('ai.rewrite') }}
          </button>
          <button
            class="heading-option"
            @click="runAi('polish')"
          >
            <span class="heading-preview">PL</span>
            {{ t('ai.polish') }}
          </button>
          <button
            class="heading-option"
            @click="runAi('translate')"
          >
            <span class="heading-preview">TR</span>
            {{ t('ai.translate') }}
          </button>
        </div>
      </Transition>
    </div>
    <template v-if="registryItems.length">
      <span class="toolbar-sep" />
      <button
        v-for="item in registryItems"
        :key="`reg-${item.id}`"
        class="toolbar-btn"
        :data-command-id="item.id"
        :title="registryLabel(item)"
        :aria-label="registryLabel(item)"
        @mousedown.prevent
        @click="runRegistry(item.id)"
      >
        <component
          :is="REGISTRY_ICONS[item.id]"
          v-if="REGISTRY_ICONS[item.id]"
          :size="15"
          :stroke-width="1.8"
        />
        <span v-else>{{ registryLabel(item) }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.word-toolbar {
  display: flex;
  align-items: center;
  gap: 1px;
  height: var(--app-toolbar-height);
  padding: 0 10px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-elevated) 76%, var(--app-canvas));
  overflow-x: auto;
  user-select: none;
}
.heading-menu-wrap {
  position: relative;
  display: inline-flex;
}
.heading-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 140px;
  padding: 5px;
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  box-shadow: var(--app-shadow-menu);
  /* The menu hangs off the button that owns it, and they share a left edge, so
     the corner they touch is where the menu conceptually comes from. Set on the
     base rule rather than on the transition classes: those are removed a frame
     into the transition, and the origin would snap back to the centre while the
     menu was still scaling. */
  transform-origin: top left;
}
.heading-option {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.heading-option:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-elevated));
}
.heading-preview {
  width: 26px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
  font-size: 10px;
  font-weight: 700;
  color: var(--app-muted);
}
.heading-preview[data-level="1"] { font-size: 13px; }
.heading-preview[data-level="2"] { font-size: 12px; }
.heading-preview[data-level="3"] { font-size: 11px; }
/* The rows used to step in one after another, each with its own delay, while the
   menu around them was already fading and scaling in. That is a second animation
   stacked on the first — the same fade twice — and it was the half that could
   not be reversed: a delay belongs to an animation, so a menu closed half-way
   through lost the animations and the rows dropped to full opacity in one frame
   while the menu itself eased back. The menu is the arrival now and the rows
   come with it (see the note in styles/motion.css). */
.menu-enter-active {
  /* --app-motion is the rung for a region changing state in place, and a menu
     reveal is the case the ladder names. Two curves, because these are two
     different properties: the movement has a corner to settle into and takes the
     spring, while the fade has nothing above 1 to overshoot and takes the
     state-change bezier. On one curve the opacity reaches full at 42% of the
     timeline and the menu is still visibly growing for the rest of it. */
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease-surface);
  will-change: opacity, transform;
}
/* Leaving takes the exit fraction of the entrance above — long enough to read
   as a departure rather than a cut, short enough that a menu the user is done
   with is gone — and accelerates away on the exit curve while it goes. */
.menu-leave-active {
  transition: opacity var(--app-motion-exit) var(--app-ease-exit),
              transform var(--app-motion-exit) var(--app-ease-exit);
  will-change: opacity, transform;
}
.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  /* It grows out of the button's corner and covers the few pixels between them.
     Starting *below* the resting position — which this used to do — meant the
     menu rose into place from a gap it never occupied, arriving from nowhere;
     the button is above the menu, so the travel has to be downward. The scale is
     the anchored-popover amplitude: a menu is small furniture and 4% of a
     140px-wide row is most of a glyph's height, which reads as a pop rather than
     as an arrival. */
  transform: translateY(calc(var(--app-motion-travel) * -1)) scale(var(--app-motion-scale-pop));
}
</style>
