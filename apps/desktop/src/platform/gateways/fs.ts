/**
 * Thin fs convenience re-export for application services.
 *
 * Resolves the filesystem port from the runtime-owned shared gateways — the
 * single composition-root cache. This is the only place an application module
 * may reach for a global fs port; business/feature code should prefer to
 * receive an `FsPort`/`FsGateway` through `createGateways(deps)` / the injected
 * `DesktopRuntime`, falling back to this module only when dependency injection
 * is impractical (module-singleton services, Pinia stores).
 */

import { getSharedGateways } from '../runtime/gateway-runtime'

export const fsService = getSharedGateways().fs

export type { FsChangeEvent, FileEntry } from './contracts'
