/**
 * @module page-builder/editor-bridge
 *
 * Client-side editor bridge script for the Gbox page builder.
 * This module exports a single function that returns a self-contained
 * JavaScript IIFE string. The script is injected into the storefront
 * preview iframe when the theme editor is active.
 *
 * It provides:
 * - Section detection and visual overlays (hover/select)
 * - Click-to-select with floating toolbar (move, duplicate, delete, toggle)
 * - Inline text editing via double-click
 * - Image swap indicators
 * - Drag-to-reorder sections
 * - PostMessage communication with the parent editor frame
 */

/**
 * Returns the complete client-side JavaScript for the editor bridge.
 * This script is injected into the storefront preview iframe when
 * the page builder editor is active.
 *
 * The returned string is a complete, self-contained IIFE that:
 * 1. Detects sections in the page
 * 2. Adds hover/click/drag interactions
 * 3. Communicates with the parent editor via postMessage
 */
export function getEditorBridgeScript(adminOrigin?: string): string {
  const safeOrigin = adminOrigin ? JSON.stringify(adminOrigin) : 'null';
  return `(function() {
  "use strict";

  // =========================================================================
  // Guard: only run once
  // =========================================================================
  if (window.__gboxEditorBridge) return;
  window.__gboxEditorBridge = true;

  // Trusted admin origin for postMessage validation
  var ADMIN_ORIGIN = ${safeOrigin};

  // =========================================================================
  // Constants
  // =========================================================================
  var HOVER_ATTR   = "data-gbox-hover";
  var SELECT_ATTR  = "data-gbox-selected";
  var EDIT_ATTR    = "data-gbox-editable";
  var SECTION_ATTR = "data-section-id";
  var TOOLBAR_CLS  = "gbox-section-toolbar";
  var PLACEHOLDER_CLS = "gbox-drag-placeholder";
  var IMG_OVERLAY_CLS = "gbox-image-overlay";
  var ADD_BTN_CLS  = "gbox-add-section-btn";

  // =========================================================================
  // Utility helpers
  // =========================================================================
  function post(msg) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, ADMIN_ORIGIN || "*");
    }
  }

  function slugify(name) {
    return (name || "section").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "section";
  }

  function sectionName(el) {
    return el.getAttribute("data-section-name")
      || el.getAttribute("data-section-type")
      || el.getAttribute(SECTION_ATTR)
      || el.tagName.toLowerCase();
  }

  // Sanitize HTML: strip script tags and on* event attributes
  function sanitizeHtml(html) {
    if (!html) return "";
    return String(html)
      .replace(/<script[\\s\\S]*?<\\/script>/gi, "")
      .replace(/<script[\\s>][^]*$/gi, "")
      .replace(/\\son\\w+\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]*)/gi, "");
  }

  function getElementPath(el, root) {
    var parts = [];
    var cur = el;
    while (cur && cur !== root) {
      var tag = cur.tagName.toLowerCase();
      var idx = 0;
      var sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(tag + (idx > 0 ? "[" + idx + "]" : ""));
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function isTextElement(el) {
    var tag = el.tagName;
    return /^(H[1-6]|P|SPAN|A|LI|LABEL|STRONG|EM|B|I|BLOCKQUOTE|FIGCAPTION|TD|TH|DT|DD)$/i.test(tag);
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom, x: r.x, y: r.y };
  }

  // =========================================================================
  // CSS injection
  // =========================================================================
  function injectStyles() {
    if (document.getElementById("gbox-editor-bridge-styles")) return;
    var style = document.createElement("style");
    style.id = "gbox-editor-bridge-styles";
    style.textContent = [
      // Hover overlay
      "[" + HOVER_ATTR + "] {",
      "  outline: 2px dashed #3b82f6 !important;",
      "  outline-offset: -2px !important;",
      "  position: relative;",
      "}",
      // Selected section
      "[" + SELECT_ATTR + "] {",
      "  outline: 2px solid #2563eb !important;",
      "  outline-offset: -2px !important;",
      "  position: relative;",
      "}",
      // Section toolbar
      "." + TOOLBAR_CLS + " {",
      "  position: absolute;",
      "  top: -36px;",
      "  left: 0;",
      "  right: 0;",
      "  height: 32px;",
      "  background: #2563eb;",
      "  color: white;",
      "  display: flex;",
      "  align-items: center;",
      "  padding: 0 8px;",
      "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
      "  font-size: 12px;",
      "  gap: 4px;",
      "  z-index: 99999;",
      "  border-radius: 4px 4px 0 0;",
      "  box-shadow: 0 -2px 8px rgba(0,0,0,0.15);",
      "  pointer-events: auto;",
      "  user-select: none;",
      "}",
      "." + TOOLBAR_CLS + " .gbox-tb-name {",
      "  flex: 1;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "  white-space: nowrap;",
      "  font-weight: 500;",
      "}",
      "." + TOOLBAR_CLS + " button {",
      "  background: none;",
      "  border: none;",
      "  color: white;",
      "  cursor: pointer;",
      "  padding: 4px 6px;",
      "  border-radius: 3px;",
      "  font-size: 12px;",
      "  display: flex;",
      "  align-items: center;",
      "  opacity: 0.8;",
      "  line-height: 1;",
      "}",
      "." + TOOLBAR_CLS + " button:hover {",
      "  background: rgba(255,255,255,0.2);",
      "  opacity: 1;",
      "}",
      "." + TOOLBAR_CLS + " .gbox-drag-handle {",
      "  cursor: grab;",
      "}",
      "." + TOOLBAR_CLS + " .gbox-drag-handle:active {",
      "  cursor: grabbing;",
      "}",
      // Drag placeholder
      "." + PLACEHOLDER_CLS + " {",
      "  border: 2px dashed #3b82f6;",
      "  background: rgba(59, 130, 246, 0.05);",
      "  min-height: 60px;",
      "  margin: 4px 0;",
      "  border-radius: 4px;",
      "  pointer-events: none;",
      "}",
      // Editable text
      "[" + EDIT_ATTR + "] {",
      "  cursor: text !important;",
      "}",
      "[" + EDIT_ATTR + "]:hover {",
      "  background: rgba(59, 130, 246, 0.05);",
      "  outline: 1px dashed rgba(59, 130, 246, 0.3);",
      "}",
      "[" + EDIT_ATTR + "]:focus {",
      "  outline: 2px solid #3b82f6 !important;",
      "  outline-offset: 1px;",
      "  background: rgba(59, 130, 246, 0.03);",
      "}",
      // Image swap overlay
      "." + IMG_OVERLAY_CLS + " {",
      "  position: absolute;",
      "  top: 0; left: 0; right: 0; bottom: 0;",
      "  background: rgba(0,0,0,0.4);",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  cursor: pointer;",
      "  opacity: 0;",
      "  transition: opacity 0.15s;",
      "}",
      "." + IMG_OVERLAY_CLS + ":hover {",
      "  opacity: 1;",
      "}",
      "." + IMG_OVERLAY_CLS + " span {",
      "  background: white;",
      "  color: #333;",
      "  padding: 6px 12px;",
      "  border-radius: 4px;",
      "  font-size: 13px;",
      "  font-weight: 500;",
      "  pointer-events: none;",
      "}",
      // Add section button
      "." + ADD_BTN_CLS + " {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  height: 0;",
      "  overflow: visible;",
      "  position: relative;",
      "  z-index: 99998;",
      "}",
      "." + ADD_BTN_CLS + " button {",
      "  position: absolute;",
      "  top: -14px;",
      "  background: #2563eb;",
      "  color: white;",
      "  border: none;",
      "  width: 28px;",
      "  height: 28px;",
      "  border-radius: 50%;",
      "  cursor: pointer;",
      "  font-size: 18px;",
      "  line-height: 1;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  opacity: 0;",
      "  transition: opacity 0.15s;",
      "  box-shadow: 0 2px 6px rgba(0,0,0,0.2);",
      "}",
      "." + ADD_BTN_CLS + ":hover button {",
      "  opacity: 1;",
      "}",
      // Dragging state on body
      "body.gbox-dragging {",
      "  cursor: grabbing !important;",
      "  user-select: none !important;",
      "}",
      "body.gbox-dragging * {",
      "  pointer-events: none !important;",
      "}",
      "body.gbox-dragging [" + SECTION_ATTR + "] {",
      "  pointer-events: auto !important;",
      "}",
      "body.gbox-dragging ." + PLACEHOLDER_CLS + " {",
      "  pointer-events: auto !important;",
      "}"
    ].join("\\n");
    document.head.appendChild(style);
  }

  // =========================================================================
  // State
  // =========================================================================
  var sections = [];         // Array of section DOM elements
  var hoveredSection = null;
  var selectedSection = null;
  var activeToolbar = null;
  var activeEditableEl = null;
  var imageOverlays = [];
  var addButtons = [];
  var dragState = null;      // { el, placeholder, startY }

  // =========================================================================
  // Section discovery
  // =========================================================================
  function discoverSections() {
    var found = Array.from(document.querySelectorAll("[" + SECTION_ATTR + "]"));

    // Fallback: if no data-section-id elements, use direct children of <main> or <body>
    if (found.length === 0) {
      var container = document.querySelector("main") || document.body;
      var children = Array.from(container.children);
      var counter = 0;
      found = children.filter(function(el) {
        var tag = el.tagName.toLowerCase();
        // Skip script, style, meta-like elements and our own injected elements
        if (/^(script|style|link|meta|noscript|br|hr)$/.test(tag)) return false;
        if (el.id === "gbox-editor-bridge-styles") return false;
        if (el.classList.contains(TOOLBAR_CLS)) return false;
        if (el.classList.contains(ADD_BTN_CLS)) return false;
        return true;
      });
      found.forEach(function(el) {
        if (!el.getAttribute(SECTION_ATTR)) {
          el.setAttribute(SECTION_ATTR, "auto_" + (counter++));
        }
      });
    }

    sections = found;
    return found;
  }

  // =========================================================================
  // Add-section buttons between sections
  // =========================================================================
  function createAddButtons() {
    removeAddButtons();
    sections.forEach(function(sec, i) {
      var btn = document.createElement("div");
      btn.className = ADD_BTN_CLS;
      var inner = document.createElement("button");
      inner.textContent = "+";
      inner.title = "Add section";
      inner.addEventListener("click", function(e) {
        e.stopPropagation();
        post({ type: "section:add", afterSectionId: sec.getAttribute(SECTION_ATTR) });
      });
      btn.appendChild(inner);
      // Insert after the section element
      if (sec.nextSibling) {
        sec.parentNode.insertBefore(btn, sec.nextSibling);
      } else {
        sec.parentNode.appendChild(btn);
      }
      addButtons.push(btn);
    });
  }

  function removeAddButtons() {
    addButtons.forEach(function(b) { if (b.parentNode) b.parentNode.removeChild(b); });
    addButtons = [];
  }

  // =========================================================================
  // Hover overlay
  // =========================================================================
  function setHover(el) {
    if (el === hoveredSection) return;
    clearHover();
    if (el === selectedSection) return; // don't hover the already-selected section
    hoveredSection = el;
    el.setAttribute(HOVER_ATTR, "");
    post({ type: "section:hover", sectionId: el.getAttribute(SECTION_ATTR), rect: rectOf(el) });
  }

  function clearHover() {
    if (hoveredSection) {
      hoveredSection.removeAttribute(HOVER_ATTR);
      hoveredSection = null;
      post({ type: "section:unhover" });
    }
  }

  // =========================================================================
  // Selection + Toolbar
  // =========================================================================
  function selectSection(el) {
    if (el === selectedSection) return;
    deselectSection();
    selectedSection = el;
    el.setAttribute(SELECT_ATTR, "");
    clearHover();
    createToolbar(el);
    setupImageOverlays(el);
    markEditableText(el);
    post({ type: "section:click", sectionId: el.getAttribute(SECTION_ATTR) });
  }

  function deselectSection() {
    if (!selectedSection) return;
    selectedSection.removeAttribute(SELECT_ATTR);
    removeToolbar();
    removeImageOverlays();
    clearEditableText();
    selectedSection = null;
  }

  function createToolbar(el) {
    removeToolbar();

    // Ensure the section has position context for absolute toolbar
    var pos = window.getComputedStyle(el).position;
    if (pos === "static") {
      el.style.position = "relative";
    }

    var toolbar = document.createElement("div");
    toolbar.className = TOOLBAR_CLS;

    var sid = el.getAttribute(SECTION_ATTR);
    var name = sectionName(el);

    // Drag handle
    var dragHandle = document.createElement("button");
    dragHandle.className = "gbox-drag-handle";
    dragHandle.innerHTML = "&#9776;"; // hamburger icon
    dragHandle.title = "Drag to reorder";
    dragHandle.addEventListener("mousedown", function(e) {
      e.preventDefault();
      startDrag(el, e);
    });
    toolbar.appendChild(dragHandle);

    // Section name
    var nameSpan = document.createElement("span");
    nameSpan.className = "gbox-tb-name";
    nameSpan.textContent = name;
    toolbar.appendChild(nameSpan);

    // Visibility toggle
    var toggleBtn = document.createElement("button");
    toggleBtn.innerHTML = "&#128065;"; // eye icon
    toggleBtn.title = "Toggle visibility";
    toggleBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      var enabled = el.style.display !== "none";
      el.style.display = enabled ? "none" : "";
      toggleBtn.style.opacity = enabled ? "0.4" : "0.8";
      post({ type: "section:toggle", sectionId: sid, enabled: !enabled });
    });
    toolbar.appendChild(toggleBtn);

    // Duplicate
    var dupBtn = document.createElement("button");
    dupBtn.innerHTML = "&#10697;"; // copy icon
    dupBtn.title = "Duplicate section";
    dupBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      post({ type: "section:duplicate", sectionId: sid });
    });
    toolbar.appendChild(dupBtn);

    // Delete
    var delBtn = document.createElement("button");
    delBtn.innerHTML = "&#128465;"; // trash icon
    delBtn.title = "Delete section";
    delBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      post({ type: "section:delete", sectionId: sid });
    });
    toolbar.appendChild(delBtn);

    el.appendChild(toolbar);
    activeToolbar = toolbar;

    // If the toolbar is above the viewport, flip it below
    requestAnimationFrame(function() {
      var tbRect = toolbar.getBoundingClientRect();
      if (tbRect.top < 0) {
        toolbar.style.top = "auto";
        toolbar.style.bottom = "-36px";
        toolbar.style.borderRadius = "0 0 4px 4px";
        toolbar.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
      }
    });
  }

  function removeToolbar() {
    if (activeToolbar && activeToolbar.parentNode) {
      activeToolbar.parentNode.removeChild(activeToolbar);
    }
    activeToolbar = null;
  }

  // =========================================================================
  // Inline text editing
  // =========================================================================
  function markEditableText(sectionEl) {
    clearEditableText();
    var textEls = sectionEl.querySelectorAll("h1,h2,h3,h4,h5,h6,p,span,a,li,label,blockquote,figcaption");
    textEls.forEach(function(el) {
      // Skip elements that are part of our toolbar/overlay
      if (el.closest("." + TOOLBAR_CLS) || el.closest("." + IMG_OVERLAY_CLS)) return;
      // Skip elements with no visible text
      if (!el.textContent.trim()) return;
      el.setAttribute(EDIT_ATTR, "");
    });
  }

  function clearEditableText() {
    if (activeEditableEl) {
      finishEditing(activeEditableEl);
    }
    document.querySelectorAll("[" + EDIT_ATTR + "]").forEach(function(el) {
      el.removeAttribute(EDIT_ATTR);
    });
  }

  function startEditing(el) {
    if (activeEditableEl === el) return;
    if (activeEditableEl) finishEditing(activeEditableEl);

    activeEditableEl = el;
    el.contentEditable = "true";
    el.focus();

    // Select all text in the element
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    el.addEventListener("blur", onEditBlur);
    el.addEventListener("keydown", onEditKeydown);
  }

  function finishEditing(el) {
    if (!el) return;
    el.contentEditable = "false";
    el.removeEventListener("blur", onEditBlur);
    el.removeEventListener("keydown", onEditKeydown);

    if (activeEditableEl === el) {
      // Find the section and setting info
      var sectionEl = el.closest("[" + SECTION_ATTR + "]");
      if (sectionEl) {
        var settingId = el.getAttribute("data-setting-id") || getElementPath(el, sectionEl);
        post({
          type: "content:edit",
          sectionId: sectionEl.getAttribute(SECTION_ATTR),
          settingId: settingId,
          value: el.innerHTML
        });
      }
      activeEditableEl = null;
    }
  }

  function onEditBlur(e) {
    // Small delay to allow click events to fire first
    var el = e.target;
    setTimeout(function() { finishEditing(el); }, 100);
  }

  function onEditKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.target.blur();
    }
    // Prevent Enter from creating new lines in single-line elements
    if (e.key === "Enter" && !e.shiftKey) {
      var tag = e.target.tagName;
      if (/^(H[1-6]|SPAN|A|LABEL)$/i.test(tag)) {
        e.preventDefault();
        e.target.blur();
      }
    }
  }

  // =========================================================================
  // Image swap overlays
  // =========================================================================
  function setupImageOverlays(sectionEl) {
    removeImageOverlays();
    var images = sectionEl.querySelectorAll("img");
    images.forEach(function(img) {
      // Skip tiny images (icons, spacers)
      if (img.naturalWidth < 40 || img.naturalHeight < 40) return;
      // Skip images inside toolbar
      if (img.closest("." + TOOLBAR_CLS)) return;

      var wrapper = img.parentElement;
      // Ensure the parent can contain an absolute overlay
      var wPos = window.getComputedStyle(wrapper).position;
      if (wPos === "static") {
        wrapper.style.position = "relative";
        wrapper._gboxPosReset = true;
      }

      var overlay = document.createElement("div");
      overlay.className = IMG_OVERLAY_CLS;
      var label = document.createElement("span");
      label.textContent = "Change image";
      overlay.appendChild(label);

      overlay.addEventListener("click", function(e) {
        e.stopPropagation();
        var settingId = img.getAttribute("data-setting-id") || getElementPath(img, sectionEl);
        post({
          type: "content:image",
          sectionId: sectionEl.getAttribute(SECTION_ATTR),
          settingId: settingId
        });
      });

      wrapper.appendChild(overlay);
      imageOverlays.push({ overlay: overlay, wrapper: wrapper });
    });
  }

  function removeImageOverlays() {
    imageOverlays.forEach(function(item) {
      if (item.overlay.parentNode) item.overlay.parentNode.removeChild(item.overlay);
      if (item.wrapper._gboxPosReset) {
        item.wrapper.style.position = "";
        delete item.wrapper._gboxPosReset;
      }
    });
    imageOverlays = [];
  }

  // =========================================================================
  // Drag to reorder
  // =========================================================================
  function startDrag(sectionEl, mouseEvent) {
    if (dragState) return;

    var placeholder = document.createElement("div");
    placeholder.className = PLACEHOLDER_CLS;
    placeholder.style.height = sectionEl.offsetHeight + "px";

    dragState = {
      el: sectionEl,
      placeholder: placeholder,
      startY: mouseEvent.clientY,
      origNextSibling: sectionEl.nextSibling,
      origParent: sectionEl.parentNode
    };

    // Insert placeholder where the section was
    sectionEl.parentNode.insertBefore(placeholder, sectionEl);

    // Make the section "float"
    sectionEl.style.position = "fixed";
    sectionEl.style.zIndex = "100000";
    sectionEl.style.width = sectionEl.offsetWidth + "px";
    sectionEl.style.opacity = "0.85";
    sectionEl.style.pointerEvents = "none";
    sectionEl.style.transition = "none";

    var rect = placeholder.getBoundingClientRect();
    sectionEl.style.top = rect.top + "px";
    sectionEl.style.left = rect.left + "px";

    document.body.classList.add("gbox-dragging");

    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  }

  function onDragMove(e) {
    if (!dragState) return;
    var dy = e.clientY - dragState.startY;
    var rect = dragState.placeholder.getBoundingClientRect();
    dragState.el.style.top = (rect.top + dy) + "px";

    // Find which section the cursor is over
    var target = null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i] === dragState.el) continue;
      var sr = sections[i].getBoundingClientRect();
      var midY = sr.top + sr.height / 2;
      if (e.clientY < midY) {
        target = sections[i];
        break;
      }
    }

    // Move placeholder
    if (target) {
      target.parentNode.insertBefore(dragState.placeholder, target);
    } else {
      // Place at end
      var lastSection = sections[sections.length - 1];
      if (lastSection !== dragState.el && lastSection.parentNode) {
        lastSection.parentNode.insertBefore(dragState.placeholder, lastSection.nextSibling);
      }
    }
  }

  function onDragEnd(e) {
    if (!dragState) return;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    document.body.classList.remove("gbox-dragging");

    // Place the section where the placeholder is
    dragState.placeholder.parentNode.insertBefore(dragState.el, dragState.placeholder);
    dragState.placeholder.parentNode.removeChild(dragState.placeholder);

    // Reset styles
    dragState.el.style.position = "";
    dragState.el.style.zIndex = "";
    dragState.el.style.width = "";
    dragState.el.style.opacity = "";
    dragState.el.style.pointerEvents = "";
    dragState.el.style.transition = "";
    dragState.el.style.top = "";
    dragState.el.style.left = "";

    dragState = null;

    // Re-discover sections in their new order and report
    discoverSections();
    var order = sections.map(function(s) { return s.getAttribute(SECTION_ATTR); });
    post({ type: "section:reorder", order: order });

    // Rebuild add buttons
    createAddButtons();

    // Re-select to refresh toolbar position
    if (selectedSection) {
      var sel = selectedSection;
      deselectSection();
      selectSection(sel);
    }
  }

  // =========================================================================
  // Event listeners
  // =========================================================================
  function setupEventListeners() {
    // Mouse move — hover detection
    document.addEventListener("mousemove", function(e) {
      if (dragState) return;
      var target = e.target.closest("[" + SECTION_ATTR + "]");
      if (target) {
        setHover(target);
      } else {
        clearHover();
      }
    }, { passive: true });

    // Mouse leave — clear hover when leaving the viewport
    document.addEventListener("mouseleave", function() {
      if (!dragState) clearHover();
    });

    // Click — select section
    document.addEventListener("click", function(e) {
      if (dragState) return;

      // Ignore clicks on toolbar elements
      if (e.target.closest("." + TOOLBAR_CLS)) return;
      // Ignore clicks on add buttons
      if (e.target.closest("." + ADD_BTN_CLS)) return;
      // Ignore clicks on image overlays
      if (e.target.closest("." + IMG_OVERLAY_CLS)) return;

      var sectionEl = e.target.closest("[" + SECTION_ATTR + "]");
      if (sectionEl) {
        e.preventDefault();
        selectSection(sectionEl);
      } else {
        deselectSection();
      }
    });

    // Double-click — inline edit
    document.addEventListener("dblclick", function(e) {
      if (dragState) return;
      if (e.target.closest("." + TOOLBAR_CLS)) return;

      var sectionEl = e.target.closest("[" + SECTION_ATTR + "]");
      if (!sectionEl || sectionEl !== selectedSection) return;

      // Find the nearest text element
      var textEl = e.target;
      if (!isTextElement(textEl)) {
        textEl = e.target.closest("h1,h2,h3,h4,h5,h6,p,span,a,li,label,blockquote,figcaption");
      }
      if (!textEl || !textEl.closest("[" + SECTION_ATTR + "]")) return;
      if (textEl.closest("." + TOOLBAR_CLS)) return;

      e.preventDefault();
      post({
        type: "section:dblclick",
        sectionId: sectionEl.getAttribute(SECTION_ATTR),
        elementPath: getElementPath(textEl, sectionEl)
      });
      startEditing(textEl);
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", function(e) {
      // Escape deselects
      if (e.key === "Escape" && selectedSection && !activeEditableEl) {
        deselectSection();
      }
      // Delete key
      if ((e.key === "Delete" || e.key === "Backspace") && selectedSection && !activeEditableEl) {
        e.preventDefault();
        post({ type: "section:delete", sectionId: selectedSection.getAttribute(SECTION_ATTR) });
      }
    });
  }

  // =========================================================================
  // Message listener (commands from parent)
  // =========================================================================
  function setupMessageListener() {
    window.addEventListener("message", function(e) {
      // Validate origin: only accept messages from trusted admin origin
      if (ADMIN_ORIGIN && e.origin !== ADMIN_ORIGIN) return;
      var msg = e.data;
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "cmd:select": {
          var el = document.querySelector("[" + SECTION_ATTR + '="' + CSS.escape(msg.sectionId) + '"]');
          if (el) selectSection(el);
          break;
        }
        case "cmd:deselect": {
          deselectSection();
          break;
        }
        case "cmd:scrollTo": {
          var target = document.querySelector("[" + SECTION_ATTR + '="' + CSS.escape(msg.sectionId) + '"]');
          if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            // Flash highlight
            target.setAttribute(HOVER_ATTR, "");
            setTimeout(function() { target.removeAttribute(HOVER_ATTR); }, 1200);
          }
          break;
        }
        case "cmd:highlight": {
          var hl = document.querySelector("[" + SECTION_ATTR + '="' + CSS.escape(msg.sectionId) + '"]');
          if (hl) hl.setAttribute(HOVER_ATTR, "");
          break;
        }
        case "cmd:unhighlight": {
          document.querySelectorAll("[" + HOVER_ATTR + "]").forEach(function(el) {
            el.removeAttribute(HOVER_ATTR);
          });
          break;
        }
        case "cmd:updateSection": {
          var sec = document.querySelector("[" + SECTION_ATTR + '="' + CSS.escape(msg.sectionId) + '"]');
          if (sec) {
            var wasSelected = sec === selectedSection;
            if (wasSelected) deselectSection();
            sec.innerHTML = sanitizeHtml(msg.html);
            // Re-set the attribute in case it was inside innerHTML
            sec.setAttribute(SECTION_ATTR, msg.sectionId);
            if (wasSelected) selectSection(sec);
          }
          break;
        }
        case "cmd:addSection": {
          var afterEl = document.querySelector("[" + SECTION_ATTR + '="' + CSS.escape(msg.afterSectionId) + '"]');
          if (afterEl) {
            var temp = document.createElement("div");
            temp.innerHTML = sanitizeHtml(msg.html);
            var newSec = temp.firstElementChild;
            if (newSec) {
              newSec.setAttribute(SECTION_ATTR, msg.sectionId);
              afterEl.parentNode.insertBefore(newSec, afterEl.nextSibling);
              discoverSections();
              createAddButtons();
              selectSection(newSec);
              newSec.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }
          break;
        }
        case "cmd:removeSection": {
          var rem = document.querySelector("[" + SECTION_ATTR + '="' + CSS.escape(msg.sectionId) + '"]');
          if (rem) {
            if (rem === selectedSection) deselectSection();
            rem.parentNode.removeChild(rem);
            discoverSections();
            createAddButtons();
            reportHeight();
          }
          break;
        }
        case "cmd:reloadPage": {
          window.location.reload();
          break;
        }
        case "cmd:setDevice": {
          // Device simulation is handled by the parent iframe sizing.
          // We just need to re-report height after layout shifts.
          requestAnimationFrame(function() {
            reportHeight();
          });
          break;
        }
      }
    });
  }

  // =========================================================================
  // Height reporting via ResizeObserver
  // =========================================================================
  function reportHeight() {
    var height = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    post({ type: "bridge:resize", height: height });
  }

  function setupResizeObserver() {
    if (typeof ResizeObserver === "undefined") {
      // Fallback: poll every 500ms
      setInterval(reportHeight, 500);
      return;
    }
    var ro = new ResizeObserver(function() {
      reportHeight();
    });
    ro.observe(document.documentElement);
    ro.observe(document.body);
  }

  // =========================================================================
  // Initialization
  // =========================================================================
  function init() {
    injectStyles();
    discoverSections();
    createAddButtons();
    setupEventListeners();
    setupMessageListener();
    setupResizeObserver();

    // Report ready
    var sectionIds = sections.map(function(s) { return s.getAttribute(SECTION_ATTR); });
    post({ type: "bridge:ready", sections: sectionIds });
    reportHeight();
  }

  // Run on DOMContentLoaded or immediately if already loaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();`;
}
