import { useEffect, useRef, useState } from "react";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { t } from "../i18n";

type TextField = HTMLInputElement | HTMLTextAreaElement;

interface MenuState {
  x: number;
  y: number;
  /// Set when the click landed in an editable field.
  field: TextField | HTMLElement | null;
  selection: string;
  editable: boolean;
}

const NON_TEXT_INPUT = /^(button|checkbox|radio|range|color|file|submit|reset|image)$/;

function isTextField(el: Element | null): el is TextField {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUT.test(el.type);
}

async function copyText(text: string) {
  try {
    await writeText(text);
  } catch {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // nothing more to try
    }
  }
}

/// The app-wide right-click menu for text: "Kopieren" wherever text is
/// selected, plus "Ausschneiden"/"Einfügen"/"Alles auswählen" in text fields.
/// Replaces the native WebKitGTK menu on fields (see `App`'s root handler).
/// More specific menus (tiles, file grid) stop propagation and never reach
/// this one.
export default function TextContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onContextMenu(ev: MouseEvent) {
      if (ev.defaultPrevented) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      // The segmented date fields handle their own keys; a paste would be
      // swallowed anyway.
      if (target.classList?.contains("dt-input__field")) {
        ev.preventDefault();
        return;
      }
      const field = target.closest("input, textarea, [contenteditable='true']") as HTMLElement | null;
      const textField = isTextField(field) ? field : null;
      const editableDiv = !textField && field ? field : null;
      if (field && !textField && !editableDiv) {
        ev.preventDefault();
        return;
      }
      let selection = "";
      if (textField) {
        selection = (textField.value ?? "").slice(textField.selectionStart ?? 0, textField.selectionEnd ?? 0);
      } else {
        selection = window.getSelection()?.toString() ?? "";
      }
      ev.preventDefault();
      const editable = Boolean(field) && !(textField && (textField.readOnly || textField.disabled));
      if (!field && !selection) return;
      setMenu({ x: ev.clientX, y: ev.clientY, field, selection, editable });
    }
    // Capture phase: a right-click ON selected text must offer "Kopieren"
    // even inside tiles/previews that have their own menu (and stop
    // propagation, so the bubbling listener above never sees them).
    // WebKitGTK may drop the selection on the right-button mousedown before
    // the contextmenu event arrives, so the last non-empty selection is
    // remembered and only forgotten by a left/middle click.
    let last: { text: string; anchor: Element | null; rects: DOMRect[] } | null = null;
    function onSelectionChange() {
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      if (!sel || sel.rangeCount === 0 || !text.trim()) return;
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      last = {
        text,
        anchor: node instanceof Element ? node : node.parentElement,
        rects: Array.from(range.getClientRects()),
      };
    }
    function onMouseDown(ev: MouseEvent) {
      if (ev.button !== 2) last = null;
    }
    function onContextMenuCapture(ev: MouseEvent) {
      const target = ev.target as HTMLElement | null;
      if (!last || !target) return;
      if (target.closest("input, textarea, [contenteditable='true']")) return;
      const pad = 4;
      const hit =
        last.rects.some(
          (r) =>
            ev.clientX >= r.left - pad && ev.clientX <= r.right + pad && ev.clientY >= r.top - pad && ev.clientY <= r.bottom + pad,
        ) ||
        // Pointer on the same line box / element as the selected text.
        (last.anchor !== null && last.anchor.contains(target) && last.anchor.childElementCount === 0);
      if (!hit) return;
      ev.preventDefault();
      ev.stopPropagation();
      setMenu({ x: ev.clientX, y: ev.clientY, field: null, selection: last.text, editable: false });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("contextmenu", onContextMenuCapture, true);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("contextmenu", onContextMenuCapture, true);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  if (!menu) return null;
  const { field, selection, editable } = menu;
  const textField = isTextField(field) ? field : null;

  function replaceSelection(text: string) {
    if (!field) return;
    field.focus();
    if (textField) {
      const start = textField.selectionStart ?? textField.value.length;
      const end = textField.selectionEnd ?? start;
      textField.setRangeText(text, start, end, "end");
      // React only notices the new value through an input event.
      textField.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand(text ? "insertText" : "delete", false, text);
    }
  }

  async function doCopy() {
    if (selection) await copyText(selection);
  }
  async function doCut() {
    if (!selection) return;
    await copyText(selection);
    replaceSelection("");
  }
  async function doPaste() {
    let text = "";
    try {
      text = await readText();
    } catch {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return;
      }
    }
    if (text) replaceSelection(text);
  }
  function doSelectAll() {
    if (!field) return;
    field.focus();
    if (textField) textField.select();
    else document.execCommand("selectAll");
  }

  function item(label: string, action: () => void | Promise<void>, disabled = false) {
    return (
      <button
        className="context-menu__item"
        disabled={disabled}
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={() => {
          setMenu(null);
          void action();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <>
      <div
        className="file-browser__menu-scrim"
        style={{ zIndex: 899 }}
        onMouseDown={() => setMenu(null)}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setMenu(null);
        }}
      />
      <div ref={ref} className="context-menu" style={{ left: menu.x, top: menu.y, zIndex: 900 }}>
        {editable && item(t("textMenu.cut"), doCut, !selection)}
        {item(t("textMenu.copy"), doCopy, !selection)}
        {editable && item(t("textMenu.paste"), doPaste)}
        {field && item(t("textMenu.selectAll"), doSelectAll)}
      </div>
    </>
  );
}
