<!--
  Compatibility shim, ONE stage only (§10.1.5).

  The sidebar moved to `features/sidebar/components/AppSidebar.vue` and its
  caller imports it from the feature's public entry (`features/sidebar/index.ts`).
  This file keeps the old `./AppSidebar.vue` path resolving for one stage so an
  import this change did not reach cannot break, and is deleted with the rest of
  the compatibility layer once nothing imports it. `styles/motion.test.ts` reads
  this path as text; its surface list moves to the feature's components in the
  same follow-up.
-->
<script lang="ts">
import { AppSidebar } from '../features/sidebar'

export default AppSidebar
</script>
