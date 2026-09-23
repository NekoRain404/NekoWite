<script setup lang="ts">
import { t } from '../i18n'
</script>

<template>
  <div class="startup-overlay" role="status" :aria-label="t('common.loading')">
    <div class="startup-card">
      <svg class="startup-mark" viewBox="0 0 96 96" aria-hidden="true">
        <path class="mark-fill" d="M25 35 18 18l22 11a37 37 0 0 1 16 0l22-11-7 18c8 7 12 17 12 28 0 13-13 23-35 23S13 77 13 64c0-11 4-21 12-29Z" />
        <path class="mark-line" d="M25 35 18 18l22 11a37 37 0 0 1 16 0l22-11-7 18c8 7 12 17 12 28 0 13-13 23-35 23S13 77 13 64c0-11 4-21 12-29Z" />
        <path class="mark-line" d="M32 58h1m30 0h1M40 68c5 4 11 4 16 0" />
        <path class="pencil" d="m58 76 22-28 7 6-22 28-10 4Z" />
      </svg>
      <strong>NekoWite</strong>
      <div class="paw-loader" aria-hidden="true">
        <i /><i /><i />
      </div>
    </div>
  </div>
</template>

<style scoped>
.startup-overlay {
  position: fixed;
  z-index: 10000;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--app-accent-soft) 78%, transparent), transparent 34%),
    var(--app-canvas);
  animation: startup-backdrop-in 420ms var(--app-ease) both;
}
.startup-card { display: grid; justify-items: center; gap: 12px; color: var(--app-text); }
.startup-card strong { font: 650 17px var(--app-font); letter-spacing: .08em; }
.startup-mark { width: 82px; height: 82px; overflow: visible; filter: drop-shadow(0 12px 22px color-mix(in srgb, var(--app-accent) 18%, transparent)); animation: breathe 1.35s var(--app-ease) infinite alternate; }
.mark-fill { fill: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-elevated)); }
.mark-line { fill: none; stroke: var(--app-accent); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
.pencil { fill: color-mix(in srgb, var(--app-accent) 66%, #f4b56a); stroke: var(--app-text); stroke-width: 3; stroke-linejoin: round; }
.paw-loader { display: flex; align-items: end; gap: 6px; height: 18px; }
.paw-loader i { display: block; width: 7px; height: 7px; border-radius: 55% 55% 48% 48%; background: var(--app-accent); opacity: .24; animation: step .9s var(--app-ease) infinite; }
.paw-loader i:nth-child(2) { animation-delay: .14s; }
.paw-loader i:nth-child(3) { animation-delay: .28s; }
@keyframes startup-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes breathe { to { transform: translateY(-4px) rotate(-1deg) scale(1.025); } }
@keyframes step { 45% { opacity: .9; transform: translateY(-5px) rotate(12deg); } }
@media (prefers-reduced-motion: reduce) { .startup-mark, .paw-loader i { animation: none; } }
</style>
