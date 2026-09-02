import { getGateways } from './gateways/index'

export type { FileEntry, FsChangeEvent } from './gateways'

export const fsService = getGateways().fs
