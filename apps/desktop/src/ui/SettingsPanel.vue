<!--
  Compatibility shim, ONE stage only (§10.1.5).

  The panel moved to `features/settings/components/SettingsPanel.vue` and its
  callers import it from the feature's public entry (`features/settings/index.ts`).
  This file keeps the old `./SettingsPanel.vue` path resolving for one stage so
  an import this change did not reach cannot break, and is deleted with the rest
  of the compatibility layer once nothing imports it.
-->
<script lang="ts">
import { SettingsPanel } from '../features/settings'

export default SettingsPanel
</script>
