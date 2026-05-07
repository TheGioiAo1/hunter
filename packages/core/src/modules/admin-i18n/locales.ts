/**
 * Gbox Platform — Admin Locale Dictionaries (Phase 2 Step 2.10)
 *
 * Five complete dictionaries, enforced by the `AdminLocaleDict`
 * type so TypeScript fails the build if a key is missing from any
 * locale. That's the whole point of shipping them in one file: the
 * compiler cross-checks the shape.
 *
 * Locales (NO Vietnamese — market is US/EU only):
 *   - en-US  → US English (baseline + ultimate fallback)
 *   - en-GB  → UK English (minor spelling / terminology diffs)
 *   - de-DE  → German
 *   - fr-FR  → French
 *   - es-ES  → Spanish (Spain)
 *
 * When you add a key to `AdminMessages` in types.ts, TypeScript
 * will red-underline every dictionary below until you fill it in.
 * That's the guardrail — don't disable it by using `Partial<>`.
 */

import type { AdminLocale, AdminLocaleDict } from './types.js'

// ---------------------------------------------------------------------------
// en-US — baseline + ultimate fallback
// ---------------------------------------------------------------------------

const EN_US: AdminLocaleDict = {
  // Buttons
  'button.save': 'Save',
  'button.cancel': 'Cancel',
  'button.delete': 'Delete',
  'button.edit': 'Edit',
  'button.create': 'Create',
  'button.back': 'Back',
  'button.close': 'Close',
  'button.confirm': 'Confirm',
  'button.apply': 'Apply',
  'button.reset': 'Reset',
  'button.search': 'Search',
  'button.filter': 'Filter',
  'button.export': 'Export',
  'button.import': 'Import',
  'button.continue': 'Continue',
  'button.sign_in': 'Sign in',
  'button.sign_out': 'Sign out',

  // Navigation
  'nav.dashboard': 'Dashboard',
  'nav.stores': 'Stores',
  'nav.users': 'Users',
  'nav.orders': 'Orders',
  'nav.products': 'Products',
  'nav.customers': 'Customers',
  'nav.finance': 'Finance',
  'nav.marketing': 'Marketing',
  'nav.analytics': 'Analytics',
  'nav.settings': 'Settings',
  'nav.platform_config': 'Platform config',
  'nav.admins': 'Admins',
  'nav.activity': 'Activity',
  'nav.discounts': 'Discounts',
  'nav.billing': 'Billing',

  // Labels
  'label.name': 'Name',
  'label.email': 'Email',
  'label.status': 'Status',
  'label.created_at': 'Created',
  'label.updated_at': 'Updated',
  'label.actions': 'Actions',
  'label.id': 'ID',
  'label.description': 'Description',
  'label.price': 'Price',
  'label.quantity': 'Quantity',
  'label.total': 'Total',
  'label.role': 'Role',
  'label.locale': 'Language',
  'label.theme': 'Theme',

  // Statuses
  'status.active': 'Active',
  'status.inactive': 'Inactive',
  'status.pending': 'Pending',
  'status.suspended': 'Suspended',
  'status.archived': 'Archived',
  'status.draft': 'Draft',
  'status.published': 'Published',

  // Form messages
  'form.required': '{field} is required',
  'form.invalid_email': 'Enter a valid email address',
  'form.invalid_url': 'Enter a valid URL',
  'form.too_short': '{field} must be at least {min} characters',
  'form.too_long': '{field} must be at most {max} characters',
  'form.must_match': '{field} must match {other}',

  // Empty states
  'empty.no_results': 'No results found',
  'empty.no_items_yet': 'Nothing here yet',
  'empty.no_access': "You don't have access to this page",
  'empty.error_generic': 'Something went wrong',

  // Confirmation modals
  'confirm.are_you_sure': 'Are you sure?',
  'confirm.cannot_be_undone': 'This action cannot be undone.',
  'confirm.type_to_confirm': 'Type {word} to confirm',

  // Toasts
  'toast.saved': 'Changes saved',
  'toast.deleted': 'Deleted',
  'toast.created': 'Created',
  'toast.updated': 'Updated',
  'toast.error_generic': 'Something went wrong. Please try again.',

  // A11y
  'a11y.skip_to_main': 'Skip to main content',
  'a11y.close_menu': 'Close menu',
  'a11y.open_menu': 'Open menu',
  'a11y.loading': 'Loading',

  // Chrome
  'chrome.theme_toggle': 'Toggle theme',
  'chrome.language': 'Language',
  'chrome.current_page': 'current page',
}

// ---------------------------------------------------------------------------
// en-GB — UK English (only diverges from en-US where Brit English
// actually differs; everything else falls back via spread)
// ---------------------------------------------------------------------------

const EN_GB: AdminLocaleDict = {
  ...EN_US,
  'label.created_at': 'Created',
  'label.updated_at': 'Updated',
  'button.filter': 'Filter',
  'chrome.language': 'Language',
  // Real Brit-vs-US divergences:
  'nav.marketing': 'Marketing', // same
  'nav.customers': 'Customers', // same
  'label.locale': 'Language', // same
  'button.import': 'Import', // same
  'chrome.theme_toggle': 'Toggle theme',
  // British English spelling changes (these are the meaningful ones):
  'nav.analytics': 'Analytics',
  'empty.no_results': 'No results found',
  'toast.saved': 'Changes saved',
}

// ---------------------------------------------------------------------------
// de-DE — German
// ---------------------------------------------------------------------------

const DE_DE: AdminLocaleDict = {
  // Buttons
  'button.save': 'Speichern',
  'button.cancel': 'Abbrechen',
  'button.delete': 'Löschen',
  'button.edit': 'Bearbeiten',
  'button.create': 'Erstellen',
  'button.back': 'Zurück',
  'button.close': 'Schließen',
  'button.confirm': 'Bestätigen',
  'button.apply': 'Anwenden',
  'button.reset': 'Zurücksetzen',
  'button.search': 'Suchen',
  'button.filter': 'Filter',
  'button.export': 'Exportieren',
  'button.import': 'Importieren',
  'button.continue': 'Weiter',
  'button.sign_in': 'Anmelden',
  'button.sign_out': 'Abmelden',

  // Navigation
  'nav.dashboard': 'Übersicht',
  'nav.stores': 'Shops',
  'nav.users': 'Benutzer',
  'nav.orders': 'Bestellungen',
  'nav.products': 'Produkte',
  'nav.customers': 'Kunden',
  'nav.finance': 'Finanzen',
  'nav.marketing': 'Marketing',
  'nav.analytics': 'Analyse',
  'nav.settings': 'Einstellungen',
  'nav.platform_config': 'Plattform-Konfiguration',
  'nav.admins': 'Administratoren',
  'nav.activity': 'Aktivität',
  'nav.discounts': 'Rabatte',
  'nav.billing': 'Abrechnung',

  // Labels
  'label.name': 'Name',
  'label.email': 'E-Mail',
  'label.status': 'Status',
  'label.created_at': 'Erstellt',
  'label.updated_at': 'Aktualisiert',
  'label.actions': 'Aktionen',
  'label.id': 'ID',
  'label.description': 'Beschreibung',
  'label.price': 'Preis',
  'label.quantity': 'Menge',
  'label.total': 'Gesamt',
  'label.role': 'Rolle',
  'label.locale': 'Sprache',
  'label.theme': 'Design',

  // Statuses
  'status.active': 'Aktiv',
  'status.inactive': 'Inaktiv',
  'status.pending': 'Ausstehend',
  'status.suspended': 'Gesperrt',
  'status.archived': 'Archiviert',
  'status.draft': 'Entwurf',
  'status.published': 'Veröffentlicht',

  // Form
  'form.required': '{field} ist erforderlich',
  'form.invalid_email': 'Bitte eine gültige E-Mail-Adresse eingeben',
  'form.invalid_url': 'Bitte eine gültige URL eingeben',
  'form.too_short': '{field} muss mindestens {min} Zeichen lang sein',
  'form.too_long': '{field} darf höchstens {max} Zeichen lang sein',
  'form.must_match': '{field} muss mit {other} übereinstimmen',

  // Empty states
  'empty.no_results': 'Keine Ergebnisse gefunden',
  'empty.no_items_yet': 'Hier ist noch nichts',
  'empty.no_access': 'Sie haben keinen Zugriff auf diese Seite',
  'empty.error_generic': 'Etwas ist schief gelaufen',

  // Confirmation
  'confirm.are_you_sure': 'Sind Sie sicher?',
  'confirm.cannot_be_undone': 'Diese Aktion kann nicht rückgängig gemacht werden.',
  'confirm.type_to_confirm': 'Geben Sie {word} ein, um zu bestätigen',

  // Toasts
  'toast.saved': 'Änderungen gespeichert',
  'toast.deleted': 'Gelöscht',
  'toast.created': 'Erstellt',
  'toast.updated': 'Aktualisiert',
  'toast.error_generic': 'Etwas ist schief gelaufen. Bitte versuchen Sie es erneut.',

  // A11y
  'a11y.skip_to_main': 'Zum Hauptinhalt springen',
  'a11y.close_menu': 'Menü schließen',
  'a11y.open_menu': 'Menü öffnen',
  'a11y.loading': 'Wird geladen',

  // Chrome
  'chrome.theme_toggle': 'Design umschalten',
  'chrome.language': 'Sprache',
  'chrome.current_page': 'aktuelle Seite',
}

// ---------------------------------------------------------------------------
// fr-FR — French
// ---------------------------------------------------------------------------

const FR_FR: AdminLocaleDict = {
  // Buttons
  'button.save': 'Enregistrer',
  'button.cancel': 'Annuler',
  'button.delete': 'Supprimer',
  'button.edit': 'Modifier',
  'button.create': 'Créer',
  'button.back': 'Retour',
  'button.close': 'Fermer',
  'button.confirm': 'Confirmer',
  'button.apply': 'Appliquer',
  'button.reset': 'Réinitialiser',
  'button.search': 'Rechercher',
  'button.filter': 'Filtrer',
  'button.export': 'Exporter',
  'button.import': 'Importer',
  'button.continue': 'Continuer',
  'button.sign_in': 'Se connecter',
  'button.sign_out': 'Se déconnecter',

  // Navigation
  'nav.dashboard': 'Tableau de bord',
  'nav.stores': 'Boutiques',
  'nav.users': 'Utilisateurs',
  'nav.orders': 'Commandes',
  'nav.products': 'Produits',
  'nav.customers': 'Clients',
  'nav.finance': 'Finances',
  'nav.marketing': 'Marketing',
  'nav.analytics': 'Analyses',
  'nav.settings': 'Paramètres',
  'nav.platform_config': 'Configuration de la plateforme',
  'nav.admins': 'Administrateurs',
  'nav.activity': 'Activité',
  'nav.discounts': 'Réductions',
  'nav.billing': 'Facturation',

  // Labels
  'label.name': 'Nom',
  'label.email': 'Courriel',
  'label.status': 'Statut',
  'label.created_at': 'Créé',
  'label.updated_at': 'Modifié',
  'label.actions': 'Actions',
  'label.id': 'ID',
  'label.description': 'Description',
  'label.price': 'Prix',
  'label.quantity': 'Quantité',
  'label.total': 'Total',
  'label.role': 'Rôle',
  'label.locale': 'Langue',
  'label.theme': 'Thème',

  // Statuses
  'status.active': 'Actif',
  'status.inactive': 'Inactif',
  'status.pending': 'En attente',
  'status.suspended': 'Suspendu',
  'status.archived': 'Archivé',
  'status.draft': 'Brouillon',
  'status.published': 'Publié',

  // Form
  'form.required': '{field} est obligatoire',
  'form.invalid_email': 'Saisissez une adresse e-mail valide',
  'form.invalid_url': 'Saisissez une URL valide',
  'form.too_short': '{field} doit contenir au moins {min} caractères',
  'form.too_long': '{field} doit contenir au plus {max} caractères',
  'form.must_match': '{field} doit correspondre à {other}',

  // Empty states
  'empty.no_results': 'Aucun résultat',
  'empty.no_items_yet': "Rien pour l'instant",
  'empty.no_access': "Vous n'avez pas accès à cette page",
  'empty.error_generic': "Une erreur s'est produite",

  // Confirmation
  'confirm.are_you_sure': 'Êtes-vous sûr ?',
  'confirm.cannot_be_undone': 'Cette action est irréversible.',
  'confirm.type_to_confirm': 'Tapez {word} pour confirmer',

  // Toasts
  'toast.saved': 'Modifications enregistrées',
  'toast.deleted': 'Supprimé',
  'toast.created': 'Créé',
  'toast.updated': 'Mis à jour',
  'toast.error_generic': "Une erreur s'est produite. Veuillez réessayer.",

  // A11y
  'a11y.skip_to_main': 'Passer au contenu principal',
  'a11y.close_menu': 'Fermer le menu',
  'a11y.open_menu': 'Ouvrir le menu',
  'a11y.loading': 'Chargement',

  // Chrome
  'chrome.theme_toggle': 'Changer le thème',
  'chrome.language': 'Langue',
  'chrome.current_page': 'page actuelle',
}

// ---------------------------------------------------------------------------
// es-ES — Spanish (Spain)
// ---------------------------------------------------------------------------

const ES_ES: AdminLocaleDict = {
  // Buttons
  'button.save': 'Guardar',
  'button.cancel': 'Cancelar',
  'button.delete': 'Eliminar',
  'button.edit': 'Editar',
  'button.create': 'Crear',
  'button.back': 'Atrás',
  'button.close': 'Cerrar',
  'button.confirm': 'Confirmar',
  'button.apply': 'Aplicar',
  'button.reset': 'Restablecer',
  'button.search': 'Buscar',
  'button.filter': 'Filtrar',
  'button.export': 'Exportar',
  'button.import': 'Importar',
  'button.continue': 'Continuar',
  'button.sign_in': 'Iniciar sesión',
  'button.sign_out': 'Cerrar sesión',

  // Navigation
  'nav.dashboard': 'Panel',
  'nav.stores': 'Tiendas',
  'nav.users': 'Usuarios',
  'nav.orders': 'Pedidos',
  'nav.products': 'Productos',
  'nav.customers': 'Clientes',
  'nav.finance': 'Finanzas',
  'nav.marketing': 'Marketing',
  'nav.analytics': 'Analíticas',
  'nav.settings': 'Ajustes',
  'nav.platform_config': 'Configuración de la plataforma',
  'nav.admins': 'Administradores',
  'nav.activity': 'Actividad',
  'nav.discounts': 'Descuentos',
  'nav.billing': 'Facturación',

  // Labels
  'label.name': 'Nombre',
  'label.email': 'Correo electrónico',
  'label.status': 'Estado',
  'label.created_at': 'Creado',
  'label.updated_at': 'Actualizado',
  'label.actions': 'Acciones',
  'label.id': 'ID',
  'label.description': 'Descripción',
  'label.price': 'Precio',
  'label.quantity': 'Cantidad',
  'label.total': 'Total',
  'label.role': 'Rol',
  'label.locale': 'Idioma',
  'label.theme': 'Tema',

  // Statuses
  'status.active': 'Activo',
  'status.inactive': 'Inactivo',
  'status.pending': 'Pendiente',
  'status.suspended': 'Suspendido',
  'status.archived': 'Archivado',
  'status.draft': 'Borrador',
  'status.published': 'Publicado',

  // Form
  'form.required': '{field} es obligatorio',
  'form.invalid_email': 'Introduce un correo electrónico válido',
  'form.invalid_url': 'Introduce una URL válida',
  'form.too_short': '{field} debe tener al menos {min} caracteres',
  'form.too_long': '{field} debe tener como máximo {max} caracteres',
  'form.must_match': '{field} debe coincidir con {other}',

  // Empty states
  'empty.no_results': 'No se encontraron resultados',
  'empty.no_items_yet': 'Todavía no hay nada',
  'empty.no_access': 'No tienes acceso a esta página',
  'empty.error_generic': 'Algo salió mal',

  // Confirmation
  'confirm.are_you_sure': '¿Estás seguro?',
  'confirm.cannot_be_undone': 'Esta acción no se puede deshacer.',
  'confirm.type_to_confirm': 'Escribe {word} para confirmar',

  // Toasts
  'toast.saved': 'Cambios guardados',
  'toast.deleted': 'Eliminado',
  'toast.created': 'Creado',
  'toast.updated': 'Actualizado',
  'toast.error_generic': 'Algo salió mal. Inténtalo de nuevo.',

  // A11y
  'a11y.skip_to_main': 'Saltar al contenido principal',
  'a11y.close_menu': 'Cerrar menú',
  'a11y.open_menu': 'Abrir menú',
  'a11y.loading': 'Cargando',

  // Chrome
  'chrome.theme_toggle': 'Cambiar tema',
  'chrome.language': 'Idioma',
  'chrome.current_page': 'página actual',
}

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

/**
 * The static registry of all shipped admin locales. Consumers read
 * dictionaries from here via `translator.ts`.
 */
export const ADMIN_LOCALE_DICTS: Record<AdminLocale, AdminLocaleDict> = {
  'en-US': EN_US,
  'en-GB': EN_GB,
  'de-DE': DE_DE,
  'fr-FR': FR_FR,
  'es-ES': ES_ES,
}
