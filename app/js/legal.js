// Rellena en las páginas legales los datos del responsable de esta instalación.
fetch('/api/legal', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d) return;
  for (const el of document.querySelectorAll('[data-legal]')) {
    const v = d[el.dataset.legal];
    if (v) el.textContent = v;
  }
}).catch(() => {});
