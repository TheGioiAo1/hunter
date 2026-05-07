/**
 * @gbox/core/modules/db — shared database helpers.
 *
 * Phase 15 PR1: `withSerializable` for data-integrity-critical sections.
 */

export {
  withSerializable,
  isRetryableSerializationError,
  type WithSerializableOptions,
} from './transaction.js'
