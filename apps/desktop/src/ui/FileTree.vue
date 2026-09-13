<!--
  Compatibility shim, ONE stage only (§10.1.5).

  The tree moved to `features/vault/components/FileTree.vue` and its callers go
  through the feature's public entry (`features/vault/index.ts`). This file
  keeps the old `./FileTree.vue` path resolving for one stage so an import this
  change did not reach cannot break, and is deleted with the rest of the
  compatibility layer once nothing imports it.
-->
<script lang="ts">
import FileTree from '../features/vault/components/FileTree.vue'

export default FileTree
</script>
