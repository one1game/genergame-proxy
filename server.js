// Генератор игр — без лимитов Cloudflare Workers
// Пайплайн: SPEC → CODEGEN(PlayScene, best-of-2) → skeleton-сборка → QA (syntax+structural) → review → polish
import { createServer } from 'node:http';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';

// --- Env ---
const DS_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PORTAL_URL = process.env.PORTAL_URL || 'https://genergame-bot.igoralx9119.workers.dev';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

const DS_URL = 'https://api.deepseek.com/v1/chat/completions';

const MAX_ATTEMPTS = 3;
const DS_TIMEOUT = 120_000; // 2 мин

// ============================================================
// СТАДИЯ A — SPEC (JSON-бриф вместо расплывчатой фразы)
// ============================================================
const SPEC_SYSTEM_PROMPT = `Ты — геймдизайнер. По короткому описанию юзера составь ПОЛНОЕ техническое задание для 2D HTML5-игры на Phaser 3.
Не меняй идею юзера. Если чего-то не хватает (тема визуала, конкретная механика усложнения, звуковой стиль) — придумай в тон его идее, не делай дженерик.

Верни ТОЛЬКО JSON без пояснений, строго такой структуры:
{
  "title": "название на русском",
  "genre": "platformer|shooter|runner|puzzle|arcade|tower_defense|match3",
  "core_loop": "что игрок делает каждые несколько секунд, 1 фраза",
  "win_condition": "конкретное измеримое условие победы",
  "lose_condition": "конкретное измеримое условие поражения",
  "entities": [{"name":"","role":"player|enemy|hazard|pickup|projectile","behavior":""}],
  "controls": {"desktop":"","mobile":"tap|joystick|swipe|buttons"},
  "difficulty_curve": "формула нарастания сложности со временем/очками",
  "juice": ["screen_shake_on_hit","particle_burst_on_collect","score_popup"],
  "sound_cues": ["jump","hit","collect","gameover"],
  "art_style": {"palette":["#hex","#hex","#hex"], "mood":""},
  "scenes": ["BootScene","MenuScene","PlayScene","GameOverScene"]
}`;

async function generateSpec(description) {
  const raw = await callDeepSeek([
    { role: 'system', content: SPEC_SYSTEM_PROMPT },
    { role: 'user', content: description }
  ], { temperature: 0.4, max_tokens: 1000 });
  let cleaned = raw.trim();
  // Снимаем ```json ... ``` блок целиком
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  // Вырезаем JSON-объект между первой { и последней }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace > -1 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  const spec = JSON.parse(cleaned);
  if (!spec || !spec.title) throw new Error('SPEC без title');
  return spec;
}

function specBrief(spec, description) {
  if (!spec) return description;
  return [
    `ТЕХНИЧЕСКОЕ ЗАДАНИЕ (исполняй буквально):`,
    `- Название: ${spec.title}`,
    `- Жанр: ${spec.genre}`,
    `- Core loop: ${spec.core_loop}`,
    `- Победа: ${spec.win_condition}`,
    `- Поражение: ${spec.lose_condition}`,
    `- Сущности: ${(spec.entities || []).map(e => `${e.name} (${e.role}): ${e.behavior}`).join('; ') || '-'}`,
    `- Управление: ${JSON.stringify(spec.controls || {})}`,
    `- Сложность: ${spec.difficulty_curve}`,
    `- Juice (реализуй каждый): ${(spec.juice || []).join(', ')}`,
    `- Звуки (вызывай this.sfx.play(...) на каждый): ${(spec.sound_cues || []).join(', ')}`,
    `- Палитра: ${JSON.stringify(spec.art_style?.palette || [])}, настроение: ${spec.art_style?.mood || ''}`,
  ].join('\n');
}

// ============================================================
// СТАДИЯ B — CODEGEN: модель пишет ТОЛЬКО тело PlayScene
// ============================================================
const PLAY_SCENE_PROMPT = `Ты — senior Phaser.js 3.87 разработчик. Каркас игры УЖЕ ГОТОВ: BootScene, MenuScene, GameOverScene, класс SFX (Web Audio), рекорд в localStorage, переходы между сценами. Твоя задача — написать ТОЛЬКО геймплейную логику PlayScene.

ДОСТУПНОЕ ОКРУЖЕНИЕ (используй именно так):
- this.sfx — экземпляр класса SFX, метод: this.sfx.play(freq, dur, type='square', vol=0.15). Вызывай на jump/hit/collect/gameover.
- this.registry.set('score', n) / this.registry.get('score') — очки. GameOverScene сама прочитает score и сохранит рекорд.
- this.scene.start('GameOverScene') — завершение игры (победа/поражение).
- Текстура из BootScene: 'pixel' (белый квадрат 1x1). Свои текстуры создавай в create(): this.make.graphics()...generateTexture('key', w, h), затем this.add.image(...) с .setTint().
- Время: this.time.addEvent({delay, callback, loop}) — НЕ setInterval.
- Физика: this.physics.add.* / this.physics.world.enable(...). Коллизии: this.physics.add.overlap/collider.

ЗАПРЕЩЕНО (брак): setColor, setZIndex, setAnchor, setOpacity, this.add.tween, setInterval, this.sound.add. Для скруглений/цвета — make.graphics + setTint. Для анимаций — this.tweens.add. Для звука — this.sfx.play.

ОБЯЗАТЕЛЬНО:
1. Реализуй win_condition и lose_condition из ТЗ и проверяй их в update()/событиях — иначе юзер застрянет навсегда.
2. Реализуй difficulty_curve буквально (ускорение/рост числа врагов через this.time.addEvent или счётчик).
3. Реализуй КАЖДЫЙ juice из ТЗ кодом: тряска this.cameras.main.shake(150,0.01), партиклы this.add.particles(...).explode(), score popup (this.add.text + tween на y/alpha).
4. Вызывай this.sfx.play(...) на КАЖДЫЙ sound_cue из ТЗ.
5. Мобильное управление — только Phaser-объекты (this.input.keyboard / this.input.on('pointerdown') / виртуальные кнопки .setInteractive()), без HTML-оверлеев.
6. Не пиши constructor, не пиши class-обёртку, не пиши полный HTML, не пиши import.

ЧЕК-ЛИСТ ПЕРЕД ОТВЕТОМ: win/lose проверяются? juice реально в коде? звуки вызываются? нет запрещённых методов?
ГЛАВНОЕ: игрок должен СТОЯТЬ на платформах/земле и МОЧЬ прыгать — не отключай body.checkCollision.down без причины, иначе игра неиграбельна (проваливание + мёртвый прыжок). Все текстуры, используемые в create() и в this.add.particles, должны быть созданы ДО их первого использования (this.make.graphics + generateTexture раньше, чем add.sprite/image/particles).

ФОРМАТ ОТВЕТА — ТОЛЬКО методы класса, без пояснений:
preload(){ ... }
create(){ ... }
update(){ ... }`;

// Промпт для авторевью: DeepSeek проверяет сгенерированную игру и чинит баги
const REVIEW_PROMPT = `Ты — QA-инженер по Phaser.js 3.87. Ниже — HTML-игра, сгенерированная ИИ (каркас: BootScene/MenuScene/PlayScene/GameOverScene). Проверь и исправь ВСЕ баги:

1. JS-ошибки: undefined переменные, null методы, опечатки в API Phaser 3.87.
2. Физика: спавн объектов, коллизии, объекты за пределами экрана.
3. Загрузка текстур: если загружается несуществующая текстура — замени на программную генерацию (this.make.graphics() + generateTexture).
4. Геймплей-цикл: победа/поражение реально достижимы, рестарт работает, игра не застревает.
5. Мобильное управление: работает на тач-экране.
6. Производительность: объекты не плодятся вечно в update().

Сохрани название, теги <title>, meta description и СТРУКТУРУ КЛАССОВ (BootScene/MenuScene/PlayScene/GameOverScene + new Phaser.Game config) БЕЗ изменений. Не переписывай стиль игры — только чини баги.
Верни ТОЛЬКО исправленный ПОЛНЫЙ HTML-код (от <!DOCTYPE html> до </html>). Без пояснений, без markdown-обёртки.`;

// Отдельный проход "game feel" — на уже рабочем коде
const POLISH_PROMPT = `Игра технически работает. Твоя задача — ТОЛЬКО повысить ощущение "премиальности", не трогая логику победы/поражения и структуру классов (BootScene/MenuScene/PlayScene/GameOverScene + new Phaser.Game config):
1. Если анимации появления UI дёрганые/резкие — добавь this.tweens.add с ease 'Back.easeOut' или 'Cubic.easeOut'.
2. Если при попадании/сборе нет тряски камеры или партиклов — добавь.
3. Если HUD выглядит "голым текстом" — добавь фон-подложку (graphics rect с alpha) под счёт/жизни.
4. Если между сценами нет fade-перехода — добавь this.cameras.main.fadeIn(300) в create() каждой сцены.
Не меняй геймплейную логику, win/lose условия, структуру классов. Верни ТОЛЬКО полный HTML от <!DOCTYPE html> до </html>. Без пояснений, без markdown-обёртки.`;

// Legacy-путь: полная генерация HTML (для улучшения существующих игр по baseCode)
const LEGACY_SYSTEM_PROMPT = `Ты — элитный Game Developer на Phaser.js 3.87. Твоя задача — создать визуально безупречную, аддиктивную игру в ОДНОМ HTML-файле.

ГРАФИКА И АССЕТЫ (КРИТИЧНО):
1. Если текстуры не предоставлены, ГЕНЕРИРУЙ SVG и конвертируй их в текстуры Phaser.
   Пример: const svg = '<svg...>...</svg>'; const url = 'data:image/svg+xml;base64,' + btoa(svg); this.load.image('key', url);
2. Используй современные визуальные эффекты: частицы (this.add.particles), градиенты, свечение.
3. UI должен выглядеть профессионально: скруглённые углы, тени, анимации появления.

ЗВУКОВОЙ ДИЗАЙН:
1. Используй Web Audio API для генерации звуковых эффектов (синтез).
   Создай класс SoundEffects с методами: playJump(), playHit(), playWin(), playExplosion().
   Используй OscillatorNode и GainNode для создания сочных 8-бит или футуристичных звуков.

ГЕЙМДИЗАЙН И ПОЛИШ:
1. Геймплейный цикл: Заставка → Геймплей → Game Over/Win → Рестарт.
2. Фидбек (Juice): камера трясётся при ударе, частицы при взрыве, плавные твины для всех UI элементов.
3. Сложность: реализуй динамическое усложнение (ускорение врагов, увеличение их количества).
4. Управление: ПК (стрелки/WASD) + Мобильные (виртуальный джойстик или кнопки на экране, реализованные через Phaser .setInteractive()).

ТЕХНИЧЕСКИЙ СТЕК:
- Phaser 3.87 (CDN)
- Telegram WebApp SDK (hapticFeedback при столкновениях/кликах)
- Один HTML файл, всё инлайново.

Верни ТОЛЬКО чистый HTML-код. Никаких пояснений, никаких markdown блоков.`;

function buildUserPrompt(description, textures, lastError, baseCode) {
  let p = "";
  if (baseCode) {
    p = `Улучши или измени текущую игру на основе этого запроса: "${description}"\n\nТекущий код игры:\n${baseCode}\n\nВнеси изменения, сохранив общую структуру, но реализовав новые пожелания.`;
  } else {
    p = `Создай новую игру с нуля по описанию: "${description}"`;
    if (textures?.length) {
      p += `\n\nИспользуй эти текстуры в качестве референсов или напрямую:\n${textures.map(t => `- ${t.name}: ${t.url}`).join('\n')}`;
    }
  }

  p += `\n\nОБЯЗАТЕЛЬНО: Добавь синтезированные звуки через Web Audio API и визуальные эффекты частиц. Игра должна ощущаться "дорого" и качественно.`;

  if (lastError) p += `\n\nИСПРАВЬ ОШИБКУ из предыдущей попытки:\n${lastError}`;

  return p;
}

// ============================================================
// SKELETON — фиксированный, руками протестированный каркас.
// Модель вставляет сюда только тело PlayScene.
// ============================================================
function buildGameHtml(playSceneBody, spec, description) {
  const rawTitle = (spec?.title || description.slice(0, 60)).trim();
  const safeTitle = rawTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const title = rawTitle;
  const desc = spec?.core_loop || description.slice(0, 200);
  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${safeTitle}</title>
<meta name="description" content="${desc}">
<script src="https://cdn.jsdelivr.net/npm/phaser@3.87.0/dist/phaser.min.js"></script>
<style>*{margin:0;padding:0;touch-action:none}#game{width:100vw;height:100vh;background:#0a0a12}</style>
</head><body><div id="game"></div><script>
class SFX {
  constructor(){ this.ctx = new (window.AudioContext||window.webkitAudioContext)(); }
  play(freq, dur, type='square', vol=0.15){
    try {
      const o=this.ctx.createOscillator(), g=this.ctx.createGain();
      o.type=type; o.frequency.value=freq; g.gain.value=vol;
      o.connect(g); g.connect(this.ctx.destination);
      o.start(); g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime+dur);
      o.stop(this.ctx.currentTime+dur);
    } catch(e){}
  }
}
function makeUiTexture(scene, key, w, h, color){
  const g = scene.make.graphics({x:0,y:0});
  g.fillStyle(color,1); g.fillRoundedRect(0,0,w,h,{tl:8,tr:8,bl:8,br:8});
  g.generateTexture(key,w,h); g.destroy();
}
class BootScene extends Phaser.Scene {
  constructor(){ super('BootScene'); }
  create(){
    const g = this.make.graphics({x:0,y:0});
    g.fillStyle(0xffffff,1); g.fillRect(0,0,1,1); g.generateTexture('pixel',1,1); g.destroy();
    makeUiTexture(this, 'btn', 220, 64, 0x6366f1);
    makeUiTexture(this, 'btnHover', 220, 64, 0x818cf8);
    this.cameras.main.fadeIn(300);
    this.scene.start('MenuScene');
  }
}
class MenuScene extends Phaser.Scene {
  constructor(){ super('MenuScene'); }
  create(){
    this.cameras.main.fadeIn(300);
    const cx = this.cameras.main.centerX, cy = this.cameras.main.centerY;
    this.add.text(cx, cy-160, '${safeTitle}', {fontFamily:'Arial', fontSize:'48px', color:'#ffffff', fontStyle:'bold'}).setOrigin(0.5);
    const hs = parseInt(localStorage.getItem('game_highscore')||'0', 10);
    if (hs > 0) this.add.text(cx, cy-100, 'Лучший результат: ' + hs, {fontFamily:'Arial', fontSize:'22px', color:'#94a3b8'}).setOrigin(0.5);
    const btn = this.add.image(cx, cy, 'btn').setInteractive({useHandCursor:true});
    this.add.text(cx, cy, 'ИГРАТЬ', {fontFamily:'Arial', fontSize:'26px', color:'#ffffff', fontStyle:'bold'}).setOrigin(0.5);
    btn.on('pointerover', () => btn.setTexture('btnHover'));
    btn.on('pointerout', () => btn.setTexture('btn'));
    btn.on('pointerdown', () => {
      if (this.sfx && this.sfx.ctx.state === 'suspended') this.sfx.ctx.resume();
      this.scene.start('PlayScene');
    });
  }
}
class GameOverScene extends Phaser.Scene {
  constructor(){ super('GameOverScene'); }
  create(data){
    this.cameras.main.fadeIn(300);
    const score = this.registry.get('score') || 0;
    const prev = parseInt(localStorage.getItem('game_highscore')||'0', 10);
    if (score > prev) localStorage.setItem('game_highscore', String(score));
    const hs = Math.max(score, prev);
    const cx = this.cameras.main.centerX, cy = this.cameras.main.centerY;
    this.add.text(cx, cy-140, 'ИГРА ОКОНЧЕНА', {fontFamily:'Arial', fontSize:'40px', color:'#f43f5e', fontStyle:'bold'}).setOrigin(0.5);
    this.add.text(cx, cy-70, 'Счёт: ' + score, {fontFamily:'Arial', fontSize:'30px', color:'#ffffff'}).setOrigin(0.5);
    this.add.text(cx, cy-25, 'Рекорд: ' + hs, {fontFamily:'Arial', fontSize:'20px', color:'#94a3b8'}).setOrigin(0.5);
    const btn1 = this.add.image(cx-60, cy+70, 'btn').setInteractive({useHandCursor:true});
    this.add.text(cx-60, cy+70, 'ЗАНОВО', {fontFamily:'Arial', fontSize:'22px', color:'#ffffff', fontStyle:'bold'}).setOrigin(0.5);
    btn1.on('pointerdown', () => this.scene.start('PlayScene'));
    const btn2 = this.add.image(cx+60, cy+70, 'btn').setInteractive({useHandCursor:true});
    this.add.text(cx+60, cy+70, 'МЕНЮ', {fontFamily:'Arial', fontSize:'22px', color:'#ffffff', fontStyle:'bold'}).setOrigin(0.5);
    btn2.on('pointerdown', () => this.scene.start('MenuScene'));
  }
}
class PlayScene extends Phaser.Scene {
  constructor(){ super('PlayScene'); this.sfx = new SFX(); }
${playSceneBody}
}
new Phaser.Game({
  type: Phaser.AUTO, parent: 'game', width: 960, height: 540,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: [BootScene, MenuScene, PlayScene, GameOverScene]
});
<\/script></body></html>`;
}

function cleanPlaySceneBody(raw) {
  let body = raw || '';
  body = body.replace(/^```(?:js|javascript)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (/<!doctype|<html[^>]*>/i.test(body)) return null; // модель вернула полный HTML — брак
  const re = /preload\s*\(|create\s*\(/;
  const m = body.match(re);
  if (!m) return null; // нет preload/create
  const startIdx = body.indexOf(m[0]);
  body = body.slice(startIdx);
  const lastBrace = body.lastIndexOf('}');
  if (lastBrace === -1) return null;
  return body.slice(0, lastBrace + 1).trim();
}

// ============================================================
// СТАДИЯ C — QA без браузера: syntax-check + structural
// ============================================================
function checkSyntax(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]);
  for (const code of scripts) {
    try { new vm.Script(code); }
    catch (e) { return `SyntaxError: ${e.message}`; }
  }
  return null;
}

const BANNED = [
  { re: /setColor\(/i, name: 'setColor() → setTint()' },
  { re: /setZIndex\(/i, name: 'setZIndex() → setDepth()' },
  { re: /setAnchor\(/i, name: 'setAnchor() → setOrigin()' },
  { re: /setOpacity\(/i, name: 'setOpacity() → setAlpha()' },
  { re: /this\.add\.tween\(/i, name: 'this.add.tween() → this.tweens.add()' },
  { re: /setInterval\(/i, name: 'setInterval() → this.time.addEvent()' },
  { re: /this\.sound\.add\(/i, name: 'this.sound.add() — используй Web Audio API' },
];

function validateStructure(html) {
  const errors = [];
  const scenes = html.match(/class\s+\w+Scene\s+extends\s+Phaser\.Scene/gi) || [];
  if (scenes.length < 3) errors.push(`Найдено только ${scenes.length} сцен(ы), нужно минимум 3 (Menu/Play/GameOver)`);
  if (!/scene\.(start|restart)\s*\(/i.test(html)) errors.push('Нет переходов между сценами — юзер не сможет начать/перезапустить игру');
  if (!/localStorage\.(get|set)Item/i.test(html)) errors.push('Нет сохранения рекорда через localStorage');
  return errors;
}

function validateHtml(html) {
  if (!html || html.length < 100) return ['HTML слишком короткий'];
  const errs = [];
  for (const b of BANNED) {
    if (b.re.test(html)) errs.push(`Запрещён: ${b.name}`);
  }
  if (!html.includes('Phaser.Game(')) errs.push('Нет Phaser.Game()');
  const required = ['</script>', '</body>', '</html>'];
  for (const tag of required) {
    if (!html.includes(tag)) errs.push(`Нет ${tag} — HTML обрезан`);
  }
  return errs;
}

/** Все статические проверки: syntax + banned + closing + structural. Возвращает массив ошибок. */
function qaHtml(html) {
  const errs = [];
  const sx = checkSyntax(html);
  if (sx) errs.push(sx);
  errs.push(...validateHtml(html));
  errs.push(...validateStructure(html));
  return errs;
}

function cleanHtml(content) {
  let html = content || '';
  const start = html.search(/<!\s*doctype\s+html|<html[^>]*>/i);
  if (start > -1) html = html.slice(start);
  const end = html.lastIndexOf('</html>');
  if (end > -1) html = html.slice(0, end + '</html>'.length);
  html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return html.trim();
}

function ensureCdn(html) {
  const hasCDN = /jsdelivr\.net\/npm\/phaser|cdnjs\.cloudflare\.com.*phaser|unpkg\.com\/phaser/i.test(html);
  if (!hasCDN) {
    html = html.replace('</head>',
      '<script src="https://cdn.jsdelivr.net/npm/phaser@3.87.0/dist/phaser.min.js"></script>\n</head>'
    );
  }
  return html;
}

function parseSeo(html, fallbackDesc) {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/i);
  const kwMatch = html.match(/<meta\s+name=["']keywords["']\s+content=["'](.*?)["']/i);
  return {
    title: titleMatch ? titleMatch[1].trim().replace(/<[^>]*>/g, '') : 'AI Game',
    description: descMatch ? descMatch[1].trim() : (fallbackDesc || '').slice(0, 200),
    keywords: kwMatch ? kwMatch[1].trim() : 'игра, онлайн, ai, phaser',
  };
}

// ============================================================
// DeepSeek
// ============================================================
async function callDeepSeek(messages, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DS_TIMEOUT);
  const res = await fetch(DS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DS_API_KEY}` },
    body: JSON.stringify({
      model: DS_MODEL,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.max_tokens ?? 8192,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${err}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek вернул пустой ответ');
  return content;
}

async function generatePlayScene(description, spec, textures, lastError) {
  let user = specBrief(spec, description);
  if (textures?.length) {
    user += `\n\nРеференсные текстуры (можешь использовать как идеи для палитры):\n${textures.map(t => `- ${t.name}: ${t.url}`).join('\n')}`;
  }
  if (lastError) user += `\n\nПРЕДЫДУЩАЯ ПОПЫТКА НЕ ПРОШЛА QA. ИСПРАВЬ:\n${lastError}`;
  return callDeepSeek([
    { role: 'system', content: PLAY_SCENE_PROMPT },
    { role: 'user', content: user },
  ]);
}

// Ревью: обязательный проход. Если ревьюер вернул мусор — берём оригинал.
async function reviewAndFix(html, description) {
  try {
    const raw = await callDeepSeek([
      { role: 'system', content: REVIEW_PROMPT },
      { role: 'user', content: `Игра по запросу: ${description}\n\nHTML-код игры:\n${html}` },
    ], { temperature: 0.3, max_tokens: 8192 });
    const fixed = ensureCdn(cleanHtml(raw));
    const errs = qaHtml(fixed);
    if (errs.length) return null;
    return fixed;
  } catch {
    return null;
  }
}

// POLISH: только game-feel, строго после review, с повторным QA.
async function polishPass(html, description) {
  try {
    const raw = await callDeepSeek([
      { role: 'system', content: POLISH_PROMPT },
      { role: 'user', content: `Игра по запросу: ${description}\n\nHTML-код игры:\n${html}` },
    ], { temperature: 0.3, max_tokens: 8192 });
    const polished = ensureCdn(cleanHtml(raw));
    const errs = qaHtml(polished);
    if (errs.length) return null; // полировка что-то сломала — откатываем
    return polished;
  } catch {
    return null;
  }
}

// ============================================================
// Конвейер генерации
// ============================================================
async function generateNew(description, textures) {
  let spec = null;
  try { spec = await generateSpec(description); }
  catch { spec = null; } // SPEC не удался — генерим по сырому описанию

  let lastError = '';
  let best = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Best-of-2: два параллельных тела PlayScene, берём то, что прошло больше проверок
    const [bodyA, bodyB] = await Promise.all([
      generatePlayScene(description, spec, textures, lastError).catch(() => null),
      generatePlayScene(description, spec, textures, lastError).catch(() => null),
    ]);

    const candidates = [bodyA, bodyB].map((rawBody) => {
      if (!rawBody) return null;
      const body = cleanPlaySceneBody(rawBody);
      if (!body) return null;
      const html = buildGameHtml(body, spec, description);
      const errs = qaHtml(html);
      return { html, errs };
    }).filter(Boolean);

    if (!candidates.length) {
      lastError = 'Модель вернула не тело PlayScene (полный HTML/мусор). Верни ТОЛЬКО методы preload/create/update.';
      continue;
    }

    candidates.sort((a, b) => a.errs.length - b.errs.length);
    const top = candidates[0];
    if (top.errs.length === 0) { best = top.html; break; }
    best = top.html;
    lastError = `Ошибки QA (${top.errs.length}):\n- ` + top.errs.join('\n- ');
  }

  if (!best) {
    // Полный провал — отдаём последний сырой результат с пометкой
    const rawBody = await generatePlayScene(description, spec, textures, '').catch(() => null);
    const body = rawBody ? cleanPlaySceneBody(rawBody) : null;
    const html = body ? buildGameHtml(body, spec, description) : null;
    return {
      html: html || null,
      seo: html ? parseSeo(html, description) : null,
      attempts: MAX_ATTEMPTS,
      error: lastError || 'Генерация не удалась',
    };
  }

  // Обязательный review (не бонус)
  const reviewed = await reviewAndFix(best, description);
  const base = reviewed || best;

  // POLISH-проход на рабочем коде + повторный QA внутри polishPass
  const polished = await polishPass(base, description);
  const final = polished || base;

  return { html: final, seo: parseSeo(final, description), attempts: MAX_ATTEMPTS, reviewed: !!reviewed };
}

// Legacy-путь: полный HTML (улучшение существующей игры по baseCode)
async function generateLegacy(description, textures, baseCode) {
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userPrompt = buildUserPrompt(description, textures, attempt > 1 ? lastError : undefined, baseCode);
    const raw = await callDeepSeek([
      { role: 'system', content: LEGACY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);
    let html = ensureCdn(cleanHtml(raw));
    const errs = qaHtml(html);
    if (!errs.length) {
      const fixed = (await reviewAndFix(html, description)) || html;
      const polished = (await polishPass(fixed, description)) || fixed;
      return { html: polished, seo: parseSeo(polished, description), attempts: attempt, reviewed: true };
    }
    lastError = errs.join('; ');
  }
  const raw = await callDeepSeek([
    { role: 'system', content: LEGACY_SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(description, textures) },
  ]);
  const html = ensureCdn(cleanHtml(raw));
  return { html, seo: parseSeo(html, description), attempts: MAX_ATTEMPTS, error: lastError };
}

async function generate(description, textures, baseCode) {
  if (baseCode) return generateLegacy(description, textures, baseCode);
  return generateNew(description, textures);
}

// --- Supabase (lazy init) ---
let _sb = null;
function getSb() {
  if (!_sb) _sb = createClient(SB_URL, SB_KEY);
  return _sb;
}

async function updateGame(gameId, data) {
  const { error } = await getSb().from('games').update(data).eq('id', gameId);
  if (error) throw new Error(`Supabase: ${error.message}`);
}

// --- Server ---
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }

  let body = '';
  for await (const chunk of req) body += chunk;

  const startTime = Date.now();

  try {
    const job = JSON.parse(body);

    if (!job.gameId || !job.description || !job.chatId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: gameId, description, chatId' }));
      return;
    }

    // Generate via DeepSeek
    const result = await generate(job.description, job.textures || [], job.baseCode);

    if (!result.html) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error || 'Generation failed' }));
      return;
    }

    // Save to Supabase (без искусственного обрезания source_code)
    const seo = result.seo;
    await updateGame(job.gameId, {
      status: 'ready',
      source_code: result.html,
      title: seo.title,
      description: seo.description,
      deploy_url: `${PORTAL_URL}/${job.slug}`,
    });

    // Notify CF Worker callback (он отправит уведомление в Telegram)
    if (job.slug && job.chatId && seo.title) {
      const cbUrl = `${PORTAL_URL}/callback`;
      fetch(cbUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: job.slug, chatId: job.chatId, title: seo.title }),
      }).catch(() => {});
    }

    console.log(`✅ ${job.gameId} done in ${Date.now() - startTime}ms`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seo }));
  } catch (err) {
    console.error(`❌ job error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

const PORT = parseInt(process.env.PORT || '3000');
server.listen(PORT, () => console.log(`Genergame proxy on :${PORT}`));

// Global error handlers
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err?.message));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err?.message));

export { generate, qaHtml, buildGameHtml };
