import { $remark } from '@milkdown/utils'
import remarkMath from 'remark-math'

export const mathRemark = $remark('mathRemark', () => remarkMath)
