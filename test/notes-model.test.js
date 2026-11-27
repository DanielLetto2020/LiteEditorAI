// Тесты чистой модели задачника и календаря (renderer/modules/notes-model.js).
// Запуск: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/notes-model.test.js
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }
function deq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

(async () => {
  const mod = await import(
    pathToFileURL(path.join(__dirname, '..', 'renderer', 'modules', 'notes-model.js')).href
  );
  const {
    normalizeNote, parseQuickInput, dueState, formatDueShort,
    computeNextRepeat, computeSnooze, notesToMarkdown, formatNoteForTerminal,
    tagColorIndex, cleanTag, dayKey,
  } = mod;

  // 1. normalizeNote: миграция старых записей и инвариант архива
  const old = normalizeNote({ text: 'Проверить тесты' });
  ok(Boolean(old.id), 'миграция проставляет id');
  eq(old.status, 'todo', 'статус по умолчанию todo');
  eq(old.prio, 0, 'приоритет по умолчанию 0');
  deq(old.tags, [], 'tags по умолчанию []');
  deq(old.subtasks, [], 'subtasks по умолчанию []');
  eq(old.pomoCount, 0, 'pomoCount по умолчанию 0');

  const arch = normalizeNote({
    id: 'n1',
    text: 'Архивная задача',
    status: 'doing',
    archived: true,
    tags: ['#Bug', 'UI ', 'bug', '!!!'],
    pomoCount: 3.8,
  });
  eq(arch.status, 'done', 'архивная задача принудительно получает status=done для корректного счётчика ядра');
  eq(arch.prevStatus, 'doing', 'сохранён предыдущий статус для восстановления из архива');
  deq(arch.tags, ['bug', 'ui'], 'теги нормализованы и дедуплицированы');
  eq(arch.pomoCount, 3, 'pomoCount округлён вниз');

  // review остаётся review
  const rev = normalizeNote({ id: 'n2', text: 'PR', status: 'review', prio: 2 });
  eq(rev.status, 'review', 'статус review поддерживается');
  eq(rev.prio, 2, 'prio 2 сохранён');

  // 2. parseQuickInput
  const now = new Date(2026, 10, 20, 14, 0, 0, 0); // 2026-11-20 14:00 (Пт)
  const p1 = parseQuickInput('Починить авторизацию !2 #auth #Баг @завтра 15:30 *', now);
  eq(p1.text, 'Починить авторизацию', 'токены удалены из заголовка');
  eq(p1.prio, 2, '!2 → prio=2');
  eq(p1.today, true, '* → today=true');
  deq(p1.tags, ['auth', 'баг'], 'распознаны латинские и кириллические теги');
  eq(p1.allDay, false, 'указано время → allDay=false');
  ok(Boolean(p1.dueAt), 'dueAt вычислен');
  const d1 = new Date(p1.dueAt);
  eq(dayKey(d1), '2026-11-21', '@завтра → 2026-11-21');
  eq(d1.getHours(), 15, 'час 15');
  eq(d1.getMinutes(), 30, 'минута 30');

  const p2 = parseQuickInput('Релиз !срочно @+3д #deploy', now);
  eq(p2.text, 'Релиз', 'заголовок очищен');
  eq(p2.prio, 2, '!срочно → prio=2');
  eq(p2.allDay, true, '@+3д без времени → allDay=true');
  eq(dayKey(new Date(p2.dueAt)), '2026-11-23', '@+3д → 2026-11-23');

  const p3 = parseQuickInput('Проверить логи @+2ч !', now);
  eq(p3.prio, 1, '! → prio=1');
  eq(p3.allDay, false, '@+2ч → allDay=false');
  eq(new Date(p3.dueAt).getHours(), 16, '14:00 + 2ч = 16:00');

  const p4 = parseQuickInput('Встреча @2026-12-31 10:15', now);
  eq(dayKey(new Date(p4.dueAt)), '2026-12-31', 'ISO-дата');
  eq(new Date(p4.dueAt).getHours(), 10, 'час 10');

  // @15.08 в ноябре переносится на следующий год
  const p5 = parseQuickInput('Отпуск @15.08', now);
  eq(dayKey(new Date(p5.dueAt)), '2027-08-15', 'прошедшая дата без года переносится на следующий год');

  // Строка из одних токенов не обнуляет text
  const pOnly = parseQuickInput('!2 #ops', now);
  eq(pOnly.text, '!2 #ops', 'при пустом остатке сохраняется исходный текст');

  // 3. dueState и formatDueShort
  const yest = new Date(2026, 10, 19, 0, 0, 0, 0).toISOString();
  const tod = new Date(2026, 10, 20, 0, 0, 0, 0).toISOString();
  const tom = new Date(2026, 10, 21, 9, 30, 0, 0).toISOString();
  eq(dueState(yest, true, false, now), 'overdue', 'вчера allDay = overdue');
  eq(dueState(yest, true, true, now), 'later', 'выполненная не overdue');
  eq(dueState(tod, true, false, now), 'today', 'сегодня allDay = today');
  eq(dueState(tom, false, false, now), 'tomorrow', 'завтра = tomorrow');
  eq(formatDueShort(tod, true, now), 'Сегодня', 'подпись сегодня');
  eq(formatDueShort(tom, false, now), 'Завтра, 09:30', 'подпись завтра со временем');

  // 4. computeNextRepeat
  const fri = new Date(2026, 10, 20, 9, 0, 0, 0).toISOString(); // Пт 20 ноя
  const nextWd = computeNextRepeat(fri, 'weekdays', false, now);
  eq(dayKey(new Date(nextWd)), '2026-11-23', 'weekdays: пятница перепрыгивает Сб/Вс на понедельник');

  const jan31 = new Date(2026, 0, 31, 9, 0, 0, 0).toISOString();
  const feb = computeNextRepeat(jan31, 'monthly', false, new Date(2026, 0, 31, 10, 0, 0, 0));
  eq(dayKey(new Date(feb)), '2026-02-28', 'monthly: 31 января не перескакивает в март (28 фев)');

  const nextWk = computeNextRepeat(fri, 'weekly', false, now);
  eq(dayKey(new Date(nextWk)), '2026-11-27', 'weekly: +7 дней');

  // 5. computeSnooze
  const sn15 = computeSnooze('15m', now);
  eq(new Date(sn15.at).getMinutes(), 15, 'snooze +15m');
  const snTom = computeSnooze('tomorrow', now);
  eq(dayKey(new Date(snTom.at)), '2026-11-21', 'snooze tomorrow → завтра 09:00');
  eq(new Date(snTom.at).getHours(), 9, 'snooze tomorrow → 09:00');

  // 6. notesToMarkdown и formatNoteForTerminal
  const md = notesToMarkdown('Мой проект', [
    { id: '1', text: 'Сделать X\nДетали X', status: 'todo', prio: 2, tags: ['core'], subtasks: [{ id: 's1', text: 'Шаг 1', done: true }, { id: 's2', text: 'Шаг 2', done: false }] },
    { id: '2', text: 'Скрытая', status: 'done', archived: true },
  ]);
  ok(md.includes('# Мой проект'), 'Markdown содержит заголовок');
  ok(md.includes('**Сделать X**'), 'Markdown содержит задачу');
  ok(md.includes('- [x] Шаг 1') && md.includes('- [ ] Шаг 2'), 'Markdown содержит подзадачи');
  ok(!md.includes('Скрытая'), 'архивные не попадают в активный Markdown-экспорт');

  const termTxt = formatNoteForTerminal({
    text: 'Починить баг',
    subtasks: [{ id: '1', text: 'Сделано', done: true }, { id: '2', text: 'Осталось', done: false }],
  });
  ok(termTxt.includes('- [ ] Осталось') && !termTxt.includes('Сделано'), 'в терминал уходят только невыполненные подзадачи');

  // 7. tagColorIndex & cleanTag
  eq(cleanTag('  #Front-End! '), 'front-end', 'cleanTag очищает символы');
  for (const tg of ['bug', 'feat', 'ui', 'api', 'тест', 'infra']) {
    const idx = tagColorIndex(tg);
    ok(idx >= 1 && idx <= 8, `tagColorIndex(${tg}) в 1..8`);
  }

  console.log(`✓ notes-model.test: ${passed} проверок пройдено`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
