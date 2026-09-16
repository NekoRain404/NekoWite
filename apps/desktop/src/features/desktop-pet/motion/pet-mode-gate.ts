/**
 * Which of the modes this machine may run — and, where it may not, the finding that says so.
 *
 * There is no upstream counterpart to port: upstream never asked whether a mode could work.
 * Its window list came back empty off Windows (`src-tauri/src/sys_windows.rs:128-129`), and
 * `climb` read that emptiness as "nothing to climb" and wandered (`modes.ts:105`) — a mode
 * substituted for another instead of one reported missing. §7.2 requires the opposite
 * (「不伪装已支持」), and its third column is the table below.
 *
 * It sits apart from the modes it decides between (`pet-modes.ts`) because it is the one place
 * in the motion where a capability may conclude that something cannot be done, and a rule that
 * matters that much reads better alone — with `pet-mode-gate.test.ts` beside it.
 */
import type {
  PetCapability,
  PetCapabilityFinding,
  PetCapabilityReport,
  PetFallback,
  PetRoamMode,
} from '../../../platform/gateways/pet-contracts'
import { ROAM_BEHAVIOUR_BY_MODE, type PetRoamBehaviour } from './pet-motion-types'
import type { PetMotionPlatform } from './pet-platform'

/** What a mode needs, or null when it needs nothing. */
interface ModeRequirement {
  capability: PetCapability
  /** §7.2's third column: what is done where the mode cannot run. */
  fallback: PetFallback
}

/**
 * The two gated modes. `stay` and `wander` move the pet's own window inside the work area,
 * which needs no desktop-wide knowledge; the pointer and other applications' windows are what
 * §7.2 gates.
 *
 * That `wander` is not gated at all is a statement, not an oversight: nothing in the capability
 * vocabulary says whether a client may position its own toplevel, which is what Wayland
 * refuses. The port attempts the move and reports the refusal (see the engine's `stepMode`),
 * rather than claiming a capability nobody has verified.
 */
const MODE_REQUIREMENT: { [B in PetRoamBehaviour]: ModeRequirement | null } = {
  stay: null,
  wander: null,
  'follow-pointer': { capability: 'pointer-follow', fallback: 'stay-only' },
  climb: { capability: 'window-climb', fallback: 'not-offered' },
}

/** What will run, and — where the requested mode cannot — the finding that says so. */
export interface RoamModeGate {
  requested: PetRoamMode
  /** The behaviour to run; null when roaming is off. */
  behaviour: PetRoamBehaviour | null
  /** The capability consulted, or null when the mode needs none. */
  capability: PetCapability | null
  /** The finding that decided it, or null when nothing was gated. */
  finding: PetCapabilityFinding | null
}

/**
 * Which mode the pet may run — §7.2's 「保留 stay，其他模式显示不可用」.
 *
 * Three ways a mode fails and all three end in `stay`: the capability is not available,
 * nothing was reported about it, or it was reported available with nothing behind it here.
 * Each carries a finding, because a user who picked "follow cursor" on a desktop that cannot
 * see the pointer is owed the reason rather than an inert pet.
 */
export function gateRoamMode(
  requested: PetRoamMode,
  capabilities: readonly PetCapabilityReport[],
  platform: PetMotionPlatform,
): RoamModeGate {
  // `?? null` covers a stored mode that is not in the vocabulary at all. §5.3 puts range and
  // shape validation in the settings layer (D6), so a value that got past it is a corrupt
  // record rather than a mode, and the safe reading of one is "do not roam".
  const behaviour = ROAM_BEHAVIOUR_BY_MODE[requested] ?? null
  if (behaviour === null) return { requested, behaviour: null, capability: null, finding: null }
  const requirement = MODE_REQUIREMENT[behaviour]
  if (requirement === null) return { requested, behaviour, capability: null, finding: null }

  const { capability, fallback } = requirement
  const reported = capabilities.find((entry) => entry.capability === capability)
  const finding: PetCapabilityFinding = reported?.finding ?? {
    status: 'unverified',
    fallback,
    detail: `nothing was reported for ${capability} on this host, so the pet stays`,
  }
  if (finding.status !== 'available') return { requested, behaviour: 'stay', capability, finding }

  if (!implemented(capability, platform)) {
    return {
      requested,
      behaviour: 'stay',
      capability,
      finding: {
        status: 'unavailable',
        fallback,
        detail: `${capability} is reported available but this host has no implementation for it, so the pet stays`,
      },
    }
  }
  return { requested, behaviour, capability, finding }
}

/** Whether the platform has the machinery the report says was verified. */
function implemented(capability: PetCapability, platform: PetMotionPlatform): boolean {
  if (capability === 'pointer-follow') return platform.readPointer !== undefined
  if (capability === 'window-climb') return platform.readWindowRects !== undefined
  return true
}
