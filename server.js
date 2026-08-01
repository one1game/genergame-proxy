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
const SPEC_SYSTEM_PROMPT = `Ты — геймдизайнер и архитектор игр. По короткому описанию юзера составь ПОЛНОЕ техническое задание для 2D HTML5-игры на Phaser 3.
Не меняй идею юзера. Если чего-то не хватает (тема визуала, конкретная механика усложнения, звуковой стиль, мета-прогрессия) — придумай в тон его идее, не делай дженерик.
Учти производительность на мобильных, продумай баланс сложности, добавь визуальные «соки» (juice).

Верни ТОЛЬКО JSON без пояснений, строго такой структуры:
{
  "title": "название на русском",
  "genre": "platformer|shooter|runner|puzzle|arcade|tower_defense|match3|rhythm|survival",
  "core_loop": "что игрок делает каждые 3-5 секунд, 1 фраза",
  "win_condition": "конкретное измеримое условие победы (число/время/прогресс)",
  "lose_condition": "конкретное измеримое условие поражения",
  "progression": {
    "levels": "количество и структура уровней (минимум 3)",
    "upgrades": ["список улучшений для внутриигрового магазина"],
    "economy": "как работает валюта (что собираем, на что тратим)"
  },
  "entities": [{"name":"","role":"player|enemy|hazard|pickup|projectile|platform|powerup","behavior":""}],
  "controls": {"desktop":"","mobile":"tap|joystick|swipe|buttons","special":"дополнительные жесты/клавиши"},
  "difficulty_curve": "формула или описание роста сложности со временем/очками",
  "juice": ["screen_shake","particle_burst","score_popup","trail_effect","pulse_glow","screen_flash","camera_follow"],
  "sound_cues": ["jump","hit","collect","gameover","victory","levelup","combo","shield"],
  "art_style": {"palette":["#hex","#hex","#hex","#hex"], "mood":"", "inspiration":["игра1","игра2"]},
  "performance": {"max_particles": 50, "max_enemies": 15, "optimizations":["object_pooling","cached_gradients"]},
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
    `- Мета-прогрессия: уровни: ${spec.progression?.levels || '-'}; апгрейды магазина: ${(spec.progression?.upgrades || []).join(', ') || '-'}; экономика: ${spec.progression?.economy || '-'}`,
    `- Juice (реализуй минимум половину из списка — только те, что реально работают в механиках; каждый Juice-вызов по SDK): ${(spec.juice || []).join(', ')}`,
    `- Звуки (вызови this.sfx.<cue>() минимум на половину cues — только те, что реально есть в механиках; мёртвые вызовы запрещены): ${(spec.sound_cues || []).join(', ')}`,
    `- Палитра: ${JSON.stringify(spec.art_style?.palette || [])}, настроение: ${spec.art_style?.mood || ''}, вдохновение: ${(spec.art_style?.inspiration || []).join(', ') || '-'}`,
    `- Лимиты производительности: частицы ≤ ${spec.performance?.max_particles || 50}, враги ≤ ${spec.performance?.max_enemies || 15}`,
  ].join('\n');
}

// ============================================================
// СТАДИЯ B — CODEGEN: модель пишет ТОЛЬКО тело PlayScene
// ============================================================
const PLAY_SCENE_PROMPT = `Ты — senior Phaser.js 3.87 разработчик. Каркас игры УЖЕ ГОТОВ: BootScene, MenuScene, GameOverScene, класс SFX (Web Audio), рекорд в localStorage, переходы между сценами. Твоя задача — написать ТОЛЬКО геймплейную логику PlayScene.

ДОСТУПНОЕ ОКРУЖЕНИЕ (используй именно так):
- this.sfx — экземпляр класса SFX с готовыми эффектами: this.sfx.jump(), this.sfx.dash(), this.sfx.collect(), this.sfx.hit(), this.sfx.win(), this.sfx.over(), this.sfx.levelup(), this.sfx.combo(), this.sfx.shield(), this.sfx.gameover(), this.sfx.victory(). Плюс низкоуровневый this.sfx.play(freq, dur, type, vol). Вызывай нужный звук на каждое событие.
- this.registry.set('score', n) / this.registry.get('score') — очки. GameOverScene сама прочитает score и сохранит рекорд.
- this.scene.start('GameOverScene') — завершение игры (победа/поражение).
- Готовые эффекты (Juice SDK) — НЕ пиши партиклы/тряску/попапы руками, вызывай: Juice.shake(this, intensity), Juice.burst(this, x, y, color, n), Juice.popText(this, x, y, text, color), Juice.comboFlash(this, x, y, mult). Это фирменный стиль игры. ВАЖНО: Juice.shake(this, intensity) — intensity в диапазоне 0.005–0.05 (доля экрана), НЕ пиксели: сильный удар 0.04–0.05, обычный 0.015–0.025, лёгкий 0.005–0.01. Никогда не передавай 5–20.
- Музыка: this.music = new Music(); this.music.start() — генеративный саундтрек уже готов; this.music.setTempo(bpm) — ускоряй темп по difficulty_curve (например 96 + level*12). Никогда не создавай второй экземпляр Music.
- Фирменный визуал: в самом начале create() вызови applyPostFX(this.cameras.main) — bloom+vignette (функция уже в каркасе). ЗАПРЕЩЕНО звать её и любые методы сцены (this.events.on, this.cameras, this.input и т.п.) в constructor() — они существуют только после boot сцены, в конструкторе это краш "undefined.on".
- Уровень: генерируй мир через this.rng (this.rng.between(a,b), this.rng.pick(arr), this.rng.frac()) и this.seed — НЕ через Math.random. Покажи this.seed в HUD как '#seed' — у каждого юзера свой воспроизводимый уровень.
- Существа: makeCreature(this, 'key', seed, [c1,c2,c3]) — создаёт процедурный спрайт из примитивов (мягкий блоб, не квадрат) для игрока/врагов; палитру бери из art_style.palette. ВАЖНО: makeCreature() возвращает ГОТОВЫЙ Arcade-спрайт (this.physics.add.sprite) с телом физики — присваивай результат (const s = makeCreature(...)), ставь позицию (s.setPosition(x,y)) и настраивай тело (s.body.setCollideWorldBounds(true) и т.п.). НИКОГДА не зови this.physics.add.existing(s) на объекты из makeCreature — повторная регистрация пересоздаёт body (неопределённое поведение). physics.add.existing — только для объектов БЕЗ физики (this.add.rectangle, this.add.image и т.п.).
- Цвета — ТОЛЬКО числа вида 0xRRGGBB (например 0x4a90d9), НИКОГДА строки '#RRGGBB' — setTint/fillStyle/particle tint в Phaser ждут число, строки дают чёрный/непредсказуемый цвет.
- НИКОГДА не читай Juice, Music, SFX или сцены (BootScene/MenuScene/PlayScene/GameOverScene) через window.ИмяКласса — в classic-script top-level class/const/let НЕ становятся свойствами window (window.Juice === undefined). Используй класс напрямую по имени: Juice.shake(this, ...), new SFX(), new Music().
- Текстура из BootScene: 'pixel' (белый квадрат 1x1). Свои текстуры создавай в create(): this.make.graphics()...generateTexture('key', w, h), затем this.add.image(...) с .setTint().
- Время: this.time.addEvent({delay, callback, loop}) — НЕ setInterval.
- Физика: this.physics.add.* / this.physics.world.enable(...). Коллизии: this.physics.add.overlap/collider — регистрируются ОДИН раз в create() (это привязка постоянного слушателя, а не разовая проверка); НИКОГДА не вызывай их в update() или в helper-методах, вызываемых из update() (checkCollisions и т.п.) — каждый вызов плодит нового слушателя (60 дублей/сек), игра трясётся и тормозит.
- ОДНОРАЗОВЫЕ СОБЫТИЯ ИЗ UPDATE(): любой переход сцены (this.scene.start/restart), победа/поражение (victory()/gameOver()) или другое одноразовое действие, которое проверяется в методе, вызываемом из update() (checkRoundConditions и т.п.), ОБЯЗАН быть защищён булевой защёлкой: в начале проверки 'if (this.transitioning) return;', при срабатывании — 'this.transitioning = true;' ДО вызова. Иначе условие (например currentLevel > MAX_LEVELS) остаётся истинным несколько кадров до фактического переключения сцены, и событие срабатывает повторно (двойной звук, дубль Juice, многократный scene.start).

ЗАПРЕЩЕНО (брак): setZIndex, setAnchor, setOpacity, this.add.tween, setInterval, this.sound.add. Для скруглений/цвета — make.graphics + setTint. Для анимаций — this.tweens.add. Для звука — this.sfx.play. (Примечание: setColor() легален для текста Phaser.Text, но для спрайтов его нет.)
ЗАПРЕЩЕНО ОБЪЯВЛЯТЬ: class Music, class Juice, class SFX — эти классы уже определены в каркасе ГЛОБАЛЬНО. Используй this.music / this.sfx / Juice.* как есть, не дублируй их объявления (иначе SyntaxError: Identifier already declared).

ОБЯЗАТЕЛЬНО:
1. Реализуй win_condition и lose_condition из ТЗ и проверяй их в update()/событиях — иначе юзер застрянет навсегда.
2. Реализуй difficulty_curve буквально (ускорение/рост числа врагов через this.time.addEvent или счётчик).
3. Реализуй минимум половину juice из ТЗ вызовами Juice SDK: Juice.shake(this) для screen_shake, Juice.burst(this,x,y,color) для particle_burst, Juice.popText(this,x,y,text,color) для score_popup, Juice.comboFlash(this,x,y,mult) для комбо. Не создавай собственные эмиттеры/твины для этих эффектов.
4. Вызывай this.sfx.play(...) на КАЖДЫЙ sound_cue из ТЗ, который соответствует реализованной механике (минимум половина; мёртвые вызовы несуществующих механик запрещены).
5. Мобильное управление — Phaser-тексты-кнопки (◀ ▶ ▲ DASH) с .setInteractive(), флаги виртуальных клавиш и разбор в update(), без HTML-оверлеев.
6. ПРЕМИУМ-ФИШКИ (делай минимум 4):
   - стартовый нарратив: короткая текстовая миссия в начале (this.add.text + tween fade), как в киберпанк-играх;
   - спец-механика с ресурсом: dash/двойной прыжок/щит, тратящие энергию (0-100), с полоской-индикатором и регенерацией; dash обязательно с Juice.shake(this) и Juice.burst(this,x,y,color);
   - HUD как в дорогих играх: эмодзи-иконки (💎 ❤️ ⏱ 🏆), рекорд из localStorage показывается в HUD и обновляется на лету, счёт/таймер с подложкой (graphics rect с alpha);
   - таймер миссии (обратный отсчёт 3:00) и/или условие победы по прогрессу — покажи его в HUD;
   - шлейф частиц за игроком при рывке/движении (this.add.particles(...).start() при рывке, .stop() после);
   - фоновый декор-слой: частицы окружения (дождь/искры/звёзды) или параллакс-графика в 2 слоя;
   - камера-фоллоу на игрока, если мир шире экрана (this.cameras.main.startFollow(player)) + UI с .setScrollFactor(0);
   - враги с прицеливанием: турели/дроны, стреляющие пулями в сторону игрока (Phaser.Math.Angle.Between);
    - свечение персонажа: player.postFX.addGlow(0x00ffff, 2, 0, false, 0.1, 10);
    - финальная точка/портал для победы (не только счётчик);
    - оверлей результата ВНУТРИ сцены: затемнение (add.rectangle с alpha) + заголовок (победа/поражение) + кнопка «ЗАНОВО» (scene.restart);
    - мета-прогрессия: собранные кристаллы = валюта, трать её на апгрейды во время игры через Phaser-кнопки (щит/скорость/доп. прыжок/жизнь) — как внутриигровой магазин; валюту и купленные апгрейды сохраняй через ГЛОБАЛЬНЫЕ функции saveProgress({currency, ownedUpgrades}) и loadProgress() (БЕЗ this. — это не методы сцены) — иначе прогресс сбросится при рестарте;
    - уровни: минимум 3 уровня с переходами (после сбора N кристаллов — level up: перестройка уровня, прогресс-бар, респаун на безопасной платформе, надпись «УРОВЕНЬ N»);
    - комбо-система: быстрый сбор подряд накапливает множитель (🔥 x5), показывается в HUD и затухает через пару секунд;
    - пауза: клавиша ESC + кнопка ⏸ → this.physics.pause() + оверлей «ПАУЗА» с «ПРОДОЛЖИТЬ» (this.physics.resume());
    - щит/неуязвимость с видимым пузырём-графикой (this.add.circle + setStrokeStyle вокруг игрока) и отрисовкой повреждений.
7. ЭСТЕТИКА: единая палитра из ТЗ (art_style.palette), у объектов тени/свечение через setShadow или tint, чистая композиция, ничего не выглядит "голым текстом".
8. ЧИСТЫЙ КОД (критично, как senior-разработчик):
   - кешируй в create() всё, что нужно update(): клавиши (const keys = this.input.keyboard.addKeys(...) ОДИН раз), спрайты, тексты — НИКОГДА не вызывай this.input.keyboard.addKeys / this.add.* / this.physics.add.* внутри update();
   - прыжок — только через Phaser.Input.Keyboard.JustDown (без автоповтора при удержании);
   - не вызывай setTint/setAlpha каждый кадр без необходимости (не затирай эффекты удара);
   - звуки — только через this.sfx.* (jump/dash/collect/hit/win/over), без хардкода частот в каждом месте;
   - не оставляй мёртвый код: неиспользуемые переменные, флаги, обработчики, никогда не срабатывающие ветки;
   - если мир шире экрана — камера ОБЯЗАНА следовать за игроком (this.cameras.main.startFollow(player) строго ПОСЛЕ создания player, ОДИН раз, без дублей), иначе часть уровня недостижима;
   - тайминги согласованы: сообщение/анимация не короче отложенного рестарта.
9. ПРОФЕССИОНАЛЬНЫЕ ПРИНЦИПЫ:
   - разбей update() на helper-методы: updatePlayer()/updateEnemies()/checkCollisions()/updateHUD() — по одному действию на метод;
   - все числовые настройки вынеси в константы вверху create()/класса (GRAVITY, SPEED, MAX_LIVES, JUMP_FORCE...) — без магических чисел в теле;
   - ограничь количество сущностей (MAX_DRONES, MAX_PARTICLES и т.п.) — не плоди бесконечно, удаляй объекты за границами экрана;
   - единая точка обновления UI: один метод updateHUD()/refreshUI(), вызывай его при любом изменении счёта/жизней/таймера — не обновляй текст в 10 местах;
   - localStorage — ТОЛЬКО в try/catch (браузер может блокировать);
   - если entity сложная (дрон/турель с логикой) — вынеси её в класс, наследуемый от Phaser.Physics.Arcade.Sprite, и добавь туда методы (update/shoot/onHit);
   - используй delta из update(time, delta) для всех ручных таймеров/движений.

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
6. Производительность: объекты не плодятся вечно в update(). physics.add.overlap/collider — ТОЛЬКО один раз в create(), не в update() и не в helper-методах, вызываемых из update() (каждый вызов = новый слушатель, 60 дублей/сек). startFollow(объект) — только ПОСЛЕ создания объекта и без дублей. Никогда не читай классы (Juice/Music/SFX/сцены) через window.ИмяКласса — top-level class в classic script не попадает в window (window.Juice === undefined), обращайся напрямую по имени.
7. НЕ зови this.physics.add.existing(X) на объекты, созданные через makeCreature() — она уже возвращает this.physics.add.sprite с телом физики; повторный вызов пересоздаёт body. physics.add.existing — только для объектов без физики (this.add.rectangle/image и т.п.).
8. Одноразовые события/переходы сцен, проверяемые в update() или в helper-методах из update() (victory()/gameOver()/levelComplete() и т.п.), защищай булевой защёлкой: 'if (this.transitioning) return;' в начале, 'this.transitioning = true;' ДО срабатывания. Без защёлки условие (currentLevel > MAX_LEVELS и т.п.) истинно несколько кадров до переключения сцены → событие дублируется (двойной звук/двойной juice/многократный scene.start).
9. Здоровье/бары: не читай entity.hp/sprite.hp (у спрайтов нет такого свойства — это NaN, в fillRect он ФАТАЛЬНО крашит Canvas: TypeError: non-finite, create() не доходит до конца). Ширина полосы при создании — константа 100%. Здоровье храни в this.playerHP/this.enemyHP.
10. Seed: this.rng/this.seed — ОДИН раз в constructor(); не перезаписывай в create() (seed-based replayability ломается, прогресс игнорируется).
11. Счёт: обязательно this.registry.set('score', n) при изменении счёта и перед scene.start('GameOverScene') — GameOverScene читает только registry.get('score'), без set счёт всегда 0.

Сохрани название, теги <title>, meta description и СТРУКТУРУ КЛАССОВ (BootScene/MenuScene/PlayScene/GameOverScene + new Phaser.Game config) БЕЗ изменений. Не переписывай стиль игры — только чини баги.
Верни ТОЛЬКО исправленный ПОЛНЫЙ HTML-код (от <!DOCTYPE html> до </html>). Без пояснений, без markdown-обёртки.`;

// Отдельный проход "game feel" — на уже рабочем коде
const POLISH_PROMPT = `Игра технически работает. Твоя задача — ТОЛЬКО повысить ощущение "премиальности", не трогая логику победы/поражения и структуру классов (BootScene/MenuScene/PlayScene/GameOverScene + new Phaser.Game config):
1. Если анимации появления UI дёрганые/резкие — добавь this.tweens.add с ease 'Back.easeOut' или 'Cubic.easeOut'.
2. Если при попадании/сборе нет тряски камеры или партиклов — добавь.
3. Если HUD выглядит "голым текстом" — добавь фон-подложку (graphics rect с alpha) под счёт/жизни.
4. Если между сценами нет fade-перехода — добавь this.cameras.main.fadeIn(300) в create() каждой сцены.
Не меняй геймплейную логику, win/lose условия, структуру классов. Верни ТОЛЬКО полный HTML от <!DOCTYPE html> до </html>. Без пояснений, без markdown-обёртки.`;

// Мультипасс: точечная самокритика лучшего кандидата ДО полной регенерации
const CRITIQUE_PROMPT = `Ты — строгий самокритик геймплейного кода на Phaser 3.87. Ниже — ТЗ и тело PlayScene-сцены (только методы preload/create/update). Найди 3 САМЫХ СЛАБЫХ места: нереализованные механики из ТЗ, скучная/рваная сложность, отсутствие juice (Juice.shake/Juice.burst/Juice.popText), пропущенные звуки (this.sfx.*), потенциальные баги, дублирование кода. ПЕРЕПИШИ только эти фрагменты точечно. НЕ переписывай весь код и не трогай рабочие места. Сохрани сигнатуры preload()/create()/update(). Верни ТОЛЬКО исправленный код методов, без пояснений, без markdown-обёртки.
Новые правила (исполняй буквально):
- this.cameras.main.startFollow(объект) — строго ПОСЛЕ создания объекта (this.player = ...) и БЕЗ дублей: если правильный вызов уже есть после присваивания, УДАЛИ более ранний сломанный (первый роняет create() с TypeError: Cannot read properties of undefined).
- physics.add.overlap/collider регистрируются ТОЛЬКО в create() и ТОЛЬКО один раз. В update() и в helper-методах, вызываемых из update() (checkCollisions и т.п.), их быть не должно — каждый вызов = новый постоянный слушатель, 60 дублей в секунду, игра трясётся и тормозит. Перенеси регистрацию в create().
- НИКОГДА не обращайся к Juice, Music, SFX и сценам через window.ИмяКласса — top-level class/const/let не попадают в window (window.Juice === undefined). Только напрямую по имени: Juice.shake(this, ...), new SFX(), new Music().
- НЕ зови this.physics.add.existing(X) на объекты, созданные через makeCreature() — она уже возвращает this.physics.add.sprite с телом; повторный вызов пересоздаёт body. physics.add.existing — только для this.add.rectangle/image и прочих объектов без физики.
- Полоски HP/бары: НИКОГДА не читай entity.hp / sprite.hp — у спрайтов НЕТ свойства hp (здоровье храни в this.playerHP/this.enemyHP). Ширина полосы при создании — константа (100%), не выражение с делением. NaN в fillRect (undefined/100) = ФАТАЛЬНЫЙ краш Canvas (TypeError: non-finite), create() падает, игра чёрная.
- Seed/replayability: this.seed и this.rng инициализируй ОДИН раз — в constructor() (из loadProgress(), как в каркасе); НИКОГДА не перезаписывай this.seed/this.rng в create() через Math.random — уровень станет невоспроизводимым, сохранённый прогресс игнорируется.
- Счёт: this.registry.set('score', n) на КАЖДОЕ изменение счёта и обязательно перед scene.start('GameOverScene') — GameOverScene читает ТОЛЬКО registry.get('score') (или || 0); без set счёт всегда 0.
- Одноразовые события/переходы сцен из update()-вызываемых методов защищай защёлкой: 'if (this.transitioning) return;' + 'this.transitioning = true;' ДО срабатывания (иначе victory()/gameOver() дублируются за кадры до переключения сцены: двойной звук, двойной Juice, многократный scene.start).

ОБЯЗАТЕЛЬНО при правках: проверь каждый вызов .on(, .emit(, .destroy(), .setTexture() — объект ПЕРЕД вызовом не должен быть undefined (особенно this.events, this.input, this.music, this.sfx, кастомные объекты сцены, результаты this.scene.get(...) и this.physics.add.*). Если объект может не существовать к моменту вызова — добавь проверку (if (this.xxx)) или перенеси вызов в create() до его использования. Симптом этого бага: "Cannot read properties of undefined (reading 'on')".
Также проверь ПОРЯДОК ВЫЗОВОВ в create(): любой метод, который получает this.player/this.enemy/другой игровой объект АРГУМЕНТОМ (this.cameras.main.startFollow(this.player,...), this.physics.add.collider(...), this.physics.add.overlap(...)), должен вызываться ПОСЛЕ строки, где этот объект создаётся (this.player = this.physics.add.sprite(...) и т.п.), а не до неё. Симптом: "Cannot read properties of undefined (reading 'x')" — сцена обрывается на этой строке, остальной create() не выполняется.
Также проверь СКОУП ПЕРЕМЕННЫХ в helper-методах (updatePlayer(delta), updateEnemies(delta) и т.п.): каждая переменная, используемая внутри метода, должна быть либо его параметром, либо this-свойством, либо объявлена внутри. НИКОГДА не используй переменные из сигнатуры update(time, delta) (time/delta) внутри метода, которому они не переданы. Если нужен time — передай его параметром (updatePlayer(time, delta)) или используй this.time.now. Симптом: "ReferenceError: time is not defined" — краш при первом же вызове метода.`;

// Самокритика: дешевле полной регенерации. Мусор на выходе — откат к оригиналу.
async function selfCritique(body, spec, description, issues) {
  try {
    const raw = await callDeepSeek([
      { role: 'system', content: CRITIQUE_PROMPT },
      { role: 'user', content: `ТЗ:\n${specBrief(spec, description)}\n${issues && issues.length ? '\nОШИБКИ QA (исправь каждую):\n- ' + issues.join('\n- ') + '\n' : ''}\nКод PlayScene:\n${body}` },
    ], { temperature: 0.3, max_tokens: 8192 });
    return cleanPlaySceneBody(raw) || body;
  } catch { return body; }
}

// Legacy-путь: полная генерация HTML (для улучшения существующих игр по baseCode)
const LEGACY_SYSTEM_PROMPT = `Ты — элитный Game Developer на Phaser.js 3.87. Твоя задача — создать визуально безупречную, аддиктивную игру в ОДНОМ HTML-файле.

ГРАФИКА И АССЕТЫ (КРИТИЧНО):
1. Если текстуры не предоставлены, ГЕНЕРИРУЙ их программно (this.make.graphics + generateTexture) ДО первого использования.
2. Используй современные визуальные эффекты: частицы (this.add.particles), свечение (postFX.addGlow), тряска камеры (cameras.main.shake).
3. UI профессиональный: эмодзи-иконки в HUD (💎 ❤️ ⏱ 🏆), подложки под текст, скруглённые элементы.

ЗВУКОВОЙ ДИЗАЙН:
1. Web Audio API (синтез OscillatorNode + GainNode). Класс SoundEffects с методами playJump/playHit/playWin/playExplosion.
2. AudioContext инициализируй ПО КЛИКУ (стартовый оверлей «НАЖМИ, ЧТОБЫ НАЧАТЬ», pointerdown → initAudio + скрытие оверлея).
3. Разные звуки на: прыжок, сбор, урон, победа, поражение.

ГЕЙМДИЗАЙН И ПОЛИШ:
1. Цикл: Заставка → Геймплей → Game Over/Win → Рестарт (кнопка «ЗАНОВО»).
2. Juice: тряска камеры при ударе, партиклы при взрыве/сборе, всплывающие очки (+10), плавные твины UI.
3. Динамическая сложность (ускорение врагов, рост их числа).
4. ПРЕМИУМ-ФИШКИ (минимум 4): стартовый нарратив-миссия; спец-механика с энергией (dash 0-100 + индикатор + тряска + партиклы); HUD с эмодзи и рекордом из localStorage (обновляется на лету) + таймер миссии; шлейф частиц; параллакс-фон; камера-фоллоу при широком мире + UI setScrollFactor(0); прицельные враги (Phaser.Math.Angle.Between); оверлей результата с «ЗАНОВО» (scene.restart); мета-прогрессия (магазин апгрейдов за кристаллы: щит/скорость/прыжок/жизнь); минимум 3 уровня с переходами и прогресс-баром; комбо 🔥; пауза ESC/⏸.
5. Мобильное управление: виртуальные кнопки (◀ ▶ ▲ DASH) через Phaser .setInteractive() ИЛИ DOM-кнопки с pointerdown/up флагами.

ЧИСТЫЙ КОД (как senior-разработчик):
1. Кешируй клавиши/объекты в create(), НЕ вызывай addKeys/this.add.* в update().
2. Прыжок — JustDown, без автоповтора.
3. Все числа в константы, без магических чисел. Лимиты сущностей (MAX_DRONES, MAX_PARTICLES).
4. Единая точка обновления UI (refreshUI()). localStorage только в try/catch.
5. update() разбит на helper-методы (updatePlayer/updateEnemies/checkCollisions).
6. Мир шире экрана → камера ОБЯЗАНА следовать за игроком, иначе часть уровня недостижима.
7. Не оставляй мёртвый код, тайминги сообщений/рестарта согласованы.

ТЕХНИЧЕСКИЙ СТЕК:
- Phaser 3.87 (CDN), Telegram WebApp SDK (hapticFeedback при ударах/кликах), один HTML файл, всё инлайново.

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
function buildGameHtml(playSceneBody, spec, description, meta) {
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
<style>*{margin:0;padding:0;touch-action:none;-webkit-user-select:none;user-select:none}#game{width:100vw;height:100vh;background:#0a0a12;display:flex;justify-content:center;align-items:center}.scanlines{position:fixed;top:0;left:0;width:100vw;height:100vh;background:linear-gradient(rgba(18,16,16,0) 50%,rgba(0,0,0,0.25) 50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06));background-size:100% 4px,6px 100%;pointer-events:none;z-index:9999;opacity:0.55}#startScreen{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(5,5,16,0.96);display:flex;flex-direction:column;justify-content:center;align-items:center;z-index:10000;cursor:pointer}#startScreen h1{color:#00ffff;font-family:monospace;font-size:34px;text-shadow:0 0 18px #00ffff;margin:0 16px 12px;text-align:center}#startScreen p{color:#ff00ff;font-family:monospace;font-size:16px;animation:blink 1.2s infinite}@keyframes blink{50%{opacity:0.3}}</style>
</head><body><div class="scanlines"></div><div id="startScreen"><h1>${safeTitle}</h1><p>[ НАЖМИ В ЛЮБОМ МЕСТЕ, ЧТОБЫ НАЧАТЬ ]</p></div><div id="game"></div><script>
let _actx=null;
function ensureAudio(){
  if(!_actx){try{_actx=new(window.AudioContext||window.webkitAudioContext)();}catch(e){}}
  if(_actx&&_actx.state==='suspended')_actx.resume();
  return _actx;
}
document.getElementById('startScreen').addEventListener('pointerdown',function(){ensureAudio();this.style.display='none';});
function loadHS(){try{return parseInt(localStorage.getItem('game_highscore')||'0',10);}catch(e){return 0;}}
function saveHS(v){try{localStorage.setItem('game_highscore',String(v));}catch(e){}}
function loadProgress(){try{return JSON.parse(localStorage.getItem('game_progress')||'{}')||{};}catch(e){return {};}}
function saveProgress(p){try{localStorage.setItem('game_progress',JSON.stringify(p||{}));}catch(e){}}
// ======= Идентификация игры для лидерборда =======
// window.* (не const) — иначе не попадает в window и window.GAME_ID в фетче лидерборда всегда undefined
window.GAME_ID = ${JSON.stringify((meta && meta.gameId) || '')};
// ======= Генеративная музыка: арпеджио-луп, темп растёт со сложностью =======
class Music {
  constructor(){ this.ctx=ensureAudio(); this.tempo=96; this.step=0; this.playing=false; this.timer=null; }
  _note(f, delay, dur){
    if(!this.ctx) return;
    try{
      const t=this.ctx.currentTime+delay;
      const o=this.ctx.createOscillator(), g=this.ctx.createGain();
      o.type='triangle'; o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.05,t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
      o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t+dur+0.05);
    }catch(e){}
  }
  start(){ if(this.playing) return; this.playing=true; this.step=0; this._loop(); }
  stop(){ this.playing=false; if(this.timer){ clearTimeout(this.timer); this.timer=null; } }
  setTempo(bpm){ this.tempo=Math.max(60,Math.min(200,bpm)); }
  _loop(){
    if(!this.playing) return;
    const eighth=(60/this.tempo)/2, s=this.step;
    const arp=[220,277,330,440,554,660,440,330], bass=[110,110,82,98];
    this._note(arp[s%arp.length], 0, 0.22);
    this._note(arp[(s+2)%arp.length]*2, eighth, 0.2);
    this._note(arp[(s+4)%arp.length], eighth*2, 0.18);
    this._note(bass[Math.floor(s/4)%bass.length], 0, 0.5);
    this.step++;
    this.timer=setTimeout(()=>this._loop(), eighth*1000);
  }
}
// ======= Juice SDK: вылизованные эффекты, модель только вызывает =======
class Juice {
  static shake(scene, i=0.01){ scene.cameras.main.shake(150,i); }
  static burst(scene,x,y,color=0xffffff,n=14){
    const em=scene.add.particles(x,y,'pixel',{speed:{min:80,max:260},angle:{min:0,max:360},scale:{start:0.9,end:0},lifespan:500,gravityY:300,tint:color,emitting:false});
    em.explode(n); scene.time.delayedCall(700,()=>em.destroy());
  }
  static popText(scene,x,y,text,color='#ffffff'){
    const t=scene.add.text(x,y,text,{fontFamily:'Arial',fontSize:'26px',fontStyle:'bold',color}).setOrigin(0.5).setDepth(999);
    scene.tweens.add({targets:t,y:y-60,alpha:0,duration:700,ease:'Cubic.easeOut',onComplete:()=>t.destroy()});
    return t;
  }
  static comboFlash(scene,x,y,mult){
    const t=scene.add.text(x,y,'🔥 x'+mult,{fontFamily:'Arial',fontSize:'34px',fontStyle:'bold',color:'#ff8800'}).setOrigin(0.5).setDepth(999);
    scene.tweens.add({targets:t,scale:1.5,alpha:0,duration:500,ease:'Back.easeOut',onComplete:()=>t.destroy()});
    return t;
  }
}
// ======= Фирменный постпроцессинг: bloom + vignette поверх scanlines =======
function applyPostFX(cam){
  try{ cam.postFX.addBloom(0xffffff,0.35,1,0.35,1.4); cam.postFX.addVignette(0.25,0.8); }catch(e){}
}
// ======= Процедурные существа: блоб из примитивов по seed (не квадраты) =======
function makeCreature(scene, key, seed, palette){
  const rng=new Phaser.Math.RandomDataGenerator(String(seed));
  const g=scene.make.graphics({x:0,y:0}); const s=32, c=palette||[0x22d3ee,0x818cf8,0xffffff];
  g.fillStyle(c[0],1);
  g.fillCircle(s/2+rng.between(-4,4), s/2+rng.between(-4,4), rng.between(11,15));
  g.fillCircle(s/2+rng.between(-9,9), s/2+rng.between(-7,7), rng.between(8,12));
  g.fillStyle(c[1],1);
  g.fillCircle(s/2+rng.between(-3,3), s/2-rng.between(8,12), rng.between(4,6));
  g.fillStyle(c[2],1);
  g.fillCircle(s/2+rng.between(-5,5), s/2+rng.between(-5,5), rng.between(2,4));
  g.fillStyle(c[1],1);
  g.fillRect(s/2-6,s/2+8,4,rng.between(6,10)); g.fillRect(s/2+3,s/2+8,4,rng.between(6,10));
  g.generateTexture(key,s,s); g.destroy();
  return scene.physics.add.sprite(0,0,key);
}
class SFX {
  constructor(){ this.ctx=ensureAudio(); }
  play(freq, dur, type='square', vol=0.15){
    try {
      const o=this.ctx.createOscillator(), g=this.ctx.createGain();
      o.type=type; o.frequency.value=freq; g.gain.value=vol;
      o.connect(g); g.connect(this.ctx.destination);
      o.start(); g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime+dur);
      o.stop(this.ctx.currentTime+dur);
    } catch(e){}
  }
  tone(freq, dur, type, vol, slide){
    if(!this.ctx) return;
    try {
      const o=this.ctx.createOscillator(), g=this.ctx.createGain(), t=this.ctx.currentTime;
      o.type=type; o.frequency.value=freq;
      if(slide) o.frequency.exponentialRampToValueAtTime(Math.max(30,freq+slide), t+dur);
      g.gain.value=vol; g.gain.exponentialRampToValueAtTime(0.001, t+dur);
      o.connect(g); g.connect(this.ctx.destination); o.start(); o.stop(t+dur);
    } catch(e){}
  }
  jump(){ this.tone(200,0.1,'square',0.1,400); }
  dash(){ this.tone(150,0.15,'sawtooth',0.15,400); }
  collect(){ this.tone(880,0.08,'sine',0.1,200); setTimeout(()=>this.tone(1320,0.12,'sine',0.1,150),50); }
  hit(){ this.tone(120,0.3,'sawtooth',0.2,-60); try{if(window.Telegram?.WebApp?.HapticFeedback)window.Telegram.WebApp.HapticFeedback.impactOccurred('heavy');}catch(e){} }
  win(){ [523,659,783,1046].forEach((f,i)=>setTimeout(()=>this.tone(f,0.3,'square',0.15),i*100)); }
  over(){ this.tone(400,0.6,'sawtooth',0.4,-360); }
  levelup(){ this.tone(660,0.1,'square',0.12,220); setTimeout(()=>this.tone(880,0.12,'square',0.12,220),80); }
  combo(){ this.tone(980,0.08,'square',0.12,300); }
  shield(){ this.tone(440,0.2,'sine',0.12,120); }
  gameover(){ this.over(); }
  victory(){ this.win(); }
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
    applyPostFX(this.cameras.main);
    const cx = this.cameras.main.centerX, cy = this.cameras.main.centerY;
    this.add.text(cx, cy-160, '${safeTitle}', {fontFamily:'Arial', fontSize:'48px', color:'#ffffff', fontStyle:'bold'}).setOrigin(0.5);
    const hs = loadHS();
    if (hs > 0) this.add.text(cx, cy-100, 'Лучший результат: ' + hs, {fontFamily:'Arial', fontSize:'22px', color:'#94a3b8'}).setOrigin(0.5);
    const btn = this.add.image(cx, cy, 'btn').setInteractive({useHandCursor:true});
    this.add.text(cx, cy, 'ИГРАТЬ', {fontFamily:'Arial', fontSize:'26px', color:'#ffffff', fontStyle:'bold'}).setOrigin(0.5);
    btn.on('pointerover', () => btn.setTexture('btnHover'));
    btn.on('pointerout', () => btn.setTexture('btn'));
    btn.on('pointerdown', () => {
      ensureAudio(); // стартовый экран уже resume'нул ctx, тут подстраховка
      this.scene.start('PlayScene');
    });
  }
}
class GameOverScene extends Phaser.Scene {
  constructor(){ super('GameOverScene'); }
  create(data){
    this.cameras.main.fadeIn(300);
    applyPostFX(this.cameras.main);
    const score = this.registry.get('score') || 0;
    const prev = loadHS();
    if (score > prev) saveHS(score);
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
    // Лидерборд: шлём результат, показываем место среди игроков с тем же seed
    try {
      const seed = (loadProgress() && loadProgress().seed) || 0;
      fetch(location.origin + '/api/score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: window.GAME_ID || '', seed, score })
      }).then(r => r.json()).then(j => {
        if (j && j.rank && this.scene.isActive())
          this.add.text(cx, cy+130, '🏆 Рейтинг: #' + j.rank + ' из ' + j.total + ' · уровень #' + seed, {fontFamily:'Arial', fontSize:'18px', color:'#fbbf24'}).setOrigin(0.5);
      }).catch(() => {});
    } catch(e){}
  }
}
class PlayScene extends Phaser.Scene {
  constructor(){
    super('PlayScene');
    this.sfx = new SFX();
    // Seed-based replayability: у каждого юзера свой воспроизводимый уровень
    const prog = loadProgress();
    this.seed = prog.seed || (1000 + Math.floor(Math.random()*9000));
    saveProgress(Object.assign({}, prog, { seed: this.seed }));
    this.rng = new Phaser.Math.RandomDataGenerator(String(this.seed));
    this.music = new Music();
  }
  shutdown(){ if (this.music) this.music.stop(); }
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
  // setColor убран: это валидный API для Phaser.Text (текст), а для спрайтов его
  // отсутствие поймает headless-смоук как runtime-ошибку "setColor is not a function"
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
  // this.events/this.input/this.cameras появляются ТОЛЬКО после создания сцены Phaser'ом,
  // а не в её constructor(). this.events.on(...) в конструкторе = crash "undefined.on" при старте.
  for (const m of html.matchAll(/constructor\s*\(\s*\)\s*\{[^}]*\}/g)) {
    if (/\.(on|emit|setTexture)\s*\(/.test(m[0])) {
      errors.push('this.events/this.input и т.п. вызываются в constructor() сцены — Phaser создаёт их ПОСЛЕ конструктора, перенеси в create()');
      break;
    }
  }
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

// Структурные проверки для legacy-генераций (монолит, нет скелетона)
function legacyStructuralErrors(html) {
  const errs = [];
  // Мир шире экрана: setBounds/координаты уровня > 1500, но нет камеры-фоллоу
  const hasWideWorld = /world\.setBounds\([^)]*,[^)]*,\s*[12]\d{3,}/.test(html)
    || /Between\(\s*-?\d+,\s*[12]\d{3,}/.test(html)
    || /level\s*=\s*\[[^\]]*[12]\d{3,}/.test(html);
  if (hasWideWorld && !/startFollow/.test(html)) {
    errs.push('камера не следует за игроком: мир шире экрана (>1500px) — добавь this.cameras.main.setBounds(0,0,W,H) и this.cameras.main.startFollow(player), иначе часть уровня недостижима');
  }
  // localStorage без try/catch
  if (/localStorage\.(get|set)Item/.test(html) && !/catch\s*\(/.test(html)) {
    errs.push('localStorage используется без try/catch — оберни все чтения/записи в try/catch');
  }
  return errs;
}

// ============================================================
// QA по чек-листу SPEC: сверяем, что модель РЕАЛЬНО сделала заявленное в ТЗ
// ============================================================
function checkSpecCoverage(html, spec) {
  const errs = [];
  if (!spec) return errs;
  // Звуки: требуем БОЛЬШИНСТВО заявленных cues (а не все) — cue вида combo/shield/levelup
  // легитимно отсутствует, если в игре нет этой механики (мёртвый вызов = брак по тем же правилам)
  const cues = spec.sound_cues || [];
  const missing = cues.filter(cue => !new RegExp(`sfx\\.${cue}\\(`, 'i').test(html));
  if (cues.length > 0 && missing.length > cues.length / 2)
    errs.push(`звуки: из ${cues.length} cues ТЗ вызвано меньше половины (не найдены: ${missing.join(', ')})`);
  // Juice: как и со звуками — требуем большинство, а не все (juice-список из ТЗ это
  // wish-list; часть эффектов легитимно не подходит под механику конкретной игры)
  const juiceMap = {
    screen_shake: /Juice\.shake\(|cameras\.main\.shake/i,
    particle_burst: /Juice\.burst\(|\.explode\(/i,
    score_popup: /Juice\.popText\(|tweens\.add[\s\S]{0,80}(y|alpha)/i,
    camera_follow: /startFollow/i,
    trail_effect: /particles[^)]*\.(start|stop)\(|setEmitZone|\.emitter/i,
    pulse_glow: /postFX\.addGlow|pulse|setGlow/i,
    screen_flash: /\.flash\(|fadeIn/i,
  };
  const juiceMisses = (spec.juice || []).filter(j => juiceMap[j] ? !juiceMap[j].test(html) : false);
  if ((spec.juice || []).length > 0 && juiceMisses.length > (spec.juice || []).length / 2)
    errs.push(`juice: из ${(spec.juice || []).length} заявленных реализовано меньше половины (не найдены: ${juiceMisses.join(', ')})`);
  const premiumRe = ['shop|upgrade', 'level\\s*up|УРОВЕНЬ', 'combo|комбо', 'shield|щит', 'dash', 'pause|ПАУЗА'];
  const premiumCount = premiumRe.filter(re => new RegExp(re, 'i').test(html)).length;
  if (premiumCount < 4) errs.push(`премиум-фишек найдено ${premiumCount}/4 минимум`);
  if (spec.progression && (spec.progression.economy || (spec.progression.upgrades && spec.progression.upgrades.length))) {
    if (!/loadProgress\(|saveProgress\(/.test(html))
      errs.push('мета-прогрессия заявлена в ТЗ, но loadProgress()/saveProgress() не используются — валюта/апгрейды сбросятся при рестарте');
  }
  return errs;
}

/** Скоринг кандидата: штраф за QA-ошибки и пропуски ТЗ, бонус за полноту кода */
function candidateScore(c) {
  return -c.errs.length * 10 - c.specMisses.length * 3 + (c.html.length / 1000);
}

// Детектор неопределённых методов: модель вызвала this.foo(), но foo не объявлен
// в классе и не является объектом Phaser. Ловит ReferenceError-краши на этапе QA,
// до того как игра попадёт к юзеру.
// Детектор вызовов на fixed-объектах каркаса: this.sfx.*(), this.music.*(), Juice.*
// Скелетон фиксированный — список методов конечен. Модель вызывает this.sfx.boost()
// (метода нет) — регекс this.xxx() его не видит, а здесь это краш на первом же событии.
function detectFixedApiCalls(body) {
  if (!body) return [];
  const errs = [];
  const sfxMethods = new Set(['play','tone','jump','dash','collect','hit','win','over','levelup','combo','shield','gameover','victory']);
  const musicMethods = new Set(['start','stop','setTempo']);
  const juiceMethods = new Set(['shake','burst','popText','comboFlash']);
  for (const m of body.matchAll(/this\.sfx\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!sfxMethods.has(m[1])) errs.push(`this.sfx.${m[1]}() не существует — доступны: ${[...sfxMethods].join(', ')}`);
  }
  for (const m of body.matchAll(/this\.music\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!musicMethods.has(m[1])) errs.push(`this.music.${m[1]}() не существует — доступны: ${[...musicMethods].join(', ')}`);
  }
  for (const m of body.matchAll(/Juice\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!juiceMethods.has(m[1])) errs.push(`Juice.${m[1]}() не существует — доступны: ${[...juiceMethods].join(', ')}`);
  }
  return errs;
}

// Детектор строк-цветов: модель пишет '#RRGGBB' вместо 0xRRGGBB в Phaser API
// (setTint/fillStyle/particle tint ждут число). Строки дают чёрный/непредсказуемый цвет.
function detectColorStrings(body) {
  if (!body) return [];
  const errs = [];
  const re = /(?:setTint|setFillStyle|fillStyle|tint)\s*\(\s*['"]#[0-9a-fA-F]{6}['"]/g;
  for (const m of body.matchAll(re)) {
    errs.push(`Цвет строкой вместо числа: ${m[0].trim()} — используй 0xRRGGBB (например 0x4a90d9), а не '#RRGGBB'`);
  }
  const reBurst = /Juice\.burst\([^)]*['"]#[0-9a-fA-F]{6}['"]/g;
  for (const m of body.matchAll(reBurst)) {
    errs.push(`Juice.burst цвет строкой: ${m[0].trim().slice(0, 60)} — передавай число 0xRRGGBB`);
  }
  return errs;
}

// Детектор доступа к классам через window: в classic-script top-level class/const/let
// НЕ попадают в window (в отличие от function/var). window.Juice/window.Music/window.SFX/
// window.*Scene ВСЕГДА undefined — this.Juice = window.Juice даёт undefined, и первый же
// this.Juice.shake() роняет игру. Это не эвристика, а жёсткий факт про scoping.
function detectWindowClassAccess(body) {
  if (!body) return [];
  const m = body.match(/window\.(Juice|Music|SFX|BootScene|MenuScene|PlayScene|GameOverScene)\b/g);
  if (!m) return [];
  return [...new Set(m)].map(x => `${x} — классы скелетона не попадают в window (top-level class в classic script), обращайся напрямую по имени (Juice.shake(...)), не через window.`);
}

// Двойная регистрация физики: makeCreature() уже возвращает physics.add.sprite (тело есть),
// повторный this.physics.add.existing(this.X) пересоздаёт body — неопределённое поведение.
function detectDoublePhysicsAdd(body) {
  if (!body) return [];
  const errs = [];
  for (const m of body.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=\s*makeCreature\s*\(/g)) {
    const name = m[1];
    if (new RegExp(`physics\\.add\\.existing\\(\\s*this\\.${name}\\s*\\)`).test(body)) {
      errs.push(`this.${name} = makeCreature(...) уже возвращает Arcade-спрайт с телом — удали this.physics.add.existing(this.${name}) (повторная регистрация пересоздаёт body)`);
    }
  }
  return errs;
}

// Чтение .hp у объекта без объявления: у спрайтов нет свойства hp (здоровье в this.playerHP),
// undefined/100 = NaN в fillRect → фатальный краш Canvas (TypeError: non-finite), create() падает.
function detectUndefinedHp(body) {
  if (!body) return [];
  const masked = maskNonCode(body); // убрать строки/комментарии (иначе упоминание в тексте — ложняк)
  const errs = [];
  const reads = new Set();
  for (const m of masked.matchAll(/([A-Za-z_$][\w$]*)\.hp\b/g)) reads.add(m[1]);
  const writes = new Set();
  for (const m of masked.matchAll(/([A-Za-z_$][\w$]*)\.hp\s*=/g)) writes.add(m[1]);
  for (const name of reads) {
    if (writes.has(name)) continue;
    errs.push(`${name}.hp — у спрайтов нет свойства hp (здоровье храни в this.playerHP/this.enemyHP); ${name}.hp === undefined → NaN в fillRect → ФАТАЛЬНЫЙ краш Canvas (TypeError: non-finite). Ширина полосы при создании — константа 100%.`);
  }
  return errs;
}

// Seed/rng переопределяется: this.rng должен инициализироваться ОДИН раз в constructor().
// Повторная инициализация в create() ломает seed-based replayability (каждый запуск — новый уровень).
function detectSeedOverride(body) {
  if (!body) return [];
  const masked = maskNonCode(body);
  const rngCount = (masked.match(/this\.rng\s*=\s*new\s+Phaser\.Math\.RandomDataGenerator/g) || []).length;
  if (rngCount > 1) {
    return [`this.rng = new Phaser.Math.RandomDataGenerator создаётся ${rngCount} раза — this.rng/this.seed инициализируй ОДИН раз в constructor(), НЕ перезаписывай в create() (seed-based replayability ломается, прогресс игнорируется).`];
  }
  return [];
}

// GameOverScene читает registry.get('score'), но никто не пишет registry.set('score') → счёт всегда 0.
function detectRegistryScore(body) {
  if (!body) return [];
  if (/registry\.get\('score'\)/.test(body) && !/registry\.set\('score'/.test(body)) {
    return ['GameOverScene читает registry.get(\'score\'), но нигде нет registry.set(\'score\', n) — счёт всегда 0. Пиши this.registry.set(\'score\', n) на каждое изменение счёта и обязательно перед scene.start(\'GameOverScene\').'];
  }
  return [];
}

function detectUndefinedMethods(body) {
  if (!body) return [];
  const methods = new Set(['constructor']);
  for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) methods.add(m[1]);
  // Сущности, присвоенные из фабрик Phaser (спрайты/группы/тексты) — их методы валидны
  const entities = new Set();
  for (const m of body.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=\s*this\.(?:add|physics|make|scene|time|data|cache)\./g)) entities.add(m[1]);
  const groups = new Set([
    'add', 'physics', 'time', 'scene', 'registry', 'input', 'cameras', 'tweens',
    'sfx', 'rng', 'music', 'load', 'make', 'sys', 'events', 'anims', 'scale',
    'children', 'sound', 'cache', 'textures', 'data', 'game', 'renderer', 'canvas',
  ]);
  const unknown = new Set();
  for (const m of body.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (!methods.has(name) && !entities.has(name) && !groups.has(name)) unknown.add(name);
  }
  return [...unknown];
}

function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

// Внутри какого метода класса находится позиция idx (по балансу скобок)
// maskNonCode маскирует строки/комментарии пробелами С СОХРАНЕНИЕМ ДЛИНЫ — иначе
// `{`/`}` внутри строк ломают подсчёт глубины (depth застревает >0).
function maskNonCode(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/`(?:[^`\\]|\\.)*`/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (s) => s.replace(/[^\n]/g, ' '));
}

function methodOf(body, idx) {
  const masked = maskNonCode(body);
  let depth = 0;
  let current = null;
  let defDepth = -1;
  let pos = 0;
  for (const line of masked.split('\n')) {
    if (pos >= idx) break;
    const def = line.match(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/);
    // Методы класса объявляются на глубине 1 (после `class X {`), top-level функции — на 0
    if (def && (depth === 0 || depth === 1)) { current = def[1]; defDepth = depth; }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    // Метод закрыт: глубина вернулась к уровню его объявления
    if (current && depth <= defDepth) { current = null; defDepth = -1; }
    pos += line.length + 1;
  }
  return current;
}

// Позиционный детектор: startFollow(объект) ДО его создания (this.player = ...).
// Модель иногда добавляет правильный вызов ПОСЛЕ присваивания, но не удаляет старый
// сломанный ДО него — первый вызов роняет create() с TypeError: Cannot read
// properties of undefined (reading 'x'). Проверка по позиции в тексте, не по смыслу.
// Легитимный случай: объект создаётся в helper-методе (createPlayer(){ this.player = ... }),
// который вызывается раньше startFollow — текстовый порядок ≠ порядок исполнения.
function detectEarlyCameraFollow(body) {
  if (!body) return [];
  const errs = [];
  const seen = new Set();
  for (const m of body.matchAll(/startFollow\(\s*(?:this\.)?([A-Za-z_$][\w$]*)/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const assign = body.match(new RegExp(`(?:this\\.)?\\b${name}\\s*=\\s*`));
    if (!assign) {
      errs.push(`startFollow(${name}) — объект ${name} нигде не присваивается (создай его ДО вызова)`);
    } else if (m.index < assign.index) {
      // Присваивание текстом позже. Легитимно, если объект создаётся в helper-методе,
      // который вызывается раньше (this.createPlayer(); → createPlayer(){ this.player = ... }).
      const helper = methodOf(body, assign.index);
      const beforeFollow = body.slice(0, m.index);
      if (helper && helper !== 'create' && new RegExp(`this\\.${helper}\\s*\\(`).test(beforeFollow)) continue;
      errs.push(`startFollow(${name}) вызывается РАНЬШЕ создания ${name} (строка ~${lineOf(body, m.index)}) — перенеси вызов ПОСЛЕ присваивания и удали дубль, иначе TypeError: Cannot read properties of undefined`);
    }
  }
  return errs;
}

function grabMethodBody(body, name) {
  const masked = maskNonCode(body);
  const re = new RegExp(`(?:^|\\n)\\s*${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = masked.match(re);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (let j = i; j < masked.length; j++) {
    const ch = masked[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return body.slice(i, j + 1); }
  }
  return null;
}

// Детектор коллайдеров в update(): physics.add.overlap/collider регистрируют ПОСТОЯННЫЙ
// слушатель, а не разовую проверку. Вызов из update() или из helper-методов, вызываемых
// из update() (checkCollisions и т.п.), плодит 60 дублей в секунду: колбэк срабатывает
// столько раз, сколько накопилось дублей, экран трясётся, физика со временем зависает.
// Коллайдеры — ТОЛЬКО в create(), один раз.
function detectCollidersInUpdate(body) {
  if (!body) return [];
  const errs = [];
  const upd = grabMethodBody(body, 'update');
  if (!upd) return errs;
  for (const m of upd.matchAll(/physics\.add\.(overlap|collider)\(/g)) {
    errs.push(`update() напрямую регистрирует physics.add.${m[1]}() — коллайдеры привязываются ОДИН раз в create(), вызов в update() плодит 60 дублей/сек`);
  }
  const called = new Set();
  for (const m of upd.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
  for (const name of called) {
    const mb = grabMethodBody(body, name);
    if (!mb) continue;
    for (const m of mb.matchAll(/physics\.add\.(overlap|collider)\(/g)) {
      errs.push(`${name}() вызывается из update() каждый кадр, но содержит physics.add.${m[1]}() — регистрируй коллайдеры ОДИН раз в create(), не в методах из update()`);
      break;
    }
  }
  return errs;
}

// ============================================================
// Headless-смоук (puppeteer-core): ловим runtime-баги, которые vm.Script не видит
// Открывает HTML, 5 сек автоигры (рандомные тапы), снимает console.error,
// проверяет, что canvas реально отрисовался (не пустой/однотонный).
// Chromium берётся из @sparticuz/chromium (бинарник + либы внутри npm-пакета) —
// работает в нативном Node-образе Render без системных apt-зависимостей.
// ============================================================
let _puppeteerPromise = null;
function getPuppeteer() {
  if (!_puppeteerPromise) {
    _puppeteerPromise = (async () => {
      try {
        const puppeteer = (await import('puppeteer-core')).default;
        const chromium = (await import('@sparticuz/chromium')).default || (await import('@sparticuz/chromium'));
        const executablePath = await chromium.executablePath();
        return { puppeteer, executablePath, args: chromium.args };
      } catch (e) {
        console.log(`smoke: puppeteer/chromium unavailable: ${e && e.message}`);
        return null;
      }
    })();
  }
  return _puppeteerPromise;
}

async function headlessSmoke(html) {
  if (process.env.SMOKE_SKIP === '1') { console.log('smoke: SKIPPED (SMOKE_SKIP=1, локальный тест)'); return 'SKIPPED'; }
  const pp = await getPuppeteer();
  if (!pp) return 'SKIPPED'; // Chromium недоступен — смоук пропускаем (видно в ответе генерации)
  const { puppeteer, executablePath, args } = pp;
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      // Контейнер Render (512MB): single-process/no-zygote — без них Chromium мгновенно
      // умирает с "Target closed". --disable-gpu (без unsafe-swiftshader) — WebGL недоступен,
      // Phaser сам падает на Canvas-рендерер, а проверка пикселей идёт через 2D — иначе
      // программный GL съедает память и процесс убивается (ECONNRESET). Кап V8-кучи 256MB:
      // тяжёлая игра упрётся в кап внутри Chromium (смоук зафиксирует ошибку), а не убьёт сервер.
      args: [...(args || []), '--no-sandbox', '--disable-setuid-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--headless=new', '--disable-gpu', '--js-flags=--max-old-space-size=256'],
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => {
      if (m.type() === 'error') {
        const t = String(m.text() || '');
        if (!/Failed to load resource|net::ERR_/.test(t)) consoleErrors.push(t.slice(0, 200));
      }
    });
    page.on('pageerror', e => consoleErrors.push(String((e && e.message) || e).slice(0, 200)));
    // preserveDrawingBuffer — чтобы readPixels работал вне кадра
    await page.evaluateOnNewDocument(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (/webgl/i.test(type || '')) attrs = Object.assign({ preserveDrawingBuffer: true }, attrs || {});
        return orig.call(this, type, attrs);
      };
    });
    await page.setContent(html, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 1500)); // ждём boot Phaser
    for (let i = 0; i < 8; i++) { // автоигра: рандомные тапы/клики
      await page.mouse.click(100 + Math.floor(Math.random() * 760), 100 + Math.floor(Math.random() * 340)).catch(() => {});
      await new Promise(r => setTimeout(r, 400));
    }
    // Клавиатура: без неё игры со стрелками стоят на месте, игрок не долетает до
    // астероидов/звёзд, и весь код коллизий (hitAsteroid/collectStar, где живут краши
    // вроде this.Juice.shake) за время смоука не выполняется. Зажимаем случайное
    // направление на 1.5с — игрок реально движется и сталкивается.
    const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'][Math.floor(Math.random() * 4)];
    try {
      await page.keyboard.down(arrow);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {}
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      await page.keyboard.up(k).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 1500));
    const canvas = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return { ok: false, reason: 'canvas не найден через ~5с' };
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        const w = Math.min(c.width, 128), h = Math.min(c.height, 128);
        const px = new Uint8Array(w * h * 4);
        try { gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); }
        catch (e) { return { ok: false, reason: 'readPixels: ' + e.message }; }
        let nonBlack = 0, varied = 0, ref = -1;
        for (let i = 0; i < px.length; i += 16) {
          const v = px[i] + px[i + 1] + px[i + 2];
          if (v > 20) nonBlack++;
          if (ref < 0) ref = v;
          else if (Math.abs(v - ref) > 40) varied++;
        }
        const ok = nonBlack > 4 && varied > 2;
        return { ok, reason: `${nonBlack} непустых пикселей / ${varied} вариаций — ${ok ? 'ок' : 'экран пустой или однотонный'}` };
      }
      // WebGL нет (Phaser упал на Canvas-рендерер) — проверяем пиксели через 2D
      const ctx = c.getContext('2d');
      if (!ctx) return { ok: false, reason: 'нет ни WebGL, ни 2D-контекста' };
      const w = Math.min(c.width, 128), h = Math.min(c.height, 128);
      const data = ctx.getImageData(0, 0, w, h).data;
      let nonBlack = 0, varied = 0, ref = -1;
      for (let i = 0; i < data.length; i += 16) {
        const v = data[i] + data[i + 1] + data[i + 2];
        if (v > 20) nonBlack++;
        if (ref < 0) ref = v;
        else if (Math.abs(v - ref) > 40) varied++;
      }
      const ok = nonBlack > 4 && varied > 2;
      return { ok, reason: `2D: ${nonBlack} непустых пикселей / ${varied} вариаций — ${ok ? 'ок' : 'экран пустой или однотонный'}` };
    });
    const errs = [];
    if (consoleErrors.length) errs.push('SMOKE runtime: ' + consoleErrors.slice(0, 3).join(' | '));
    if (!canvas.ok) errs.push('SMOKE canvas: ' + canvas.reason);
    if (!errs.length) console.log('smoke: ok — ' + canvas.reason);
    return errs.length ? errs : null;
  } catch (e) {
    console.log('smoke: error — ' + (e && e.message));
    return ['SMOKE error: ' + (e && e.message)]; // честный fail, а не молчаливый pass
  } finally {
    if (browser) browser.close().catch(() => {});
  }
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

async function generatePlayScene(description, spec, textures, lastError, baseRef) {
  let user = specBrief(spec, description);
  if (textures?.length) {
    user += `\n\nРеференсные текстуры (можешь использовать как идеи для палитры):\n${textures.map(t => `- ${t.name}: ${t.url}`).join('\n')}`;
  }
  if (baseRef) {
    user += `\n\nСУЩЕСТВУЮЩАЯ ИГРА (ты её улучшаешь): сохрани жанр, тему и ключевые фишки из неё, НО построй игру ЗАНОВО в полном скелетоне (Boot/Menu/Play/GameOver), не копируй её структуру. Код как референс:\n${baseRef}`;
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
    const errs = qaHtml(fixed).concat(detectFixedApiCalls(fixed), detectColorStrings(fixed), detectEarlyCameraFollow(fixed), detectCollidersInUpdate(fixed), detectWindowClassAccess(fixed), detectDoublePhysicsAdd(fixed), detectUndefinedHp(fixed), detectSeedOverride(fixed), detectRegistryScore(fixed));
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
    const errs = qaHtml(polished).concat(detectFixedApiCalls(polished), detectColorStrings(polished), detectEarlyCameraFollow(polished), detectCollidersInUpdate(polished), detectWindowClassAccess(polished), detectDoublePhysicsAdd(polished), detectUndefinedHp(polished), detectSeedOverride(polished), detectRegistryScore(polished));
    if (errs.length) return null; // полировка что-то сломала — откатываем
    return polished;
  } catch {
    return null;
  }
}

// ============================================================
// Конвейер генерации
// ============================================================
async function generateNew(description, textures, baseCode, meta) {
  let spec = null;
  try {
    spec = await generateSpec(description + (baseCode
      ? '\n(Это УЛУЧШЕНИЕ существующей игры — сохрани жанр и ключевые фишки, но перестрой игру заново, лучше и полнее.)'
      : ''));
  } catch { spec = null; } // SPEC не удался — генерим по сырому описанию

  const baseRef = baseCode && baseCode.length > 5000 ? baseCode.slice(0, 14000) : (baseCode || undefined);
  let lastError = '';
  let best = null;
  let bestOverall = null; // лучший по скорингу за ВСЕ попытки — фейл-бэк
  let smokeStatus = null; // 'ok' | 'fail' | 'skipped' — результат headless-смоука

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Best-of-3: три параллельных тела PlayScene, ранжируем по скорингу покрытия
    const bodies = await Promise.all(
      [0, 1, 2].map(() => generatePlayScene(description, spec, textures, lastError, baseRef).catch(() => null))
    );

    const candidates = bodies.map((rawBody) => {
      if (!rawBody) return null;
      const body = cleanPlaySceneBody(rawBody);
      if (!body) return null;
      const html = buildGameHtml(body, spec, description, meta);
      const errs = qaHtml(html);
      const unknownMethods = detectUndefinedMethods(body)
        .map(n => `Метод this.${n}() вызывается, но не определён в классе PlayScene — добавь его реализацию (или удали вызов)`);
      const fixedApiErrs = detectFixedApiCalls(body);
      const colorErrs = detectColorStrings(body);
      const earlyFollowErrs = detectEarlyCameraFollow(body);
      const colliderErrs = detectCollidersInUpdate(body);
      const windowClassErrs = detectWindowClassAccess(body);
      const doublePhysErrs = detectDoublePhysicsAdd(body);
      const specMisses = checkSpecCoverage(html, spec);
      const allErrs = [...errs, ...unknownMethods, ...fixedApiErrs, ...colorErrs, ...earlyFollowErrs, ...colliderErrs, ...windowClassErrs, ...doublePhysErrs];
      return { html, body, errs: allErrs, specMisses, score: candidateScore({ html, errs: allErrs, specMisses }) };
    }).filter(Boolean);

    if (!candidates.length) {
      lastError = 'Модель вернула не тело PlayScene (полный HTML/мусор). Верни ТОЛЬКО методы preload/create/update.';
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);
    let top = candidates[0];
    if (!bestOverall || top.score > bestOverall.score) bestOverall = top;

    if (top.errs.length || top.specMisses.length) {
      // Мультипасс: самокритика точечно чинит слабые места вместо полной регенерации
      const critiqued = await selfCritique(top.body, spec, description, [...top.errs, ...top.specMisses]);
      if (critiqued !== top.body) {
        const html2 = buildGameHtml(critiqued, spec, description, meta);
        const errs2 = qaHtml(html2);
        const specMisses2 = checkSpecCoverage(html2, spec);
        const c2 = { html: html2, body: critiqued, errs: errs2, specMisses: specMisses2, score: candidateScore({ html: html2, errs: errs2, specMisses: specMisses2 }) };
        if (c2.score > top.score) top = c2;
      }
    }

    if (top.errs.length === 0 && top.specMisses.length === 0) {
      // Статика чистая — гоняем headless-смоук перед приёмкой
      const smokeErrs = await headlessSmoke(top.html);
      smokeStatus = smokeErrs === 'SKIPPED' ? 'skipped' : (smokeErrs ? 'fail' : 'ok');
      if (smokeErrs && smokeErrs !== 'SKIPPED' && smokeErrs.length) {
        lastError = 'ПРЕДЫДУЩАЯ ПОПЫТКА (headless-смоук поймал runtime-баг):\n- ' + smokeErrs.join('\n- ');
        continue;
      }
      best = top.html;
      break;
    }

    lastError = 'ПРЕДЫДУЩАЯ ПОПЫТКА НЕ ПРОШЛА QA:\n- ' + [...top.errs, ...top.specMisses].join('\n- ');
  }

  if (!best) {
    // Полный провал — отдаём ЛУЧШИЙ по скорингу из всех попыток, но НЕ если он
    // синтаксически битый: такая игра не запустится вообще, честный 500 лучше фейка
    if (bestOverall) {
      const syntaxErr = checkSyntax(bestOverall.html);
      if (syntaxErr) {
        return {
          html: null,
          seo: null,
          attempts: MAX_ATTEMPTS,
          error: (lastError || '') + '\n\nЛучшая попытка синтаксически битая: ' + syntaxErr,
        };
      }
      return {
        html: bestOverall.html,
        seo: parseSeo(bestOverall.html, description),
        attempts: MAX_ATTEMPTS,
        error: lastError || 'Ни одна попытка не прошла QA полностью',
      };
    }
    return {
      html: null,
      seo: null,
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

  // НОВОЕ: review/polish переписывают код ПОСЛЕ смоука на строке 900 без повторной
  // браузерной проверки — финальный код мог сломаться (порядок инициализации, типы).
  // Перепроверяем смоуком; при провале откатываемся на best (он уже прошёл смоук).
  const finalSmoke = await headlessSmoke(final);
  if (finalSmoke && finalSmoke !== 'SKIPPED' && finalSmoke.length) {
    return {
      html: best,
      seo: parseSeo(best, description),
      attempts: MAX_ATTEMPTS,
      reviewed: false,
      smokeFallback: true,
      error: 'review/polish сломали рабочую игру, откат на версию до review:\n- ' + finalSmoke.join('\n- '),
    };
  }

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
    const errs = qaHtml(html).concat(legacyStructuralErrors(html));
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

async function generate(description, textures, baseCode, meta) {
  // Улучшения существующих игр тоже идём через скелетон: baseCode — только референс стиля/фишек
  return generateNew(description, textures, baseCode, meta);
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

    // Итеративное сотворчество: точечное улучшение по кнопке (патч-промпт поверх baseCode)
    if (job.action) {
      const ACTIONS = {
        graphics: '🎨 Сделай графику заметно красивее и премиальнее: выразительные существа через makeCreature (мягкие блобы, не квадраты), больше Juice-эффектов (Juice.shake/Juice.burst/Juice.popText/Juice.comboFlash), фоновый декор/параллакс, свечение (postFX.addGlow), тщательнее палитра и композиция.',
        difficulty: '⚔️ Сделай игру СЛОЖНЕЕ: более крутая difficulty_curve, больше врагов/препятствий, выше требования к победе, меньше таймера. Сохрани честный баланс — не делай невыполнимой.',
        levels: '🗺️ Добавь минимум 5 уровней с прогрессией: перестройка уровня на каждом, прогресс-бар, надпись «УРОВЕНЬ N», рост сложности и новые вызовы между уровнями.',
      };
      const actionText = ACTIONS[job.action];
      if (actionText) {
        const result = await generate(`${actionText}\n(Игра: ${job.description})`, [], job.baseCode, { gameId: job.gameId, slug: job.slug });
        if (result.html) {
          const seo = result.seo;
          await updateGame(job.gameId, {
            status: 'ready',
            source_code: result.html,
            title: seo.title,
            description: seo.description,
            deploy_url: `${PORTAL_URL}/${job.slug}`,
          });
          if (job.slug && job.chatId && seo.title) {
            fetch(`${PORTAL_URL}/callback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug: job.slug, chatId: job.chatId, title: seo.title, gameId: job.gameId }),
            }).catch(() => {});
          }
          console.log(`✅ ${job.gameId} improved (${job.action}) in ${Date.now() - startTime}ms`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, seo, smoke: result.smoke }));
          return;
        }
      }
    }

    // Generate via DeepSeek
    const result = await generate(job.description, job.textures || [], job.baseCode, { gameId: job.gameId, slug: job.slug });

    if (!result.html) {
      // Телеметрия: фиксируем фейл в БД, чтобы статистика ошибок была реальной (а не только в логах)
      try {
        await updateGame(job.gameId, { status: 'failed', error_message: String(result.error || 'Generation failed').slice(0, 500) });
      } catch (_) { /* не критично для ответа */ }
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
        body: JSON.stringify({ slug: job.slug, chatId: job.chatId, title: seo.title, gameId: job.gameId }),
      }).catch(() => {});
    }

    console.log(`✅ ${job.gameId} done in ${Date.now() - startTime}ms`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seo, smoke: result.smoke, attempts: result.attempts, error: result.error || null }));
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
