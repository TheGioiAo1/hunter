/**
 * Gbox Platform — Customer Notes Module (Phase 4 PR1)
 *
 * Re-exports the structured-notes timeline service so consumers can
 * depend on a stable facade path even if the internal layout shifts
 * (matches the metafields module pattern).
 */

export {
  addNote,
  listNotes,
  deleteNote,
  countNotes,
  MAX_NOTE_LENGTH,
  MIN_NOTE_LENGTH,
  type CustomerNote,
  type AddCustomerNoteInput,
  type ListCustomerNotesInput,
  type DeleteCustomerNoteInput,
} from './service.js'
