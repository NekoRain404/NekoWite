<!--
  Compatibility shim, ONE stage only (§10.1.5).

  The panel moved to `features/notes/components/NoteListPanel.vue` and its
  callers import it from the feature's public entry (`features/notes/index.ts`).
  This file keeps the old `./NoteListPanel.vue` path resolving for one stage so
  an import this change did not reach cannot break, and is deleted with the rest
  of the compatibility layer once nothing imports it.
-->
<script lang="ts">
import { NoteListPanel } from '../features/notes'

export default NoteListPanel
</script>
