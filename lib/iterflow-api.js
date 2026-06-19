// IterFlow API-клиент для модуля «IterFlow» (renderer/modules/iterflow.js).
// Живёт в MAIN-процессе Electron: CSP рендерера запрещает сеть, поэтому весь HTTP
// и хранение device-токена — здесь. Рендерер ходит через мост window.lite.iterflow.*
// (preload) → ipcMain.handle('iterflow:*') (main.js) → этот клиент.
//
// Аутентификация — device-токен изолированной группы /api/editor/* IterFlow
// (Authorization: Bearer, TTL 3 дня скользящий). Токен + минимальные данные о
// пользователе храним в <storeDir>/iterflow/session.json (права 600). Пароль НЕ
// сохраняем. На 401 аутентифицированного запроса сессия считается мёртвой и
// стирается — UI вернётся на экран логина. Контракт API см. IteraFlow §14 +
// backend/internal/api/editor.go.
const fs = require('fs');
const path = require('path');

// Дефолтный хост — боевой прод. Переопределяется env ITERFLOW_HOST (для локалки).
const PROD_BASE = 'https://iter-flow.ru';

function createIterflowApi(opts) {
  opts = opts || {};
  const dir = path.join(opts.storeDir || '.', 'iterflow');
  const sessionFile = path.join(dir, 'session.json');
  const getBaseUrl = opts.getBaseUrl || (() => process.env.ITERFLOW_HOST || PROD_BASE);

  let session = readSession(); // { token, user } | null

  function readSession() {
    try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')); }
    catch (_) { return null; }
  }
  function writeSession(s) {
    session = s || null;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    if (session) {
      fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
      try { fs.chmodSync(sessionFile, 0o600); } catch (_) {} // umask мог ослабить mode
    } else {
      try { fs.rmSync(sessionFile, { force: true }); } catch (_) {}
    }
  }
  function base() { return String(getBaseUrl() || PROD_BASE).replace(/\/+$/, ''); }
  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (session && session.token) h['Authorization'] = 'Bearer ' + session.token;
    return h;
  }
  async function parseBody(res) {
    const txt = await res.text();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (_) { return txt; }
  }
  function httpError(res, data) {
    const e = new Error((data && data.error) || ('HTTP ' + res.status));
    e.status = res.status;
    e.code = data && data.code;
    return e;
  }

  // Аутентифицированный запрос (editor device-token, Bearer). 401 → сессия мёртвая:
  // стираем и бросаем (UI → логин).
  async function authed(method, p, body) {
    const res = await fetch(base() + p, {
      method,
      headers: authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { writeSession(null); throw httpError(res, await parseBody(res)); }
    const data = await parseBody(res);
    if (!res.ok) throw httpError(res, data);
    return data;
  }

  // Веб-cookie запрос — для веб-ручек, которых нет в editor-группе (project_notes,
  // project_messages). Использует cookie веб-сессии IterFlow (заведена при login
  // вторым логином). Cookie живёт только в main, в рендерер не уходит. 401 здесь —
  // протухла ИМЕННО веб-сессия (не device-token), поэтому device-сессию НЕ трогаем:
  // помечаем web401, чтобы UI попросил перелогиниться, а не разлогинивал весь модуль.
  async function authedCookie(method, p, body) {
    if (!session || !session.cookie) { const e = new Error('Нет веб-сессии IterFlow — выйдите и войдите снова'); e.web401 = true; throw e; }
    const res = await fetch(base() + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'Cookie': session.cookie },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { const e = new Error('Веб-сессия IterFlow истекла — выйдите и войдите снова'); e.web401 = true; throw e; }
    const data = await parseBody(res);
    if (!res.ok) throw httpError(res, data);
    return data;
  }

  // Достаёт пары name=value из всех Set-Cookie ответа (без атрибутов) → строка для
  // заголовка Cookie. Имя cookie берётся из конфига сервера, поэтому не угадываем.
  function extractCookies(res) {
    let arr = [];
    try { arr = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch (_) {}
    if (!arr.length) { const sc = res.headers.get('set-cookie'); if (sc) arr = [sc]; }
    return arr.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
  }

  return {
    isAuthed: () => !!(session && session.token),
    getUser: () => (session && session.user) || null,
    baseUrl: () => base(),

    // Вход. Публичная ручка: 401 здесь = неверные креды, существующую сессию НЕ трогаем.
    async login(email, password) {
      // 1) editor device-token (Bearer) — основная аутентификация модуля.
      const res = await fetch(base() + '/api/editor/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await parseBody(res);
      if (!res.ok) throw httpError(res, data);
      // 2) веб-cookie тем же паролем — нужна ТОЛЬКО для веб-ручек project_notes /
      //    project_messages (в editor-группе их нет). Не критично: если упадёт, всё
      //    остальное работает, туду/чат просто покажут «нет веб-сессии».
      let cookie = '';
      try {
        const wr = await fetch(base() + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (wr.ok) cookie = extractCookies(wr);
      } catch (_) {}
      writeSession({ token: data.token, user: data.user, cookie });
      return data; // { token, expiresIn, user, profiles, teams }
    },

    async logout() {
      if (session && session.token) {
        try { await authed('POST', '/api/editor/auth/logout'); } catch (_) {}
      }
      writeSession(null);
    },

    // Кто я + исполнительские контексты (для восстановления сессии на старте).
    async me() { return authed('GET', '/api/editor/me'); }, // { user, profiles, teams }
    async counterparties(ctx) {
      return authed('GET', '/api/editor/counterparties?ctx=' + encodeURIComponent(ctx));
    },
    async counterpartyProjects(cpId) {
      return authed('GET', '/api/editor/counterparties/' + encodeURIComponent(cpId) + '/projects');
    },
    async projectIterations(projectId) {
      return authed('GET', '/api/editor/projects/' + encodeURIComponent(projectId) + '/iterations');
    },
    async iterationTasks(iterationId) {
      return authed('GET', '/api/editor/iterations/' + encodeURIComponent(iterationId) + '/tasks');
    },
    // Туду и чат — через веб-cookie (нет в editor-группе). Только чтение.
    async projectNotes(projectId) {
      return authedCookie('GET', '/api/projects/' + encodeURIComponent(projectId) + '/notes');
    },
    async projectMessages(projectId) {
      return authedCookie('GET', '/api/projects/' + encodeURIComponent(projectId) + '/messages?iterationId=general&limit=50');
    },
    // Смена колонки канбана (этап 2). Только active + только исполнитель — иначе 403.
    async setTaskKanban(taskId, status) {
      return authed('PATCH', '/api/editor/tasks/' + encodeURIComponent(taskId) + '/kanban-status', { status });
    },

    // ─── CRUD + жизненный цикл через ВЕБ-cookie ───────────────────────────────
    // В editor-группе write-ручек нет (только kanban-status). Тот же набор маршрутов
    // /api/*, что использует веб-клиент IterFlow, доступен по cookie веб-сессии
    // (заведена вторым логином). CSRF-токен серверу не нужен (защита = SameSite, а у
    // нас не браузерный контекст). Все гейты (стадия/роль/автор/frozen) проверяет
    // сервер — клиент лишь не показывает заведомо запрещённые действия. 401 здесь =
    // протухла веб-сессия (web401 → перелогин), device-токен не трогаем.

    // Итерации
    async createIteration(projectId, body) { return authedCookie('POST', '/api/projects/' + encodeURIComponent(projectId) + '/iterations', body); },
    async renameIteration(id, title) { return authedCookie('PATCH', '/api/iterations/' + encodeURIComponent(id), { title }); },
    async setIterationDeadline(id, deadline) { return authedCookie('PATCH', '/api/iterations/' + encodeURIComponent(id) + '/deadline', { deadline }); },
    async deleteIteration(id) { return authedCookie('DELETE', '/api/iterations/' + encodeURIComponent(id)); },
    // action ∈ submit-scope|approve-scope|reject-scope|submit-iteration|accept-iteration|reject-iteration
    async iterationStage(id, action, body) { return authedCookie('POST', '/api/iterations/' + encodeURIComponent(id) + '/' + action, body); },

    // Задачи
    async createTask(iterationId, body) { return authedCookie('POST', '/api/iterations/' + encodeURIComponent(iterationId) + '/tasks', body); },
    async updateTask(id, body) { return authedCookie('PATCH', '/api/tasks/' + encodeURIComponent(id), body); },
    async toggleTaskDone(id) { return authedCookie('PATCH', '/api/tasks/' + encodeURIComponent(id) + '/toggle-done'); },
    async deleteTask(id) { return authedCookie('DELETE', '/api/tasks/' + encodeURIComponent(id)); },

    // Туду (project_notes)
    async createNote(projectId, body) { return authedCookie('POST', '/api/projects/' + encodeURIComponent(projectId) + '/notes', body); },
    async updateNote(noteId, body) { return authedCookie('PATCH', '/api/projects/notes/' + encodeURIComponent(noteId), body); },
    async deleteNote(noteId) { return authedCookie('DELETE', '/api/projects/notes/' + encodeURIComponent(noteId)); },
    async reorderNotes(projectId, ids) { return authedCookie('POST', '/api/projects/' + encodeURIComponent(projectId) + '/notes/reorder', { ids }); },
  };
}

module.exports = { createIterflowApi, PROD_BASE };
