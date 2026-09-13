/**
 * Types shared inside the settings feature (§13.9).
 *
 * `SettingsSectionId` is the contract between the navigation rail and the panel
 * that switches sections: the rail owns the table of sections it renders, and
 * the panel owns the `v-if` that shows one, so the union is the one place the
 * two are checked against each other.
 */
export type SettingsSectionId = 'general' | 'appearance' | 'editor' | 'export' | 'ai' | 'plugins'
