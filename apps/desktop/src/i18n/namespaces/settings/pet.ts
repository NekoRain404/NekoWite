/** The desktop pet's settings pages, assembled from the leaves in ./pet. */
import { page } from './pet/page'
import { general } from './pet/general'
import { character } from './pet/character'
import { bubble } from './pet/bubble'
import { notification } from './pet/notification'
import { preview } from './pet/preview'
import { save } from './pet/save'
import { retry } from './pet/retry'
import { care } from './pet/care'
import { project } from './pet/project'
import { integration } from './pet/integration'
import { capability } from './pet/capability'
import { capabilityStatus } from './pet/capability-status'
import { capabilityFallback } from './pet/capability-fallback'

export const pet = {
  en: {
    /* The pet's own screens (plan §5.1). Under `settings` rather than in a namespace of its
       own because that is where every other settings page's wording already lives, and the
       namespace barrels are the integrator's file. The online catalogue is nested inside
       `character` in the source catalogue, so its wording lives in that leaf. */
    pet: {
      ...page.en,
      ...general.en,
      ...character.en,
      ...bubble.en,
      ...notification.en,
      ...preview.en,
      ...save.en,
      ...retry.en,
      ...care.en,
      ...project.en,
      ...integration.en,
      ...capability.en,
      ...capabilityStatus.en,
      ...capabilityFallback.en,
    },
  },
  zh: {
    pet: {
      ...page.zh,
      ...general.zh,
      ...character.zh,
      ...bubble.zh,
      ...notification.zh,
      ...preview.zh,
      ...save.zh,
      ...retry.zh,
      ...care.zh,
      ...project.zh,
      ...integration.zh,
      ...capability.zh,
      ...capabilityStatus.zh,
      ...capabilityFallback.zh,
    },
  },
} as const
