// GitHub Actions смоук: грузит игру из Supabase, гоняет в реальном браузере (puppeteer + встроенный Chromium),
// пишет результат: status ready|failed + smoke_result, и при успехе зовёт /callback бота (ссылка юзеру).
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'node:http';

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const GAME_ID = process.env.GAME_ID || '';
const PORTAL_URL = process.env.PORTAL_URL || 'https://genergame-bot.igoralx9119.workers.dev';
if (!GAME_ID || !SB_URL || !SB_KEY) { console.error('Need GAME_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY'); process.exit(1); }

const sb = createClient(SB_URL, SB_KEY);
const { data: game, error } = await sb.from('games').select('source_code, slug, title, chat_id').eq('id', GAME_ID).single();
if (error || !game?.source_code) { console.error('Game not found:', error?.message || 'no source_code'); process.exit(1); }

const errs = [];
let canvas = { ok: false, reason: 'NO CANVAS' };
let browser;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 500 });
  page.on('pageerror', e => errs.push(String(e.stack || e.message || e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
  await page.evaluateOnNewDocument(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (/webgl/i.test(type || '')) attrs = Object.assign({ preserveDrawingBuffer: true }, attrs || {});
      return orig.call(this, type, attrs);
    };
  });
  try {
    // 'load' + некритичный таймаут: на Actions-раннере CDN может грузиться медленно,
    // но таймаут setContent НЕ должен фейлить прогон — решают pageerror и canvas-проверка.
    // (networkidle0/networkidle2 на Phaser-страницах ведут себя непредсказуемо в CI.)
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  } catch (e) {
    // не пушим в errs: страница могла загрузиться позже таймаута; ждём canvas ниже
    await new Promise(r => setTimeout(r, 5000)).catch(() => {});
  }
  await new Promise(r => setTimeout(r, 2000));
  // Ждём появления canvas (CDN phaser может грузиться до 20с на медленном раннере)
  for (let i = 0; i < 20; i++) {
    const has = await page.evaluate(() => !!document.querySelector('canvas')).catch(() => false);
    if (has) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  for (let i = 0; i < 4; i++) {
    await page.mouse.click(100 + Math.floor(Math.random() * 700), 100 + Math.floor(Math.random() * 300)).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
  }
  try { await page.mouse.click(400, 250); } catch (e) {}
  // Зажатие стрелки — проверка, что update() реагирует на ввод
  try {
    await page.keyboard.down('ArrowRight');
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.up('ArrowRight');
  } catch (e) {}
  await new Promise(r => setTimeout(r, 1200));

  canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { ok: false, reason: 'NO CANVAS' };
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const w = Math.min(c.width, 128), h = Math.min(c.height, 128);
      const px = new Uint8Array(w * h * 4);
      try { gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      catch (e) { return { ok: false, reason: 'readPixels: ' + e.message }; }
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
      return { ok: n > 0, reason: 'webgl nonempty=' + n };
    }
    const ctx = c.getContext('2d');
    if (!ctx) return { ok: false, reason: 'NO 2D CONTEXT' };
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return { ok: n > 0, reason: '2d nonempty=' + n };
  }).catch(e => ({ ok: false, reason: 'eval err: ' + e.message }));
} catch (e) {
  errs.push('browser: ' + (e && e.message));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise(r => server.close(r)).catch(() => {});
}

const ok = errs.length === 0 && canvas.ok;
const result = { ok, errs, canvas };
console.log(JSON.stringify(result, null, 2));

await sb.from('games').update({
  status: ok ? 'ready' : 'failed',
  smoke_result: JSON.stringify(result),
  ...(ok ? { error_message: null } : { error_message: String(errs.join('; ') || canvas.reason).slice(0, 500) }),
}).eq('id', GAME_ID).then(({ error: ue }) => { if (ue) console.error('supabase update:', ue.message); });

// Итог → всегда уведомляем бота: ready → ссылка, failed → сообщение об ошибке.
// Без этого юзер при failed получает тишину, хотя игра уже не в generating.
if (game.chat_id && game.slug) {
  const body = ok
    ? { slug: game.slug, chatId: game.chat_id, title: game.title, gameId: GAME_ID, status: 'ready' }
    : { slug: game.slug, chatId: game.chat_id, gameId: GAME_ID, status: 'failed', error: String(errs.join('; ') || canvas.reason).slice(0, 200) };
  await fetch(`${PORTAL_URL}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => console.log('callback:', r.status)).catch(e => console.error('callback:', e.message));
}

process.exit(ok ? 0 : 1);
