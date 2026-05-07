/**
 * Gbox Platform — Shared UI module
 *
 * Barrel re-export for the admin UI layer. Consumers import from
 * `@gbox/core/modules/ui` (or the relative deep path, until the
 * package exports map is wired in a later stage).
 *
 * Phase 2 Step 2.1 shipped:
 *   - theme.ts   → dark/light cookie helpers, flicker-prevent script,
 *                  toggle button HTML + CSS
 *   - logo.ts    → inline SVG Gbox logo (mark / wordmark / combined)
 *
 * Phase 2 Step 2.2 added:
 *   - empty-state.ts → consistent "nothing here yet" / "no results"
 *                      / "no access" / "error" variants with CTA slots
 *   - skeleton.ts    → shimmer placeholders (line / rect / circle /
 *                      table / card-grid / form) for htmx swaps + route
 *                      transitions
 *
 * Phase 2 Step 2.3 adds:
 *   - toast.ts  → flash-cookie + client runtime toast notifications
 *                 (success/error/warning/info) with auto-dismiss, hover
 *                 pause, screen-reader live region
 *   - modal.ts  → <dialog>-based modal template + confirmModal +
 *                 dangerousConfirmModal (Shopify-grade type-to-confirm
 *                 pattern for destructive actions)
 *
 * Phase 2 Step 2.4 adds:
 *   - pagination.ts  → cursor pagination (NOT offset) — encode/decode,
 *                      paginate() helper, prev/next bar, page-size select
 *   - filter-bar.ts  → search box + dropdown filters + active chips +
 *                      buildFilterUrl() canonical URL builder
 *   - bulk-actions.ts → row selection + sticky action bar + confirm-modal
 *                       integration (god-admin-only per Iron Rule #2)
 *
 * Phase 2 Step 2.6 adds:
 *   - keyboard.ts → command palette (Cmd+K), keyboard shortcuts
 *                   cheatsheet (?), go-to prefixes (g p, g o, etc.),
 *                   fuzzy subsequence matching with consecutive bonus
 *
 * Phase 2 Step 2.7 adds:
 *   - activity-timeline.ts → dot-rail timeline + compact sidebar
 *                            variant for the shared ActivityRecord
 *                            type from @gbox/core/modules/activity.
 */

export {
  type Theme,
  type ThemeToggleButtonOptions,
  THEME_COOKIE,
  THEME_DEFAULT,
  THEME_COOKIE_MAX_AGE_SECONDS,
  readThemeFromCookieHeader,
  readThemeFromRequest,
  buildThemeCookie,
  themeInitScript,
  themeToggleScriptBody,
  themeToggleButton,
  themeToggleButtonCss,
} from './theme.js'

export {
  type GboxLogoVariant,
  type GboxLogoOptions,
  gboxLogo,
} from './logo.js'

export {
  type EmptyStateVariant,
  type EmptyStateAction,
  type EmptyStateOptions,
  emptyState,
  emptyStateCss,
} from './empty-state.js'

export {
  type SkeletonVariant,
  type SkeletonLineOptions,
  type SkeletonRectOptions,
  type SkeletonCircleOptions,
  type SkeletonTableOptions,
  type SkeletonCardGridOptions,
  type SkeletonFormOptions,
  skeletonLine,
  skeletonRect,
  skeletonCircle,
  skeletonTable,
  skeletonCardGrid,
  skeletonForm,
  skeletonCss,
} from './skeleton.js'

export {
  type ToastKind,
  type ToastOptions,
  type FlashCookieOptions,
  FLASH_COOKIE,
  buildFlashCookie,
  clearFlashCookie,
  flashContainerHtml,
  toastRuntimeScriptBody,
  toastCss,
} from './toast.js'

export {
  type ModalButton,
  type ModalOptions,
  type ConfirmModalOptions,
  type DangerousConfirmModalOptions,
  modal,
  confirmModal,
  dangerousConfirmModal,
  modalRuntimeScriptBody,
  modalCss,
} from './modal.js'

export {
  type CursorPayload,
  type PaginatedList,
  type PaginateOptions,
  type PaginationBarOptions,
  DEFAULT_PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  decodeCursor,
  clampPageSize,
  paginate,
  paginationBarHtml,
  paginationCss,
} from './pagination.js'

export {
  type FilterOption,
  type FilterDef,
  type FilterBarOptions,
  type ActiveFilterChipsOptions,
  buildFilterUrl,
  filterBar,
  activeFilterChips,
  filterBarCss,
} from './filter-bar.js'

export {
  type BulkAction,
  type BulkCheckboxOptions,
  type BulkActionBarOptions,
  bulkCheckbox,
  bulkHeaderCheckbox,
  bulkActionBar,
  bulkRuntimeScriptBody,
  bulkActionsCss,
} from './bulk-actions.js'

export {
  type CommandItem,
  type KeyboardShortcut,
  type CommandPaletteOptions,
  type KeyboardRuntimeOptions,
  filterCommands,
  commandPaletteHtml,
  keyboardShortcutsHtml,
  keyboardRuntimeScriptBody,
  keyboardCss,
} from './keyboard.js'

export {
  type ActivityTimelineOptions,
  activityTimeline,
  activityTimelineCompact,
  activityTimelineCss,
  relativeTime,
} from './activity-timeline.js'

export {
  skipToMainLink,
  visuallyHidden,
  liveRegionHtml,
  ariaCurrent,
  srOnlyCss,
  skipLinkCss,
  focusRingCss,
  reducedMotionCss,
  a11yCss,
} from './a11y.js'

export {
  type InputType,
  type FieldOptions,
  type TextareaOptions,
  type SelectOption,
  type SelectOptions,
  type CheckboxOptions,
  type SubmitButtonOptions,
  field,
  textarea,
  select,
  checkbox,
  errorSummary,
  submitButton,
  formFieldCss,
} from './form-field.js'

export {
  type NotificationBellOptions,
  type NotificationDrawerOptions,
  notificationBellButton,
  notificationDrawer,
  notificationItem,
  notificationCenterCss,
  notificationCenterScriptBody,
} from './notification-center.js'

export {
  type ErrorPageAction,
  type ErrorPageOptions,
  errorPage,
  notFoundPage,
  forbiddenPage,
  serverErrorPage,
  unauthorizedPage,
  serviceUnavailablePage,
  errorPageCss,
} from './error-page.js'
