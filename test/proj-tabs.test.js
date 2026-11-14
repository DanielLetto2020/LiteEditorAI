// Тесты планировщика ленивых вкладок проекта (renderer/proj-tabs.js).
// Проверяет материализацию только видимых вкладок (активной и пары сплита),
// откладывание фоновых вкладок и точечный armPrefill только в активной вкладке.
// Запуск: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/proj-tabs.test.js

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const { planProjectTabs } = await import(
    pathToFileURL(path.join(__dirname, '..', 'renderer', 'proj-tabs.js')).href
  );

  // --- 1. Новый проект без сохранённых вкладок ---
  {
    const p = planProjectTabs(null, 'Term 1');
    ok(p.activeIndex === 0, 'по умолчанию активен индекс 0');
    ok(p.splitIndices === null, 'по умолчанию сплита нет');
    ok(p.tabs.length === 1, 'одна вкладка по умолчанию');
    ok(p.tabs[0].name === 'Term 1' && p.tabs[0].eager === true && p.tabs[0].prefill === true, 'единственная вкладка eager + prefill');
  }

  // --- 2. Несколько вкладок без сплита: материализуется ТОЛЬКО активная ---
  {
    const p = planProjectTabs({
      names: ['API', 'Worker', 'Tests', 'Logs'],
      custom: [true, true, false, true],
      active: 2,
    });
    ok(p.activeIndex === 2, 'выбрана сохранённая активная вкладка 2');
    ok(p.splitIndices === null, 'сплита нет');
    ok(p.tabs.filter((t) => t.eager).length === 1, 'материализуется ровно 1 вкладка из 4');
    ok(p.tabs[2].eager === true && p.tabs[2].prefill === true, 'активная вкладка eager и получает prefill');
    ok(p.tabs[0].eager === false && p.tabs[0].prefill === false, 'фоновая вкладка 0 ленивая и без prefill');
    ok(p.tabs[1].eager === false && p.tabs[3].eager === false, 'фоновые вкладки 1 и 3 ленивые');
    ok(p.tabs[0].customName === true && p.tabs[2].customName === false, 'флаги customName сохранены');
  }

  // --- 3. Сплит-режим: материализуются оба слота сплита, но prefill — только в активный ---
  {
    const p = planProjectTabs({
      names: ['Left', 'Right', 'Bg1', 'Bg2'],
      custom: [true, true, false, false],
      active: 1,
      split: [0, 1],
    });
    assert.deepStrictEqual(p.splitIndices, [0, 1]);
    ok(p.tabs[0].eager === true && p.tabs[0].prefill === false, 'левый неактивный слот сплита eager, но без prefill');
    ok(p.tabs[1].eager === true && p.tabs[1].prefill === true, 'правый активный слот сплита eager и с prefill');
    ok(p.tabs[2].eager === false && p.tabs[3].eager === false, 'остальные вкладки за пределами сплита ленивые');
  }

  // --- 4. Защита от битых индексов active и split в сторе ---
  {
    const p = planProjectTabs({
      names: ['One', ''],
      active: 99,
      split: [1, 1], // одинаковые индексы невалидны
    }, 'Fallback');
    ok(p.activeIndex === 1, 'выход active за верхнюю границу зажат к последней вкладке');
    ok(p.splitIndices === null, 'вырожденный split [1,1] отброшен');
    ok(p.tabs[1].name === 'Fallback', 'пустое имя заменено на fallback');
    ok(p.tabs[0].eager === false && p.tabs[1].eager === true, 'только зажатая активная вкладка eager');
  }

  {
    const p = planProjectTabs({
      names: ['One', 'Two'],
      active: -5,
      split: [0, 5], // выход за границу
    });
    ok(p.activeIndex === 0, 'отрицательный active зажат к 0');
    ok(p.splitIndices === null, 'split с выходом за границу отброшен');
  }

  console.log(`✓ proj-tabs: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
