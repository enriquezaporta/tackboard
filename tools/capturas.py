#!/usr/bin/env python3
"""Genera las capturas de docs/img con datos de ejemplo.

Necesita Playwright (pip install playwright && playwright install chromium) y una instalación de
Tackboard vacía y con el registro abierto, por ejemplo con Docker:

    docker compose up -d
    python3 tools/capturas.py http://localhost:8080
"""

import asyncio
import datetime as dt
import os
import sys

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "img")

SEED = r"""
async ({ demo, sharedWith }) => {
  const m = await import('/js/store.js');
  const api = await import('/js/api.js');
  const u = await import('/js/util.js');
  const d = (n) => u.addDays(u.todayStr(), n);
  const casa = await m.createBoard('Casa', '#9A6200');
  const trabajo = await m.createBoard('Trabajo', '#2457A6');
  const viaje = await m.createBoard('Viaje a Lisboa', '#0E6B62');
  const cols = (b) => m.columns(b).map((c) => c.id);
  const add = async (b, ci, title, extra = {}) => {
    const id = await m.createCard(b, cols(b)[ci], { title, due: extra.due || '', dueTime: extra.dueTime || '' });
    if (Object.keys(extra).length) {
      const c = m.record(id);
      await m.save('card', id, b, { ...c.data, ...extra, dueAt: u.dueAt(extra.due || c.data.due, extra.dueTime || c.data.dueTime) });
    }
    return id;
  };
  // Etiquetas
  const B = m.board(trabajo);
  await m.save('board', trabajo, trabajo, { ...B.data, labels: [
    { id: 'l-cliente', name: 'Cliente', color: '#6B3FA0' },
    { id: 'l-interno', name: 'Interno', color: '#3D6B1F' } ] });
  await add(trabajo, 0, 'Preparar la presentación del trimestre', { due: d(2), priority: 'high', labels: ['l-cliente'],
    checklist: [{ id: 'a1', text: 'Recoger cifras', done: true }, { id: 'a2', text: 'Diapositivas', done: false }, { id: 'a3', text: 'Ensayo', done: false }] });
  await add(trabajo, 0, 'Revisar el contrato de mantenimiento', { due: d(-1), labels: ['l-cliente'] });
  await add(trabajo, 0, 'Ordenar la carpeta compartida', { labels: ['l-interno'] });
  await add(trabajo, 1, 'Copia de seguridad semanal', { due: d(0), dueTime: '10:00', priority: 'medium', reminders: ['1h'],
    repeat: { freq: 'week', every: 1, days: [new Date().getDay()], day: null },
    description: 'Comprobar también que se puede restaurar.', checklist: [{ id: 'b1', text: 'Servidor', done: true }, { id: 'b2', text: 'Portátiles', done: false }] });
  await add(trabajo, 1, 'Actualizar la documentación', { labels: ['l-interno'] });
  await add(trabajo, 2, 'Enviar las facturas de septiembre', { due: d(-3) });
  await add(casa, 0, 'Pedir presupuesto de la cocina', { due: d(0), priority: 'high' });
  await add(casa, 0, 'Pagar el seguro del coche', { due: d(3) });
  await add(casa, 0, 'Revisar la caldera', { due: d(9) });
  await add(casa, 1, 'Pintar el dormitorio', { checklist: [{ id: 'c1', text: 'Comprar pintura', done: true }, { id: 'c2', text: 'Cinta de carrocero', done: true }, { id: 'c3', text: 'Pintar', done: false }] });
  await add(casa, 2, 'Llevar la bici al taller', { due: d(-2) });
  await add(viaje, 0, 'Reservar el alojamiento', { due: d(5) });
  await add(viaje, 0, 'Comprar los billetes de tren', { due: d(4), dueTime: '20:00' });
  await add(viaje, 1, 'Lista de lugares para visitar');
  await m.sync();
  // Una foto de ejemplo (dibujada aquí mismo) como adjunto.
  const pres = m.cards((c) => c.data.title.startsWith('Preparar la presentación'))[0];
  const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1200, 800); grad.addColorStop(0, '#2457A6'); grad.addColorStop(1, '#0E6B62');
  g.fillStyle = grad; g.fillRect(0, 0, 1200, 800);
  g.fillStyle = 'rgba(255,255,255,.85)'; [[160, 520, 160, 200], [400, 400, 160, 320], [640, 300, 160, 420], [880, 180, 160, 540]].forEach(([x, y, w, h]) => g.fillRect(x, y, w, h));
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
  const f = await import('/js/files.js');
  await f.addFiles(pres.id, [new File([blob], 'grafico-trimestre.jpg', { type: 'image/jpeg' })]);
  await m.sync();
  if (sharedWith) {
    await api.post('/api/boards/' + casa + '/members', { username: sharedWith, role: 'write' });
  }
  await m.saveSettings({ lastBoard: trabajo });
  return { casa, trabajo, viaje };
}
"""


async def register(page, user, name):
    await page.goto(BASE + "/")
    await page.click("[data-mode=register]")
    await page.fill("#a-name", name)
    await page.fill("#a-user", user)
    await page.fill("#a-pw", "contraseña-de-ejemplo")
    await page.check("#a-consent")
    await page.click("#auth-form button[type=submit]")
    await page.wait_for_selector("#rc-ok")
    await page.check("#rc-ok")
    await page.click("#rc-done")
    await page.wait_for_selector("h1")


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        br = await p.chromium.launch()
        other = await (await br.new_context()).new_page()
        await register(other, "lucia", "Lucía")

        mob = await br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="es-ES")
        m = await mob.new_page()
        await register(m, "alex", "Alex")
        ids = await m.evaluate(SEED, {"demo": True, "sharedWith": "lucia"})
        # Lucía acepta la invitación para que "Casa" aparezca como compartido.
        await other.evaluate("""async (b) => { const api = await import('/js/api.js'); await api.post('/api/invitations/' + b, { accept: true }); }""", ids["casa"])
        await m.evaluate("import('/js/store.js').then(s => s.sync())")
        await m.wait_for_timeout(500)

        async def shot(page, name, full=False):
            await page.wait_for_timeout(350)
            await page.evaluate("document.getElementById('toast')?.classList.remove('show')")
            await page.wait_for_timeout(250)
            await page.screenshot(path=os.path.join(OUT, name), full_page=full)
            print("  " + name)

        await m.goto(BASE + "/#/hoy"); await m.wait_for_timeout(800); await shot(m, "movil-hoy.png")
        await m.goto(BASE + "/#/tablero/" + ids["trabajo"]); await shot(m, "movil-tablero.png")
        await m.click(".card:has-text('Preparar la presentación')"); await shot(m, "movil-tarjeta.png")
        await m.keyboard.press("Escape")
        await m.goto(BASE + "/#/calendario"); await shot(m, "movil-calendario.png")
        await m.goto(BASE + "/#/tablero/" + ids["casa"])
        await m.click("[data-act=share]"); await m.wait_for_selector("[data-role]"); await shot(m, "movil-compartir.png")
        await m.keyboard.press("Escape")
        await m.goto(BASE + "/#/buscar"); await m.fill("#q", "copia"); await shot(m, "movil-buscar.png")
        await m.goto(BASE + "/#/tableros"); await m.click("[data-act=new]"); await m.wait_for_timeout(500)
        await m.fill("#nb-name", "Mudanza"); await m.click(".tpl:has-text('Mudanza')"); await shot(m, "movil-plantillas.png")
        await m.keyboard.press("Escape")
        await m.goto(BASE + "/#/tablero/" + ids["trabajo"])
        await m.click(".card:has-text('Preparar la presentación')"); await m.click("#c-pomo"); await m.wait_for_timeout(2500)
        await shot(m, "movil-pomodoro.png")
        await m.click("[data-focus]"); await shot(m, "movil-enfoque.png")
        await m.keyboard.press("Escape")
        await m.goto(BASE + "/#/ajustes"); await m.click("[data-theme-set=dark]")
        await m.goto(BASE + "/#/tablero/" + ids["trabajo"]); await shot(m, "movil-oscuro.png")
        await m.goto(BASE + "/#/ajustes"); await m.click("[data-theme-set=auto]")

        desk = await br.new_context(viewport={"width": 1440, "height": 900}, locale="es-ES")
        dpage = await desk.new_page()
        await dpage.goto(BASE + "/")
        await dpage.fill("#a-user", "alex"); await dpage.fill("#a-pw", "contraseña-de-ejemplo")
        await dpage.click("#auth-form button[type=submit]")
        await dpage.wait_for_selector("h1")
        await dpage.wait_for_timeout(1200)
        await dpage.goto(BASE + "/#/tablero/" + ids["trabajo"]); await shot(dpage, "escritorio-tablero.png")
        await dpage.goto(BASE + "/#/calendario"); await shot(dpage, "escritorio-calendario.png")
        await dpage.goto(BASE + "/#/hoy"); await shot(dpage, "escritorio-hoy.png")
        await dpage.goto(BASE + "/#/pomodoro"); await dpage.wait_for_timeout(800); await shot(dpage, "escritorio-pomodoro.png")
        await m.evaluate("import('/js/pomo.js').then(p => p.stopPomo())")
        await br.close()


if __name__ == "__main__":
    asyncio.run(main())
