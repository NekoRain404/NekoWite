<script setup lang="ts">
/**
 * §8's 在线角色库 — the community catalogue, browsed and installed from the character page.
 *
 * Its own component rather than a block inside `PetCharacterSettings.vue`, and for the reason
 * §13.1 gives: the page is about the character on screen, this is about a document written by
 * strangers and served by a host this app does not operate, and the two change for different
 * reasons. The split is also what keeps the page inside its budget — this file is the half that
 * grew.
 *
 * **Four things a user can see, and each is a different sentence.** A read that has not happened
 * (`unasked`), a build with no endpoint, a catalogue that could not be reached or could not be read
 * — each with the host's own diagnostic underneath — and a list. They are kept apart because the
 * alternative is the defect the whole vocabulary exists for: upstream's `loadCatalog` returns `[]`
 * on every failure (`catalog.ts:24-30`, ledger §7.5), which makes "offline", "empty" and "corrupt"
 * one answer and tells the user the wrong one of the three.
 *
 * **What a download looks like while it happens, and what it leaves behind.** One row at a time:
 * the button becomes a sentence and every row is disabled, so a second click cannot start a second
 * transfer. On failure the *list stays* — a banner appears under it with the host's own sentence,
 * which names which of §8's four checks refused — because a failed download that blanked the
 * gallery would take away the user's ability to pick a different character over one bad row. On
 * success the row's character is emitted upward: the page above owns the library read and the
 * selection, so this component never forms its own opinion about what is installed.
 *
 * **The terms are stated and never enforced.** Every entry of every catalogue available today
 * states none, and the row says so; the install is not blocked on it (see `pet-catalogue.ts`'s
 * header — the decision is the maintainer's, deferred). This component's whole part in that is to
 * not hide it.
 */
import { computed, onMounted, ref, shallowRef } from 'vue'
import { t } from '../../../i18n'
import type { PetCharacterEntry, PetCatalogueOffer } from '../../../platform/gateways/pet-contracts'
import {
  CATALOGUE_VISIBLE_LIMIT,
  catalogueKinds,
  filterCatalogueOffers,
  statesTerms,
  type PetCatalogueState,
} from '../../desktop-pet/services/pet-catalogue'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

const props = defineProps<{
  /** The container's context, as every page under it receives one. */
  context: PetSettingsContext
}>()

const emit = defineEmits<{
  /** A character was installed by the catalogue. The page above selects it. */
  installed: [entry: PetCharacterEntry]
}>()

/**
 * The catalogue as the host answered it, or `null` before it has been asked.
 *
 * Null and `empty` are different answers and are drawn differently: one is "we have not asked", the
 * other is "the catalogue lists nothing". A component that started at `empty` would say the second
 * before it knew it.
 */
const catalogue = shallowRef<PetCatalogueState | null>(null)
const reading = ref(false)
const query = ref('')
const kind = ref<string | null>(null)
/** The slug being downloaded, or null. One at a time: a second transfer is a second dialog. */
const downloading = ref<string | null>(null)
const failure = ref<string | null>(null)

const offers = computed<readonly PetCatalogueOffer[]>(() =>
  catalogue.value?.status === 'listed' ? catalogue.value.offers : [],
)

/** The category buttons, from the words the offers actually use. Empty means no filter is drawn. */
const kinds = computed(() => catalogueKinds(offers.value))

const matches = computed(() => filterCatalogueOffers(offers.value, query.value, kind.value))
const shown = computed(() => matches.value.slice(0, CATALOGUE_VISIBLE_LIMIT))

/** How many entries the catalogue listed that this build cannot install. */
const skipped = computed(() =>
  catalogue.value !== null && 'skipped' in catalogue.value ? catalogue.value.skipped : 0,
)

/** The host's own diagnostic, on the two arms that carry one. */
const detail = computed(() =>
  catalogue.value !== null && 'detail' in catalogue.value ? catalogue.value.detail : null,
)

async function read(): Promise<void> {
  reading.value = true
  failure.value = null
  try {
    catalogue.value = await props.context.gateway.catalogue()
  } catch (cause) {
    // A rejection is the call failing rather than the catalogue failing, and it is stated as
    // `unreachable` because that is the arm the page has a sentence for — with the caller's own
    // message underneath, so a wiring fault is not dressed up as a network one.
    catalogue.value = {
      status: 'unreachable',
      detail: cause instanceof Error ? cause.message : String(cause),
    }
  } finally {
    reading.value = false
  }
}

/**
 * Install one offer.
 *
 * The slug is the whole request: no address crosses the boundary, and the host re-reads the
 * catalogue to resolve it. A refusal is a rejection with the host's sentence, which names what
 * refused — it is never retried here and never left hanging, because §8's rules refuse *before* a
 * request is made.
 */
async function install(offer: PetCatalogueOffer): Promise<void> {
  downloading.value = offer.slug
  failure.value = null
  try {
    emit('installed', await props.context.gateway.adoptCharacter(offer.slug))
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    downloading.value = null
  }
}

function pick(value: string | null): void {
  kind.value = value
}

// Read when the section opens, and only then — the same rule the page above keeps: a page that is
// not on screen should not read.
onMounted(() => void read())
</script>

<template>
  <section class="catalogue">
    <span class="settings-label">{{ t('settings.pet.character.catalogue.title') }}</span>
    <span class="settings-note">{{ t('settings.pet.character.catalogue.note') }}</span>

    <p
      v-if="catalogue !== null && catalogue.status !== 'listed'"
      class="settings-note pet-absent"
      data-test="pet-catalogue-state"
      :data-status="catalogue.status"
    >
      {{ t(`settings.pet.character.catalogue.state.${catalogue.status}`) }}
      <button
        v-if="catalogue.status === 'unreachable' || catalogue.status === 'unreadable'"
        class="btn btn-secondary btn-sm catalogue__retry"
        type="button"
        :disabled="reading"
        data-test="pet-catalogue-reload"
        @click="read"
      >
        {{ t('settings.pet.character.catalogue.reload') }}
      </button>
    </p>
    <p
      v-if="detail !== null"
      class="settings-note pet-absent"
      data-test="pet-catalogue-detail"
    >
      {{ t('settings.pet.character.catalogue.detail', { detail }) }}
    </p>

    <template v-if="catalogue?.status === 'listed'">
      <input
        class="input catalogue__search"
        type="search"
        :value="query"
        :placeholder="t('settings.pet.character.catalogue.search')"
        data-test="pet-catalogue-search"
        @input="query = ($event.target as HTMLInputElement).value"
      >
      <!-- The category words are the catalogue's own, shown verbatim: they are data the document
           carries, not a vocabulary this build has translations for, and inventing four fixed
           categories would drop every entry whose `kind` is a fifth word. -->
      <div
        v-if="kinds.length > 1"
        class="catalogue__kinds"
        data-test="pet-catalogue-kinds"
      >
        <button
          class="btn btn-secondary btn-sm"
          type="button"
          :aria-pressed="kind === null"
          data-test="pet-catalogue-kind-all"
          @click="pick(null)"
        >
          {{ t('settings.pet.character.catalogue.kindAll') }}
        </button>
        <button
          v-for="word in kinds"
          :key="word"
          class="btn btn-secondary btn-sm"
          type="button"
          :aria-pressed="kind === word"
          :data-test="`pet-catalogue-kind-${word}`"
          @click="pick(word)"
        >
          {{ word }}
        </button>
      </div>

      <span
        class="settings-note"
        data-test="pet-catalogue-count"
      >{{ t('settings.pet.character.catalogue.count', { shown: shown.length, total: matches.length }) }}</span>
      <p
        v-if="skipped > 0"
        class="settings-note"
        data-test="pet-catalogue-skipped"
      >
        {{ t('settings.pet.character.catalogue.skipped', { count: skipped }) }}
      </p>
      <p
        v-if="matches.length === 0"
        class="settings-note"
        data-test="pet-catalogue-no-matches"
      >
        {{ t('settings.pet.character.catalogue.noMatches') }}
      </p>

      <div
        class="catalogue__list"
        data-test="pet-catalogue-list"
      >
        <div
          v-for="offer in shown"
          :key="offer.slug"
          class="catalogue__row"
          :data-test="`pet-catalogue-row-${offer.slug}`"
          :data-terms="statesTerms(offer) ? 'stated' : 'unstated'"
        >
          <span class="catalogue__name">{{ offer.name }}</span>
          <span class="catalogue__id">{{ offer.slug }}</span>
          <span
            v-if="offer.author !== null"
            class="settings-note"
          >{{ t('settings.pet.character.catalogue.by', { author: offer.author }) }}</span>
          <span
            class="settings-note"
          >{{ statesTerms(offer)
            ? t('settings.pet.character.catalogue.termsStated', { terms: offer.terms ?? '' })
            : t('settings.pet.character.catalogue.termsUnstated') }}</span>
          <button
            class="btn btn-secondary btn-sm catalogue__get"
            type="button"
            :disabled="downloading !== null"
            :data-test="`pet-catalogue-install-${offer.slug}`"
            @click="install(offer)"
          >
            {{ downloading === offer.slug
              ? t('settings.pet.character.catalogue.downloading')
              : t('settings.pet.character.catalogue.install') }}
          </button>
        </div>
      </div>

      <p
        v-if="failure !== null"
        class="settings-note pet-absent"
        data-test="pet-catalogue-failure"
      >
        {{ t('settings.pet.character.catalogue.installFailed', { msg: failure }) }}
      </p>
    </template>
  </section>
</template>

<style scoped>
/* Restated here for the reason `PetGeneralSettings.vue` restates its own: a scoped block belongs to
   the component that renders the element. */
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}

.catalogue { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.catalogue__search { font-size: 12px; }
.catalogue__kinds { display: flex; flex-wrap: wrap; gap: 6px; }

.catalogue__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* The list scrolls rather than the page: a page that grew by four thousand rows would push the
     size slider and the save state off the bottom. */
  max-height: 320px;
  overflow-y: auto;
}
.catalogue__row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius, 6px);
  background: var(--app-panel);
  font-size: 12px;
}
.catalogue__name { color: var(--app-text); overflow-wrap: anywhere; }
.catalogue__id {
  color: var(--app-muted);
  font-family: var(--app-mono-font, monospace);
  font-size: 10px;
  overflow-wrap: anywhere;
}
.catalogue__get { align-self: flex-start; margin-top: 2px; }
.catalogue__retry { margin-left: 6px; }

.pet-absent {
  border-left: 2px solid var(--app-warn);
  padding-left: 8px;
}
</style>
