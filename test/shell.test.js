// Тест выбора оболочки терминала (issue #2). Платформа/env/exists инжектятся, поэтому
// проверяем И Windows-, И Linux-логику без реального Windows. Запуск: node test/shell.test.js
const assert = require('assert');
const { resolveShell } = require('../lib/shell');

let passed = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };

// Хелпер: exists по белому списку существующих путей.
const mk = (present) => (p) => present.includes(p);

// ---------- Windows ----------
const winEnv = { PATH: 'C:\\Windows\\System32;C:\\bin', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', ProgramFiles: 'C:\\Program Files' };

// дефолт ('') → PowerShell 7 если есть в стандартной папке, с -NoLogo
eq(resolveShell({ platform: 'win32', selected: '', env: winEnv, exists: mk(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']) }),
   { file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] }, 'win default → pwsh7 -NoLogo');

// дефолт без pwsh → powershell.exe -NoLogo
eq(resolveShell({ platform: 'win32', selected: '', env: winEnv, exists: mk([]) }),
   { file: 'powershell.exe', args: ['-NoLogo'] }, 'win default без pwsh → powershell.exe -NoLogo');

// 'powershell' пресет → как дефолт
eq(resolveShell({ platform: 'win32', selected: 'powershell', env: winEnv, exists: mk([]) }),
   { file: 'powershell.exe', args: ['-NoLogo'] }, "win 'powershell' → powershell.exe -NoLogo");

// 'cmd' → COMSPEC, без аргументов
eq(resolveShell({ platform: 'win32', selected: 'cmd', env: winEnv, exists: mk([]) }),
   { file: 'C:\\Windows\\System32\\cmd.exe', args: [] }, "win 'cmd' → cmd.exe");

// свой путь к pwsh → -NoLogo (по имени файла)
eq(resolveShell({ platform: 'win32', selected: 'D:\\PS\\pwsh.exe', env: winEnv, exists: mk(['D:\\PS\\pwsh.exe']) }),
   { file: 'D:\\PS\\pwsh.exe', args: ['-NoLogo'] }, 'win свой путь pwsh → -NoLogo');

// свой путь к не-PowerShell (напр. git-bash) → без аргументов
eq(resolveShell({ platform: 'win32', selected: 'C:\\Git\\bin\\bash.exe', env: winEnv, exists: mk(['C:\\Git\\bin\\bash.exe']) }),
   { file: 'C:\\Git\\bin\\bash.exe', args: [] }, 'win свой путь bash → без args');

// свой путь НЕ существует → фолбэк на дефолт (powershell)
eq(resolveShell({ platform: 'win32', selected: 'C:\\nope\\fish.exe', env: winEnv, exists: mk([]) }),
   { file: 'powershell.exe', args: ['-NoLogo'] }, 'win кривой путь → фолбэк powershell');

// pwsh найден через PATH (не только ProgramFiles)
eq(resolveShell({ platform: 'win32', selected: '', env: winEnv, exists: mk(['C:\\bin\\pwsh.exe']) }),
   { file: 'C:\\bin\\pwsh.exe', args: ['-NoLogo'] }, 'win pwsh из PATH');

// ---------- Linux ----------
const nixEnv = { PATH: '/usr/bin:/bin' };

// дефолт ('') → /bin/bash
eq(resolveShell({ platform: 'linux', selected: '', env: nixEnv, exists: mk(['/bin/bash']) }),
   { file: '/bin/bash', args: [] }, 'linux default → /bin/bash');

// дефолт, /bin/bash нет, есть /usr/bin/bash
eq(resolveShell({ platform: 'linux', selected: '', env: nixEnv, exists: mk(['/usr/bin/bash']) }),
   { file: '/usr/bin/bash', args: [] }, 'linux default → /usr/bin/bash');

// 'bash' пресет → как дефолт
eq(resolveShell({ platform: 'linux', selected: 'bash', env: nixEnv, exists: mk(['/bin/bash']) }),
   { file: '/bin/bash', args: [] }, "linux 'bash' → /bin/bash");

// свой путь (zsh) существует → он, без аргументов
eq(resolveShell({ platform: 'linux', selected: '/usr/bin/zsh', env: nixEnv, exists: mk(['/usr/bin/zsh']) }),
   { file: '/usr/bin/zsh', args: [] }, 'linux свой путь zsh');

// свой путь НЕ существует → фолбэк на bash
eq(resolveShell({ platform: 'linux', selected: '/opt/fish', env: nixEnv, exists: mk(['/bin/bash']) }),
   { file: '/bin/bash', args: [] }, 'linux кривой путь → фолбэк /bin/bash');

// ничего нет → последний шанс 'bash' (PATH разрулит)
eq(resolveShell({ platform: 'linux', selected: '', env: nixEnv, exists: mk([]) }),
   { file: 'bash', args: [] }, 'linux last resort → bash');

console.log(`✓ shell: ${passed} проверок пройдено`);
