/**
 * Gbox Platform — Page Builder Module
 *
 * Full visual page builder for the storefront. Provides:
 *   - Section schema registry (22 built-in sections)
 *   - Auto-sectionize pipeline (raw HTML → editable sections)
 *   - CRUD service for sections, settings, versions
 *   - Editor bridge script (injected into preview iframe)
 *
 * @module page-builder
 */

// ── Section Registry ────────────────────────────────────────────
export {
  BUILTIN_SECTIONS,
  getBuiltinSections,
  getSectionByType,
  getSectionsByCategory,
  type SettingType,
  type SettingDefinition,
  type BlockDefinition,
  type SectionSchema,
} from './section-registry.js'

// ── Auto-Sectionize ─────────────────────────────────────────────
export {
  autoSectionize,
  type SectionizeResult,
  type ExtractedSection,
  type SectionizeOptions,
} from './auto-sectionize.js'

// ── Service (CRUD) ──────────────────────────────────────────────
export {
  // Section schemas
  seedBuiltinSections,
  listSectionSchemas,
  getSectionSchema,
  // Page sections CRUD
  listPageSections,
  getPageSection,
  addPageSection,
  updateSectionSettings,
  updateSectionBlocks,
  updateSectionCss,
  toggleSection,
  deletePageSection,
  reorderSections,
  duplicateSection,
  // Global settings
  getGlobalSettings,
  updateGlobalSettings,
  initGlobalSettings,
  // Versions
  createVersion,
  publishVersion,
  listVersions,
  restoreVersion,
  // Auto-sectionize integration
  sectionizeAndSave,
  // Types
  type SectionSchemaRow,
  type PageSectionRow,
  type GlobalSettingsRow,
  type ThemeVersionRow,
} from './service.js'

// ── Editor Bridge (client-side injection script) ────────────────
export {
  getEditorBridgeScript,
} from './editor-bridge.js'
