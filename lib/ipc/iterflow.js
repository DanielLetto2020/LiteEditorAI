// Доменный модуль «IterFlow» (сетевой клиент /api/editor/* в main, ленивая подгрузка по первому вызову).

'use strict';

const ITERFLOW_HANDLES = [
  'iterflow:login', 'iterflow:logout', 'iterflow:session',
  'iterflow:counterparties', 'iterflow:counterpartyProjects',
  'iterflow:projectIterations', 'iterflow:iterationTasks', 'iterflow:setTaskKanban',
  'iterflow:projectNotes', 'iterflow:projectMessages',
  'iterflow:createIteration', 'iterflow:renameIteration', 'iterflow:setIterationDeadline',
  'iterflow:deleteIteration', 'iterflow:iterationStage',
  'iterflow:createTask', 'iterflow:updateTask', 'iterflow:toggleTaskDone', 'iterflow:deleteTask',
  'iterflow:createNote', 'iterflow:updateNote', 'iterflow:deleteNote',
];

/**
 * @param {object} deps
 * @param {{ handle: Function, on: Function }} deps.ipcMain
 * @param {string} deps.storeDir
 */
function registerIterflowIpc({ ipcMain, storeDir }) {
  const { createIterflowApi } = require('../iterflow-api');
  const iterflowApi = createIterflowApi({ storeDir });

  function ifWrap(fn) {
    return async (...args) => {
      try { return { ok: true, data: await fn(...args) }; }
      catch (e) { return { ok: false, error: String((e && e.message) || e), unauth: (e && e.status) === 401, web401: !!(e && e.web401) }; }
    };
  }

  ipcMain.handle('iterflow:login', ifWrap(async (_e, { email, password }) => {
    const r = await iterflowApi.login(email, password);
    return { user: r.user, profiles: r.profiles || [], teams: r.teams || [] };
  }));
  ipcMain.handle('iterflow:logout', ifWrap(async () => { await iterflowApi.logout(); return true; }));
  ipcMain.handle('iterflow:session', ifWrap(async () => {
    if (!iterflowApi.isAuthed()) return { authed: false };
    try {
      const b = await iterflowApi.me();
      return { authed: true, user: b.user, profiles: b.profiles || [], teams: b.teams || [] };
    } catch (e) {
      if ((e && e.status) === 401) return { authed: false };
      throw e;
    }
  }));
  ipcMain.handle('iterflow:counterparties', ifWrap((_e, { ctx }) => iterflowApi.counterparties(ctx)));
  ipcMain.handle('iterflow:counterpartyProjects', ifWrap((_e, { cpId }) => iterflowApi.counterpartyProjects(cpId)));
  ipcMain.handle('iterflow:projectIterations', ifWrap((_e, { projectId }) => iterflowApi.projectIterations(projectId)));
  ipcMain.handle('iterflow:iterationTasks', ifWrap((_e, { iterationId }) => iterflowApi.iterationTasks(iterationId)));
  ipcMain.handle('iterflow:setTaskKanban', ifWrap((_e, { taskId, status }) => iterflowApi.setTaskKanban(taskId, status)));
  ipcMain.handle('iterflow:projectNotes', ifWrap((_e, { projectId }) => iterflowApi.projectNotes(projectId)));
  ipcMain.handle('iterflow:projectMessages', ifWrap((_e, { projectId }) => iterflowApi.projectMessages(projectId)));
  ipcMain.handle('iterflow:createIteration', ifWrap((_e, { projectId, body }) => iterflowApi.createIteration(projectId, body)));
  ipcMain.handle('iterflow:renameIteration', ifWrap((_e, { id, title }) => iterflowApi.renameIteration(id, title)));
  ipcMain.handle('iterflow:setIterationDeadline', ifWrap((_e, { id, deadline }) => iterflowApi.setIterationDeadline(id, deadline)));
  ipcMain.handle('iterflow:deleteIteration', ifWrap((_e, { id }) => iterflowApi.deleteIteration(id)));
  ipcMain.handle('iterflow:iterationStage', ifWrap((_e, { id, action, body }) => iterflowApi.iterationStage(id, action, body)));
  ipcMain.handle('iterflow:createTask', ifWrap((_e, { iterationId, body }) => iterflowApi.createTask(iterationId, body)));
  ipcMain.handle('iterflow:updateTask', ifWrap((_e, { id, body }) => iterflowApi.updateTask(id, body)));
  ipcMain.handle('iterflow:toggleTaskDone', ifWrap((_e, { id }) => iterflowApi.toggleTaskDone(id)));
  ipcMain.handle('iterflow:deleteTask', ifWrap((_e, { id }) => iterflowApi.deleteTask(id)));
  ipcMain.handle('iterflow:createNote', ifWrap((_e, { projectId, body }) => iterflowApi.createNote(projectId, body)));
  ipcMain.handle('iterflow:updateNote', ifWrap((_e, { noteId, body }) => iterflowApi.updateNote(noteId, body)));
  ipcMain.handle('iterflow:deleteNote', ifWrap((_e, { noteId }) => iterflowApi.deleteNote(noteId)));
}

module.exports = { registerIterflowIpc, ITERFLOW_HANDLES };
