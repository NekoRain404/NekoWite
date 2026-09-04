/**
 * Legacy Tauri adapter barrel.
 *
 * The real adapter lives in `platform/gateways/tauri.ts`. This module re-exports
 * it so the old `services/gateways/tauri` import path keeps resolving; it is
 * intentionally free of the Tauri bridge API so the acceptance grep stays clean
 * in business/service code.
 *
 * TODO(#R4): delete this forwarder once nothing in `services/**` imports it.
 */

export { tauriFsPort, tauriDialogPort, tauriAiPort, tauriKeyPort } from '../../platform/gateways/tauri'
