/**
 * Gbox Platform — Shared Modal / Confirmation Dialog (Phase 2 Step 2.3)
 *
 * The one destructive-action pattern every admin surface needs:
 *   "Are you sure you want to delete this store?"
 *   [Cancel]  [Delete store]
 *
 * Before Stage 2.3, god-admin used `confirm('...')` (browser native,
 * ugly, no CSS control) and store-admin used a bespoke `<dialog>` in
 * two pages. Neither was consistent, neither supported the Shopify
 * "type STORE_NAME to confirm" pattern for truly destructive actions.
 *
 * This module ships three concentric things:
 *   1. `modal()` — a general-purpose dialog template with a title,
 *      body slot, and action buttons.
 *   2. `confirmModal()` — a convenience wrapper that renders a
 *      "Cancel / Confirm" dialog with optional destructive styling.
 *   3. `dangerousConfirmModal()` — the Shopify-grade pattern: the
 *      confirm button is disabled until the user types a matching
 *      string (e.g. the store slug). Zero chance of a fat-fingered
 *      deletion.
 *
 * All three return HTML strings safe to embed in SSR templates. The
 * runtime script `modalRuntimeScriptBody()` handles open/close/escape/
 * backdrop-click so any page that wants modal UX just inlines the
 * script once.
 *
 * Triết lý: "clone giống hệt Shopify" (same destructive-action
 * pattern with type-to-confirm) + "power-ful hơn Shopify nhờ Claude"
 * (one typed helper per pattern instead of hand-rolling 20 dialogs).
 */

export interface ModalButton {
  /** Visible label. */
  label: string
  /** `primary` (filled accent) | `secondary` (outlined) | `danger` (filled red). Default: 'secondary'. */
  kind?: 'primary' | 'secondary' | 'danger'
  /**
   * One of: `href` (renders <a>), `onclick` (JS snippet), or `close`
   * (shortcut for `onclick="gboxCloseModal('<id>')"`). Exactly one
   * should be set. If none, renders as a disabled button.
   */
  href?: string
  onclick?: string
  close?: boolean
  /** HTML id for keyboard focus targeting. Optional. */
  id?: string
  /** Disabled at render time (used by dangerous-confirm). */
  disabled?: boolean
  /** Form id this button submits. Optional. */
  form?: string
  /** Button type. Default: 'button'. */
  type?: 'button' | 'submit'
}

export interface ModalOptions {
  /** HTML id for the <dialog> root. Required — used by open/close fns. */
  id: string
  /** Big bold line at the top. */
  title: string
  /** Optional muted subtitle. */
  description?: string
  /** Body HTML. Trusted — caller is responsible for escaping any user input. */
  body?: string
  /** Button row at the bottom. Rendered right-aligned. */
  actions?: ModalButton[]
  /** Extra class on the root dialog. */
  className?: string
  /** Width variant. Default: 'md'. */
  size?: 'sm' | 'md' | 'lg'
}

export interface ConfirmModalOptions {
  id: string
  title: string
  description?: string
  /** Cancel button label. Default: 'Cancel'. */
  cancelLabel?: string
  /** Confirm button label. Default: 'Confirm'. */
  confirmLabel?: string
  /** Render the confirm button as destructive (red). Default: false. */
  destructive?: boolean
  /** Form id the confirm button submits. If omitted, caller provides `onConfirm`. */
  form?: string
  /** JS snippet the confirm button runs. Alternative to `form`. */
  onConfirm?: string
  size?: 'sm' | 'md' | 'lg'
}

export interface DangerousConfirmModalOptions {
  id: string
  title: string
  description?: string
  /**
   * The string the user must type to enable the confirm button. e.g.
   * the store slug `acme-store` or the word `DELETE`. Case-sensitive.
   */
  requireType: string
  /** Label above the type-to-confirm input. Default: "Type {requireType} to confirm". */
  promptLabel?: string
  cancelLabel?: string
  /** Confirm button label. Default: 'Delete'. */
  confirmLabel?: string
  /** Form id the confirm button submits. Recommended for destructive actions (CSRF lives in the form). */
  form: string
  /** Modal size — forwarded to the underlying `modal()` shell. */
  size?: 'sm' | 'md' | 'lg'
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderButton(modalId: string, btn: ModalButton): string {
  const kind = btn.kind ?? 'secondary'
  const cls = `gbox-modal-btn gbox-modal-btn-${kind}`
  const label = esc(btn.label)
  const idAttr = btn.id ? ` id="${esc(btn.id)}"` : ''
  const disabled = btn.disabled ? ' disabled' : ''

  if (btn.href) {
    return `<a href="${esc(btn.href)}" class="${cls}"${idAttr}>${label}</a>`
  }

  const type = btn.type ?? 'button'
  const formAttr = btn.form ? ` form="${esc(btn.form)}"` : ''

  if (btn.close) {
    return `<button type="${type}" class="${cls}"${idAttr}${disabled} onclick="gboxCloseModal('${esc(modalId)}')">${label}</button>`
  }

  if (btn.onclick) {
    return `<button type="${type}" class="${cls}"${idAttr}${disabled}${formAttr} onclick="${esc(btn.onclick)}">${label}</button>`
  }

  // Submit button (form=... handles the action)
  if (type === 'submit') {
    return `<button type="submit" class="${cls}"${idAttr}${disabled}${formAttr}>${label}</button>`
  }

  // Inert button
  return `<button type="button" class="${cls}"${idAttr} disabled>${label}</button>`
}

/**
 * Render a general-purpose modal dialog. Use `<dialog>` semantics so
 * we get focus trapping + Escape-to-close for free in modern browsers.
 * The runtime script adds backdrop-click to close + older-browser
 * fallback.
 */
export function modal(options: ModalOptions): string {
  const size = options.size ?? 'md'
  const className = options.className ?? ''
  const actionsHtml = (options.actions ?? [])
    .map((btn) => renderButton(options.id, btn))
    .join('')
  const bodyHtml = options.body ?? ''
  const description = options.description
    ? `<p class="gbox-modal-description">${esc(options.description)}</p>`
    : ''

  return (
    `<dialog id="${esc(options.id)}" class="gbox-modal gbox-modal-${size} ${className}" ` +
    `aria-labelledby="${esc(options.id)}-title" aria-modal="true">` +
    `<div class="gbox-modal-header">` +
    `<h2 class="gbox-modal-title" id="${esc(options.id)}-title">${esc(options.title)}</h2>` +
    `<button type="button" class="gbox-modal-close" aria-label="Close" onclick="gboxCloseModal('${esc(options.id)}')">&times;</button>` +
    `</div>` +
    `<div class="gbox-modal-body">` +
    description +
    bodyHtml +
    `</div>` +
    (actionsHtml
      ? `<div class="gbox-modal-actions">${actionsHtml}</div>`
      : '') +
    `</dialog>`
  )
}

/**
 * Confirmation modal convenience — the 80% case. Caller passes either
 * a `form` id (most common, CSRF-safe) or an `onConfirm` JS snippet.
 */
export function confirmModal(options: ConfirmModalOptions): string {
  const destructive = options.destructive ?? false
  const confirmLabel = options.confirmLabel ?? 'Confirm'
  const cancelLabel = options.cancelLabel ?? 'Cancel'

  const confirmBtn: ModalButton = options.form
    ? {
        label: confirmLabel,
        kind: destructive ? 'danger' : 'primary',
        type: 'submit',
        form: options.form,
      }
    : {
        label: confirmLabel,
        kind: destructive ? 'danger' : 'primary',
        onclick: options.onConfirm ?? '',
      }

  return modal({
    id: options.id,
    title: options.title,
    description: options.description,
    size: options.size,
    actions: [{ label: cancelLabel, kind: 'secondary', close: true }, confirmBtn],
  })
}

/**
 * Dangerous confirmation modal — the Shopify "type STORE_NAME to
 * delete" pattern. The confirm button is disabled until the user
 * types the exact `requireType` string. A tiny inline script wires
 * the input's `input` event to toggle the button's `disabled` attr.
 *
 * We emit the input + enabling script inline rather than relying on
 * the runtime script, so this modal works even if the runtime bundle
 * fails to load.
 */
export function dangerousConfirmModal(
  options: DangerousConfirmModalOptions,
): string {
  const confirmLabel = options.confirmLabel ?? 'Delete'
  const cancelLabel = options.cancelLabel ?? 'Cancel'
  const promptLabel =
    options.promptLabel ?? `Type ${options.requireType} to confirm`
  const inputId = `${options.id}-type-confirm`
  const btnId = `${options.id}-confirm-btn`
  const requireTypeJs = JSON.stringify(options.requireType)

  const body =
    `<label class="gbox-modal-label" for="${esc(inputId)}">${esc(promptLabel)}</label>` +
    `<input type="text" id="${esc(inputId)}" class="gbox-modal-input" ` +
    `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ` +
    `oninput="(function(e){var btn=document.getElementById('${esc(btnId)}');if(btn){btn.disabled=(e.target.value!==${requireTypeJs});}})(event)">`

  return modal({
    id: options.id,
    title: options.title,
    description: options.description,
    size: options.size,
    body,
    actions: [
      { label: cancelLabel, kind: 'secondary', close: true },
      {
        label: confirmLabel,
        kind: 'danger',
        type: 'submit',
        form: options.form,
        id: btnId,
        disabled: true,
      },
    ],
  })
}

/**
 * Runtime script body (no surrounding <script>). Defines:
 *   - window.gboxOpenModal(id)  — opens the dialog + focuses first btn
 *   - window.gboxCloseModal(id) — closes the dialog
 *   - Backdrop click closes
 *   - Escape key closes (in addition to <dialog>'s native handler)
 */
export function modalRuntimeScriptBody(): string {
  return `
    (function(){
      function getDialog(id) {
        return document.getElementById(id);
      }

      window.gboxOpenModal = function(id) {
        var d = getDialog(id);
        if (!d) return;
        if (typeof d.showModal === 'function') {
          d.showModal();
        } else {
          // Fallback for browsers that don't support <dialog>
          d.setAttribute('open', '');
          d.classList.add('gbox-modal-fallback-open');
        }
        // Focus the first focusable in the action row, or the first
        // input if this is a dangerous-confirm modal.
        setTimeout(function(){
          var input = d.querySelector('.gbox-modal-input');
          if (input) { input.focus(); return; }
          var btn = d.querySelector('.gbox-modal-btn-primary, .gbox-modal-btn-danger, .gbox-modal-btn');
          if (btn) btn.focus();
        }, 10);
      };

      window.gboxCloseModal = function(id) {
        var d = getDialog(id);
        if (!d) return;
        if (typeof d.close === 'function') {
          d.close();
        } else {
          d.removeAttribute('open');
          d.classList.remove('gbox-modal-fallback-open');
        }
      };

      // Backdrop-click to close — native <dialog> doesn't do this by
      // default. We detect clicks directly on the <dialog> element
      // (not on a child).
      document.addEventListener('click', function(e){
        var target = e.target;
        if (target && target.tagName === 'DIALOG' && target.classList.contains('gbox-modal')) {
          var rect = target.getBoundingClientRect();
          var inDialog = (
            e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom
          );
          if (!inDialog) {
            window.gboxCloseModal(target.id);
          }
        }
      });
    })();
  `
}

export function modalCss(): string {
  return `
    .gbox-modal {
      padding: 0;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      border-radius: 12px;
      background: var(--god-surface, #1f2937);
      color: var(--god-text, #f3f4f6);
      box-shadow: 0 25px 50px rgba(0,0,0,0.5);
      max-width: 90vw;
      max-height: 85vh;
      overflow: hidden;
      font-family: inherit;
    }
    .gbox-modal::backdrop {
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(2px);
    }
    .gbox-modal-sm { width: 360px; }
    .gbox-modal-md { width: 480px; }
    .gbox-modal-lg { width: 640px; }

    .gbox-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px 8px;
    }
    .gbox-modal-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--god-text, #f3f4f6);
      margin: 0;
    }
    .gbox-modal-close {
      background: transparent;
      border: none;
      color: var(--god-text-secondary, #9ca3af);
      font-size: 24px;
      line-height: 1;
      cursor: pointer;
      padding: 0 6px;
      font-family: inherit;
    }
    .gbox-modal-close:hover { color: var(--god-text, #f3f4f6); }
    .gbox-modal-close:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
      border-radius: 2px;
    }

    .gbox-modal-body {
      padding: 0 20px 8px;
      max-height: 60vh;
      overflow-y: auto;
      font-size: 13px;
      line-height: 1.55;
      color: var(--god-text-secondary, #cbd5e1);
    }
    .gbox-modal-description {
      margin: 0 0 16px;
      color: var(--god-text-secondary, #cbd5e1);
    }
    .gbox-modal-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--god-text, #f3f4f6);
      margin-bottom: 6px;
    }
    .gbox-modal-input {
      width: 100%;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--god-border, rgba(255,255,255,0.1));
      background: var(--god-bg, #0f172a);
      color: var(--god-text, #f3f4f6);
      font-size: 13px;
      font-family: inherit;
      box-sizing: border-box;
    }
    .gbox-modal-input:focus {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 0;
      border-color: var(--god-accent, #3b82f6);
    }

    .gbox-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 16px 20px 20px;
      border-top: 1px solid var(--god-border, rgba(255,255,255,0.05));
      margin-top: 8px;
    }
    .gbox-modal-btn {
      display: inline-flex;
      align-items: center;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 6px;
      text-decoration: none;
      border: 1px solid transparent;
      cursor: pointer;
      transition: transform 0.1s ease, box-shadow 0.1s ease, background 0.1s ease;
      font-family: inherit;
    }
    .gbox-modal-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .gbox-modal-btn-primary {
      background: var(--god-accent, #3b82f6);
      color: #ffffff;
    }
    .gbox-modal-btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(59,130,246,0.3);
    }
    .gbox-modal-btn-secondary {
      background: transparent;
      color: var(--god-text, #f3f4f6);
      border-color: var(--god-border, rgba(255,255,255,0.15));
    }
    .gbox-modal-btn-secondary:hover:not(:disabled) {
      background: var(--god-border-light, rgba(255,255,255,0.04));
    }
    .gbox-modal-btn-danger {
      background: var(--god-danger, #ef4444);
      color: #ffffff;
    }
    .gbox-modal-btn-danger:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(239,68,68,0.35);
    }
    .gbox-modal-btn:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
    }

    /* Fallback for older browsers without <dialog> support */
    .gbox-modal-fallback-open {
      display: block;
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 9500;
    }
  `
}
