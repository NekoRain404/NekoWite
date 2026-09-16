/**
 * The capability report, as a settings page reads it.
 *
 * Three pages ask the same question — the general page when it decides whether a window capability
 * can be offered, the notification page when it says whether a system notification is possible,
 * and the advanced page when it lists what was measured — and they must not answer it three times.
 * This module exists because of the third thing they have to agree on: what to do when the host
 * answered with something that is **not a report at all**.
 *
 * That case is not hypothetical. It is how this was found: the browser build answers every command
 * its stub does not know with `undefined`, the container read that as "the report", and the general
 * page threw `Cannot read properties of undefined` while rendering the roaming control. A fixed
 * `console-clean` walk reached the pet section and the crash became visible — the assertion that
 * had been hiding it could not pass for the right reason, so it could not fail for the right one
 * either.
 *
 * **The guard is here and not in the pages, and it does not collapse the distinction the callers
 * draw.** "A report this build did not receive" and "a capability reported missing" are different
 * claims (§7.2, and `platform.ts`'s own note about `unverified`), and the pages state them
 * differently: an absent report leaves every capability *unreported*, which each page renders with
 * its own "nobody has looked" wording, while a report that names a capability with a non-available
 * finding is the host's own sentence with its detail. Folding the second into the first would be
 * the defect this rule exists to prevent; folding the *first* into the second — inventing a finding
 * for a host that said nothing — is the same mistake from the other side. So the two are kept
 * apart, and what this function removes is only the *throw*: an answer that is not a report is
 * read as no report, which is exactly what it is.
 */
import type { PetSettingsContext } from '../components/DesktopPetSettings.vue'
import type { PetCapabilityReport } from '../../../platform/gateways/pet-contracts'

/**
 * The report the container holds, or an empty one.
 *
 * Empty means "nothing was reported" and never "none of these work": every page renders an
 * unreported capability as unknown, which is the conservative direction, and §7.2's rule is that a
 * capability may not be reported present *or* absent without evidence.
 */
export function reportedCapabilities(
  context: PetSettingsContext,
): readonly PetCapabilityReport[] {
  const report = context.capabilities?.value
  // `Array.isArray` and not a truthiness check: an object, a string or a single finding would all
  // pass `? :` and then fail at `.find` in one page or another. A report is an array or it is not
  // a report.
  return Array.isArray(report) ? report : []
}
