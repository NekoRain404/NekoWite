<script setup lang="ts">
import { useGhostWriterShortcut } from '../composables/use-ghost-writer-shortcut'

// Display and event forwarding only (§10.2). The Tab/Escape shortcut needs the
// settings and AI-permission stores to decide whether there is a model to ask
// and whether a write is allowed, which a components module must not read — so
// the whole interaction lives in the composable and this component only mounts
// it for as long as the marker is on screen.
useGhostWriterShortcut()
</script>

<template>
  <div
    class="ghost-writer"
    aria-hidden="true"
  />
</template>
