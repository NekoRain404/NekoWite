import { getGateways } from './gateways/index'

export type { FileEntry, FsChangeEvent } from './gateways/contracts'

export const fsService = getGateways().fs
