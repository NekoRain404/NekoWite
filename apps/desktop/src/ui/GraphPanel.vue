<!--
  Compatibility shim, ONE stage only (§10.1.5).

  The panel moved to `features/graph/components/GraphPanel.vue` and its callers
  import it from the feature's public entry (`features/graph/index.ts`). This
  file keeps the old `./GraphPanel.vue` path resolving for one stage so an
  import this change did not reach cannot break, and is deleted with the rest
  of the compatibility layer once nothing imports it.
-->
<script lang="ts">
import { GraphPanel } from '../features/graph'

export default GraphPanel
</script>
