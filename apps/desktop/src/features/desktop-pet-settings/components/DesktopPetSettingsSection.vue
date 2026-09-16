<script setup lang="ts">
/**
 * The pet's settings section: the container, with all seven of §5.1's pages behind it.
 *
 * `DesktopPetSettings` is the container and owns the rail, the sessions and the preview; it
 * renders `general` and `notification` itself and takes the other five as slot content, because
 * the five components belong to other tasks and a container that imported them could not have
 * been written until they existed (D7a's own note). They have all landed, and this is the one
 * place that joins them — so the settings panel mounts *one* element and imports *one* module
 * instead of six, and the page list stays where the pages are.
 *
 * **Why it is here and not in `features/settings/`.** §10.1 gives `features/settings` the pet's
 * *section id* and its entry in the rail, and both of those are the settings feature's files. The
 * body is the pet's, and a page that needs the pet's context type has to be next to the pages that
 * take it. What the settings side needs from this file is one import and one element — and the
 * import goes through `features/desktop-pet-settings/index.ts`, not through this path.
 *
 * **The gateway is a prop, not something this component fetches.** It arrives from the composition
 * (`app/desktop-pet-composition.ts`), which is the app's assembly point, so the feature does not
 * reach upward into `app/`. `null` is a state the container already renders as a sentence, which
 * is why the prop is required and nullable rather than optional: a mount site that forgot to pass
 * it should be loud, and "there is no host in this build" should be sayable.
 */
import type { PetGateway, PetSettingsPage } from '../../../platform/gateways/pet-contracts'
import DesktopPetSettings from './DesktopPetSettings.vue'
import PetBubbleSettings from './PetBubbleSettings.vue'
import PetCareSettings from './PetCareSettings.vue'
import PetCharacterSettings from './PetCharacterSettings.vue'
import PetIntegrationSettings from './PetIntegrationSettings.vue'
import PetProjectSettings from './PetProjectSettings.vue'

withDefaults(
  defineProps<{
    /**
     * The host connection, or `null` where this build has none. Required: the composition is the
     * one thing that decides, and a default here would be a second answer to that question.
     */
    gateway: PetGateway | null
    /** §5.1's deep link: the sub-page the pet's right-click named, or a remembered one. */
    page?: PetSettingsPage
  }>(),
  { page: 'general' },
)

defineEmits<{ (e: 'update:page', page: PetSettingsPage): void }>()
</script>

<template>
  <DesktopPetSettings
    :gateway="gateway"
    :page="page"
    @update:page="$emit('update:page', $event)"
  >
    <template #character="{ context }">
      <PetCharacterSettings :context="context" />
    </template>
    <template #bubble="{ context }">
      <PetBubbleSettings :context="context" />
    </template>
    <template #care="{ context }">
      <PetCareSettings :context="context" />
    </template>
    <template #project="{ context }">
      <PetProjectSettings :context="context" />
    </template>
    <template #advanced="{ context }">
      <PetIntegrationSettings :context="context" />
    </template>
  </DesktopPetSettings>
</template>
