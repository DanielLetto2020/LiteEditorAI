// Контракт IPC-моста window.lite (формируется в preload.js через contextBridge.exposeInMainWorld)
// и служебных глобалей рендерера. Используется статической проверкой типов (tsconfig.check.json).

type Unsubscribe = () => void;

export interface LiteBridge {
  platform: string;
  homeDir: string;
  openProject(): Promise<{ path: string; name: string } | null>;
  pathForFile(file: File): string;
  pickDir(): Promise<string | null>;
  openInFileManager(target: string): Promise<{ ok?: boolean; error?: string }>;
  showItemInFolder(target: string): Promise<{ ok: boolean; error?: string }>;
  copyFile(target: string): Promise<{ ok: boolean; mode?: string; error?: string }>;
  openInBrowser(target: string): Promise<{ ok?: boolean; error?: string }>;
  openExternal(url: string): Promise<{ ok?: boolean; error?: string }>;
  copyText(text: string): void;
  readClipboard(): Promise<string>;
  log(level: string, ...args: any[]): void;

  i18n: {
    current(): { code: string; dict: Record<string, string>; rtl?: boolean };
    list(): Promise<{ current: string; list: Array<{ code: string; name: string; nativeName: string; rtl?: boolean; builtin?: boolean }> }>;
    set(code: string): Promise<{ ok: boolean; code?: string; error?: string }>;
    openUserDir(): Promise<{ ok: boolean; dir?: string; error?: string }>;
    onChange(cb: (p: { code: string; dict: Record<string, string>; rtl?: boolean }) => void): Unsubscribe;
  };

  win: {
    minimize(): void;
    maximizeToggle(): void;
    close(): void;
    show(): void;
    isMaximized(): Promise<boolean>;
    growBy(dx: number): void;
    resizeBy(dx: number): void;
    compact(on: boolean, width?: number, height?: number): void;
    onMaximizeChange(cb: (v: boolean) => void): Unsubscribe;
    onCloseRequest(cb: () => void): Unsubscribe;
    confirmClose(): void;
    onQuitCheck(cb: (id: string) => void): Unsubscribe;
    quitCheckReply(id: string, unsaved: any[]): void;
  };

  tray: {
    update(attention: number): void;
  };

  module: {
    open(modId: string, arg?: any): void;
    ready(): void;
    onArg(cb: (arg: any) => void): Unsubscribe;
    onOpenSet(cb: (ids: string[]) => void): Unsubscribe;
  };

  app: {
    setActiveProject(info: { id: string; name: string; path: string; accent?: string } | null): void;
    getActiveProject(): Promise<{ id: string; name: string; path: string; accent?: string } | null>;
    onActiveProject(cb: (info: { id: string; name: string; path: string; accent?: string } | null) => void): Unsubscribe;
    settingsChanged(s: Record<string, any>): void;
    onSettingsChanged(cb: (s: Record<string, any>) => void): Unsubscribe;
    notesChanged(id: string): void;
    onNotesChanged(cb: (id: string) => void): Unsubscribe;
    agendaChanged(id: string): void;
    onAgendaChanged(cb: (id: string) => void): Unsubscribe;
    onAgendaFocus(cb: () => void): Unsubscribe;
  };

  editorBus: {
    openInViewer(filePath: string, line?: number): void;
    openTextInViewer(name: string, content: string): Promise<{ ok: boolean; file?: string; error?: string }>;
    sendToTerminal(text: string): void;
    sendNoteToTerminal(projId: string, text: string): void;
    refreshTree(): void;
    viewerReady(): void;
    focusGit(): void;
    onFocusGit(cb: () => void): Unsubscribe;
    refreshProjects(): void;
    onRefreshProjects(cb: () => void): Unsubscribe;
    onOpenInViewer(cb: (filePath: string, line?: number) => void): Unsubscribe;
    onSendToTerminal(cb: (text: string) => void): Unsubscribe;
    onSendNoteToTerminal(cb: (projId: string, text: string) => void): Unsubscribe;
    onRefreshTree(cb: () => void): Unsubscribe;
    dockFiles(docked: boolean): void;
    filesDockState?(open: boolean): void;
    closeFilesDock(): void;
    onEnsureFilesDock(cb: (opts?: { open?: boolean; toggle?: boolean; close?: boolean }) => void): Unsubscribe;
    onRestGuard(cb: (state: any) => void): Unsubscribe;
    pomodoroSkip(): void;
  };

  pomodoro: Record<string, (...args: any[]) => any>;

  store: {
    loadAll(modId?: string | { modId?: string }): Record<string, any>;
    set(key: string, value: any): void;
    setSync(key: string, value: any): any;
    patch(key: string, set: Record<string, any>, unset?: string[]): void;
    onChanged(cb: (p: { key: string; value: any }) => void): Unsubscribe;
    notesGet(id: string): Promise<any[]>;
    notesSet(id: string, notes: any[]): Promise<any>;
    agendaGet(id: string): Promise<any[]>;
    agendaSet(id: string, agenda: any[]): Promise<any>;
    notesExport(json: string, name?: string): Promise<any>;
    notesImport(): Promise<any>;
  };

  agenda: Record<string, (...args: any[]) => any>;
  logs: Record<string, (...args: any[]) => any>;
  errors: {
    list(): Promise<any>;
    setStatus(id: string, status: string, note?: string, commit?: string): Promise<any>;
    clearResolved(): Promise<any>;
    setContext(projectPath: string | null): Promise<any>;
    onChanged(cb: () => void): Unsubscribe;
  };
  ext: {
    scan(): Promise<{ dir?: string; items?: any[] }>;
    scaffold(opts: any): Promise<any>;
  };
  openrouter: Record<string, (...args: any[]) => any>;
  tp: Record<string, (...args: any[]) => any>;
  dbai: Record<string, (...args: any[]) => any>;
  ctxmine: Record<string, (...args: any[]) => any>;
  ctxmem: Record<string, (...args: any[]) => any>;
  ctxfs: Record<string, (...args: any[]) => any>;
  ctxbk: Record<string, (...args: any[]) => any>;
  ctx: Record<string, (...args: any[]) => any>;
  update: {
    check(): Promise<any>;
    state(): Promise<any>;
    download(): Promise<any>;
    cancel(): Promise<any>;
    install(): Promise<any>;
    onState(cb: (state: any) => void): Unsubscribe;
  };
  settings: {
    export(): Promise<any>;
    import(): Promise<any>;
  };
  audit: Record<string, (...args: any[]) => any>;
  monitor: Record<string, (...args: any[]) => any>;
  keepass: Record<string, (...args: any[]) => any>;
  servers: Record<string, (...args: any[]) => any>;
  sitemon: Record<string, (...args: any[]) => any>;
  screensaver: {
    activity(): void;
    onSet(cb: (p: { on?: boolean }) => void): Unsubscribe;
  };
  company: Record<string, (...args: any[]) => any>;
  iterflow: Record<string, (...args: any[]) => any>;
  seo: Record<string, (...args: any[]) => any>;
  git: Record<string, (...args: any[]) => any>;
  containers: Record<string, (...args: any[]) => any>;
  db: Record<string, (...args: any[]) => any>;
  jira: Record<string, (...args: any[]) => any>;
  rmq: Record<string, (...args: any[]) => any>;
  storage: Record<string, (...args: any[]) => any>;
  tts: Record<string, (...args: any[]) => any>;
  kafka: Record<string, (...args: any[]) => any>;
  rh: Record<string, (...args: any[]) => any>;

  pty: {
    adoptable(): Promise<string[]>;
    create(opts: { id: string; cwd?: string; cols?: number; rows?: number }): Promise<{ ok?: boolean; existed?: boolean; backlog?: string; error?: string }>;
    write(id: string, data: string): void;
    ack?(id: string, bytes: number): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    restart(opts: { id: string; cwd?: string; cols?: number; rows?: number }): Promise<{ ok?: boolean; error?: string }>;
    foregroundState(id: string): Promise<'shell' | 'running' | 'waiting' | null>;
    agentState(id: string): Promise<{ fg: 'shell' | 'running' | 'waiting' | null; claude?: { status?: string; waitingFor?: string } | null } | null>;
    agents(ids: string[]): Promise<Record<string, { fg: string | null; agent: string | null; idle: boolean }>>;
    onData(cb: (payload: { id: string; data: string }) => void): Unsubscribe;
    onExit(cb: (payload: { id: string }) => void): Unsubscribe;
  };

  fs: {
    readDir(dir: string): Promise<Array<{ name: string; path: string; dir: boolean }> | { error: string }>;
    readFile(file: string): Promise<{ content?: string; notUtf8?: boolean; error?: string }>;
    writeFile(file: string, content: string): Promise<{ ok?: boolean; error?: string }>;
    mkdir(parent: string, name: string): Promise<{ path?: string; name?: string; error?: string }>;
    exists(p: string): Promise<boolean>;
    existsMany(paths: string[]): Promise<boolean[]>;
    create(parent: string, name: string, dir?: boolean): Promise<{ path?: string; name?: string; dir?: boolean; error?: string }>;
    rename(from: string, to: string): Promise<{ path?: string; error?: string }>;
    move(src: string, destDir: string): Promise<{ path?: string; error?: string }>;
    importPath(src: string, destDir: string): Promise<{ path?: string; name?: string; error?: string }>;
    trash(target: string): Promise<{ ok?: boolean; error?: string }>;
    readDataUrl(file: string): Promise<{ url?: string; error?: string }>;
    watch(root: string): void;
    unwatch(root: string): void;
    onChange(cb: (payload: { root: string; files: string[] }) => void): Unsubscribe;
    onWatchEnded(cb: (payload: { root: string }) => void): Unsubscribe;
    listAll(root: string): Promise<{ files?: string[]; capped?: boolean; error?: string }>;
    search(root: string, query: string, opts?: Record<string, any>): Promise<{ matches?: any[]; capped?: boolean; error?: string }>;
    replace(root: string, query: string, opts: Record<string, any>, replacement: string, targets: any[]): Promise<any>;
    diffPair(a: string, b: string): Promise<{ diff?: string; error?: string }>;
    histList(file: string): Promise<{ ok: boolean; items: any[] }>;
    histRead(file: string, name: string): Promise<{ ok?: boolean; content?: string; error?: string }>;
    histSnapshot(file: string, content?: string): Promise<{ ok?: boolean; saved?: boolean; error?: string }>;
  };

  gsearch: {
    start(runId: string, query: string, opts: Record<string, any>, roots: Array<{ id: string; name: string; path: string }>): Promise<{ ok: boolean; runId?: string; error?: string }>;
    cancel(runId: string): Promise<{ ok: boolean }>;
    onHit(cb: (p: { runId?: string; hits?: any[] }) => void): Unsubscribe;
    onProgress(cb: (p: { runId?: string; rootId?: string; name?: string; total?: number; scanned?: number }) => void): Unsubscribe;
    onDone(cb: (p: { runId?: string; total?: number; files?: number; scanned?: number; capped?: boolean; error?: string; cancelled?: boolean; ms?: number }) => void): Unsubscribe;
  };

  projTerm: {
    detach(project: Record<string, any>, snapshot: Record<string, any>): Promise<{ ok: boolean; already?: boolean; error?: string }>;
    dock(projId: string): Promise<{ ok: boolean }>;
    focus(projId: string): void;
    focusSession(projId: string, sid?: string): void;
    sendText(projId: string, text: string): void;
    closeProject(projId: string): void;
    listDetached(): Promise<{ ids: string[]; statuses: any[] }>;
    getInit(projId: string): Promise<{ ok: boolean; projId?: string; project?: any; snapshot?: any; aliveLiveIds?: string[]; deadOnDetachIds?: string[] }>;
    syncSnapshot(projId: string, snapshot: Record<string, any>): void;
    reportStatus(payload: Record<string, any>): void;
    sendCollectResult(reqId: string, snapshot: Record<string, any>): void;
    sendReattachAck(ackId: string): void;
    sendSearchResult(reqId: string, hits: any[]): void;
    searchBuffers(opts: { query: string; isRe?: boolean; caseSens?: boolean }): Promise<any[]>;
    onDetachedSet(cb: (p: { ids?: string[] }) => void): Unsubscribe;
    onReattached(cb: (p: { projId?: string; project?: any; snapshot?: any; ackId?: string }) => void): Unsubscribe;
    onStatus(cb: (p: Record<string, any>) => void): Unsubscribe;
    onSnapshot(cb: (p: { projId?: string; snapshot?: any }) => void): Unsubscribe;
    onCollect(cb: (p: { reqId?: string }) => void): Unsubscribe;
    onFocusSession(cb: (p: { sid?: string }) => void): Unsubscribe;
    onSendText(cb: (p: { projId?: string; text?: string }) => void): Unsubscribe;
    onSearchBuffers(cb: (p: { reqId?: string; query?: string; isRe?: boolean; caseSens?: boolean }) => void): Unsubscribe;
  };
}

declare global {
  interface Window {
    lite: LiteBridge;
    __liteBootError?: any;
    __i18nStats?: Record<string, number>;
    webkitAudioContext?: typeof AudioContext;
  }
  interface File {
    path?: string;
  }
}

declare module '*.css' {}

