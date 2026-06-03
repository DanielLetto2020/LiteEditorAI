// Чистая логика выбора оболочки терминала для PTY — какой исполняемый файл и аргументы
// запускать, по выбору пользователя (settings.shell). Платформа, env и проверка существования
// файла ИНЖЕКТЯТСЯ → функция детерминированно тестируется node-тестом для обеих ОС
// (test/shell.test.js), без запуска Electron и без реального Windows.
//
// settings.shell: '' → дефолт платформы (Windows: PowerShell, Linux/mac: bash);
//                 'cmd'/'powershell'/'bash' → пресет; иначе — произвольный путь к exe.
// Для PowerShell добавляем -NoLogo (убрать баннер), но НЕ -NoProfile — чтобы грузился $PROFILE
// пользователя с алиасами.
const path = require('path');

// Ищет exe в PATH (на Windows ещё и в стандартной папке PowerShell 7). Возвращает путь или null.
function whichInPath(exe, platform, env, exists) {
  const isWin = platform === 'win32';
  const P = isWin ? path.win32 : path.posix;
  const sep = isWin ? ';' : ':';
  const dirs = (env.PATH || '').split(sep).filter(Boolean);
  if (isWin) dirs.push(P.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7'));
  for (const d of dirs) { try { const full = P.join(d, exe); if (exists(full)) return full; } catch (_) {} }
  return null;
}

// { platform, selected, env, exists } → { file, args }.
function resolveShell({ platform, selected, env, exists }) {
  const sel = (selected || '').trim();
  if (platform === 'win32') {
    if (sel === 'cmd') return { file: env.COMSPEC || 'cmd.exe', args: [] };
    if (sel && sel !== 'powershell' && exists(sel))                    // свой путь
      return { file: sel, args: /pwsh|powershell/i.test(path.win32.basename(sel)) ? ['-NoLogo'] : [] };
    const pwsh = whichInPath('pwsh.exe', platform, env, exists);       // дефолт/PowerShell: PS7 → Windows PowerShell
    return { file: pwsh || 'powershell.exe', args: ['-NoLogo'] };
  }
  // Linux / macOS
  if (sel && sel !== 'bash' && exists(sel)) return { file: sel, args: [] };  // свой путь (zsh/fish/…)
  for (const c of ['/bin/bash', '/usr/bin/bash']) if (exists(c)) return { file: c, args: [] };
  return { file: 'bash', args: [] };  // last resort — let PATH resolve it
}

module.exports = { resolveShell, whichInPath };
