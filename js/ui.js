// Small shared UI helpers.

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function openModal(html, onClose) {
  const dlg = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  body.innerHTML = html;
  const close = () => {
    if (dlg.open) dlg.close();
  };
  dlg.onclose = () => onClose?.();
  body.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  if (!dlg.open) dlg.showModal();
  return { body, close };
}

// Bottom sheets: <div class="sheet" id=...> with optional panes [data-<kind>-pane="name"].
export function openSheet(id, paneAttr, pane) {
  const sheet = document.getElementById(id);
  if (paneAttr) {
    sheet.querySelectorAll(`[${paneAttr}]`).forEach((p) => { p.hidden = p.getAttribute(paneAttr) !== pane; });
  }
  sheet.hidden = false;
  sheet.querySelector('.sheet-body').scrollTop = 0;
}

export function closeSheet(id) {
  document.getElementById(id).hidden = true;
}

export function initSheets() {
  document.querySelectorAll('.sheet').forEach((sheet) => {
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet || e.target.closest('[data-sheet-close]')) sheet.hidden = true;
    });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
  });
}
