/* Fake window.lite for screenshot mockups — feeds the real renderer invented data.
   Scene chosen via ?scene=main|viewer|preview|notes. Not shipped. */
(function () {
  const P = (v) => Promise.resolve(v);
  const HOME = '/home/maxim';
  const ROOT = HOME + '/work/figma-tilda';

  const projects = [
    { id: 'p1', name: 'figma-tilda', path: ROOT, category: 'Работа', accent: '#7aa2f7' },
    { id: 'p2', name: 'test-lendi', path: HOME + '/work/test-lendi', category: 'Работа' },
    { id: 'p3', name: 'portfolio', path: HOME + '/sites/portfolio', favorite: true, accent: '#2fbf71' },
    { id: 'p4', name: 'api-server', path: HOME + '/work/api-server', category: 'Работа', accent: '#e0af68' },
    { id: 'p5', name: 'notes-vault', path: HOME + '/personal/notes-vault', category: 'Личное' },
  ];
  const scene = new URLSearchParams(location.search).get('scene') || 'main';
  const openFile = scene === 'preview' ? ROOT + '/README.md' : ROOT + '/app.js';

  const STORE = {
    projects,
    categories: ['Работа', 'Личное'],
    accordions: {},
    recents: [],
    lastParent: '',
    projFiles: { p1: openFile },
    dismissed: [],
    settings: { onboarded: true, theme: 'emerald', notifications: true, sound: false, idleMs: 1200, fontSize: 13, workingDir: '', scanDirs: [] },
  };

  const entry = (parent, name, dir) => ({ name, path: parent + '/' + name, dir: !!dir });
  const tree = {
    [ROOT]: [entry(ROOT, 'src', true), entry(ROOT, 'assets', true), entry(ROOT, 'app.js'), entry(ROOT, 'index.html'), entry(ROOT, 'styles.css'), entry(ROOT, 'package.json'), entry(ROOT, 'README.md')],
    [ROOT + '/src']: [entry(ROOT + '/src', 'parser.js'), entry(ROOT + '/src', 'tokenizer.js'), entry(ROOT + '/src', 'render.js'), entry(ROOT + '/src', 'new.js')],
    [ROOT + '/assets']: [entry(ROOT + '/assets', 'logo.svg'), entry(ROOT + '/assets', 'cover.png')],
  };

  const files = {
    [ROOT + '/app.js']:
`import { parseFigma } from './src/parser.js';
import { render } from './src/render.js';

// точка входа: тянем дизайн из Figma и рендерим в HTML
export async function build(fileId, token) {
  const doc = await parseFigma(fileId, token);
  const html = render(doc, { responsive: true });
  return html;
}

build(process.argv[2], process.env.FIGMA_TOKEN)
  .then((html) => console.log(html))
  .catch((e) => console.error('build failed:', e));
`,
    [ROOT + '/README.md']:
`# figma-tilda

Конвертер макетов **Figma → HTML** для Тильды.

## Возможности
- Парсинг дерева узлов Figma по API
- Адаптивная сетка и автолейаут
- Экспорт в чистый HTML + CSS

## Запуск
\`\`\`bash
npm install
FIGMA_TOKEN=xxx node app.js <fileId>
\`\`\`

> Совет: токен берётся в настройках аккаунта Figma.

| Узел | Поддержка |
|------|-----------|
| Frame | ✅ |
| Text  | ✅ |
| Auto-layout | ✅ |
`,
    [ROOT + '/src/parser.js']:
`export async function parseFigma(fileId, token) {
  const res = await fetch('https://api.figma.com/v1/files/' + fileId, {
    headers: { 'X-Figma-Token': token },
  });
  if (!res.ok) throw new Error('Figma API ' + res.status);
  const { document } = await res.json();
  return walk(document);
}
`,
  };

  const gitFiles = {
    [ROOT + '/app.js']: 'M',
    [ROOT + '/src/parser.js']: 'M',
    [ROOT + '/src/new.js']: '?',
  };
  const gitInfo = {
    repo: true, branch: 'main', ahead: 2, behind: 0, upstream: true, hasRemote: true,
    branches: ['main', 'dev', 'feature/autolayout'],
    lastCommit: { hash: 'a1c3f9', subject: 'парсер: поддержка auto-layout', when: '2 часа назад', author: 'Максим' },
  };

  const notes = [
    { id: 'n1', text: 'Добавь экспорт в Tilda Blocks (zero-block) с сохранением позиций.' },
    { id: 'n2', text: 'Прогони на макете #4821 и сравни пиксельно с оригиналом.' },
    { id: 'n3', text: 'Напиши тесты на вложенные auto-layout фреймы.' },
  ];

  const noop = () => {};
  const unsub = () => () => {};
  window.lite = {
    openProject: () => P(null), pickDir: () => P(null),
    openInFileManager: () => P({ ok: true }), openExternal: () => P({ ok: true }),
    copyText: noop, readClipboard: () => P(''),
    pathForFile: () => '',
    win: { minimize: noop, maximizeToggle: noop, fullscreen: noop, close: noop, show: noop, growBy: noop, isMaximized: () => P(false), onMaximizeChange: unsub },
    tray: { update: noop },
    store: { loadAll: () => STORE, set: noop, notesGet: () => P(notes), notesSet: () => P({ ok: true }) },
    pty: {
      create: () => P({ ok: true }), write: noop, resize: noop, kill: noop, restart: () => P({ ok: true }),
      foregroundState: (id) => P(id === 'p1' ? 'waiting' : 'shell'),
      onData: (cb) => { window.__ptyData = cb; return () => {}; },
      onExit: unsub,
    },
    fs: {
      readDir: (d) => P(tree[d] || []),
      readFile: (f) => P(files[f] != null ? { content: files[f] } : { content: '// ' + f }),
      writeFile: () => P({ ok: true }), mkdir: () => P({ ok: true }), exists: () => P(true),
      create: () => P({ ok: true }), rename: () => P({ ok: true }), trash: () => P({ ok: true }),
      readDataUrl: () => P({ url: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="160"><rect width="220" height="160" fill="#16241d"/><text x="110" y="86" fill="#3ddc84" font-family="monospace" font-size="20" text-anchor="middle">logo.svg</text></svg>') }),
      watch: noop, unwatch: noop, onChange: unsub,
    },
    git: {
      status: () => P({ repo: true, files: gitFiles }),
      fileDiff: () => P({ diff: 'diff --git a/app.js b/app.js\n@@ -3,3 +3,4 @@\n-const x = 1;\n+const x = 2;\n+const y = 3;' }),
      info: () => P(gitInfo), init: () => P({ ok: true }),
      commit: () => P({ ok: true }), push: () => P({ ok: true }), pull: () => P({ ok: true }),
      fetch: () => P({ ok: true }), checkout: () => P({ ok: true }), createBranch: () => P({ ok: true }), discardFile: () => P({ ok: true }),
    },
  };

  // terminal content: a finished Claude turn that ends on a y/n prompt → "waiting" (amber)
  const TERM = [
    '\x1b[2mmaxim@pc\x1b[0m:\x1b[34m~/work/figma-tilda\x1b[0m$ claude\r\n\r\n',
    '\x1b[38;5;208m✻\x1b[0m \x1b[1mClaude Code\x1b[0m\r\n\r\n',
    '\x1b[32m❯\x1b[0m обнови парсер фигмы и прогони тесты\r\n\r\n',
    '\x1b[36m●\x1b[0m Читаю \x1b[36msrc/parser.js\x1b[0m, \x1b[36msrc/tokenizer.js\x1b[0m\r\n',
    '\x1b[36m●\x1b[0m Обновляю токенизацию узлов auto-layout\r\n',
    '\x1b[36m●\x1b[0m \x1b[2mnpm test\x1b[0m\r\n',
    '  \x1b[32m✔\x1b[0m parser  \x1b[2m(12)\x1b[0m\r\n',
    '  \x1b[32m✔\x1b[0m render  \x1b[2m(8)\x1b[0m\r\n',
    '\x1b[32m✔\x1b[0m Готово: 20 тестов прошли. Обновил \x1b[36msrc/parser.js\x1b[0m.\r\n\r\n',
    '\x1b[33m? Применить правки к app.js?\x1b[0m \x1b[2m(y/n)\x1b[0m \x1b[5m█\x1b[0m\r\n',
  ].join('');

  function runScene() {
    if (window.__ptyData) window.__ptyData({ id: 'p1', data: TERM });
    const q = (s) => document.querySelector(s);
    if (scene === 'viewer' || scene === 'preview') {
      const btn = q('.card[data-id="p1"] .card-actions button'); // «👁 вивер»
      if (btn) btn.click();
    } else if (scene === 'notes') {
      const btns = document.querySelectorAll('.card[data-id="p1"] .card-actions button');
      if (btns[1]) btns[1].click(); // «📝 заметки»
    }
  }
  window.addEventListener('load', () => setTimeout(runScene, 350));
})();
