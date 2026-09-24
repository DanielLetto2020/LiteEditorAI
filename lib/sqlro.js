// isReadOnlySql — защитный фильтр «этот SQL точно ничего не меняет».
//
// Стоит на двух путях модуля «Базы данных»: db:query для соединения, помеченного readOnly (там это
// ЕДИНСТВЕННЫЙ рубеж), и db:queryRo для вкладки AI-DB (там второй эшелон — READ ONLY-транзакция
// самой СУБД). У SQLite ложное «да» ещё и теряет данные: flushSqlite() зовётся по !isReadOnlySql,
// то есть изменение осталось бы в памяти и умерло вместе с процессом.
//
// Чистый модуль без зависимостей — чтобы npm test гонялся ДО npm ci (см. .github/workflows/ci.yml)
// и проверял его обычным node (test/sql-readonly.test.js).
// NB: `replace` is intentionally absent here — it would block the read-only `SELECT REPLACE(col,'a','b')`
// string function as if it were a write. `REPLACE INTO` trips `into`, `CREATE OR REPLACE` trips `create`,
// and MySQL's INTO-less `REPLACE t VALUES …` is caught as a statement start (UNSAFE_STMT below).
const DESTRUCTIVE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|call|do|vacuum|reindex|attach|detach|lock|rename|into|load|handler)\b/i;
// Не пишут в таблицы сами, но снимают защиту «только чтение» или бьют по серверу — поэтому тоже «не чтение».
// По первому слову оператора: REPLACE без INTO (MySQL), RESET/DISCARD (сбрасывают default_transaction_read_only),
// PREPARE/EXECUTE (выполняют SQL из строки или переменной — фильтр его не видит), KILL/SHUTDOWN/RESTART,
// администрирование и запись статистики/комментариев. START — кроме START TRANSACTION.
const UNSAFE_STMT = /^[\s(]*(?:(?:replace|reset|discard|prepare|execute|kill|shutdown|restart|clone|binlog|change|stop|flush|purge|install|uninstall|optimize|repair|analyze|checkpoint|cluster|refresh|reassign|import|security|comment)\b|start\b(?!\s+transaction\b))/i;
// SET, который переключает режим транзакции, роль/пользователя или глобальные настройки сервера.
// SET search_path / NAMES / timezone / statement_timeout / @переменная остаются разрешены.
const UNSAFE_SET = /^[\s(]*set\b[\s\S]*?(?:\b(?:transaction|characteristics|role|authorization|global|persist|persist_only|password|sql_log_bin)\b|read_only\b|@@global)/i;
// «READ WRITE» в BEGIN/START TRANSACTION/SET TRANSACTION перекрывает read-only по умолчанию.
const READ_WRITE = /\bread\s+write\b/i;
// Функции с побочными эффектами, которые READ ONLY-транзакция не останавливает (или обходит):
// завершение чужих сессий, перечитка конфига, запись файлов на сервере, dblink (своё соединение,
// не read-only), query_to_xml (выполняет SQL из строки), set_config (снимает default_transaction_read_only
// на сессию), сдвиг последовательностей, UDF sys_exec MySQL. Ищутся и в кавычках: "setval"(…).
const UNSAFE_FN = /\b(?:pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_switch_wal|pg_create_restore_point|set_config|setval|nextval|lo_import|lo_export|lo_unlink|lo_create|lo_creat|lo_put|lo_truncate|lo_from_bytea|dblink\w*|query_to_xml\w*|pg_file_\w+|sys_exec|sys_eval)\s*\(/i;
// Комментарии и строковые литералы снимаем ОДНИМ проходом слева направо, а не тремя regexp'ами
// подряд. Порядок «сначала все комментарии, потом все строки» ломался о `--` ВНУТРИ строки:
// `SELECT 'a--'; DROP TABLE t;` терял всё после апострофа, фильтр видел безобидный `SELECT 'a`
// и пропускал запрос. Для соединения «только чтение» это был прямой обход запрета, а для SQLite
// ещё и потеря данных: flushSqlite() вызывается по !isReadOnlySql, то есть изменение оставалось
// в памяти и умирало вместе с процессом.
//
// Где кончается строка, у каждой СУБД своё, и один и тот же текст одна читает строкой, а другая —
// кодом. Поэтому разбор параметризован правилами лексики (lex), а isReadOnlySql прогоняет запрос
// через правила КАЖДОГО режима своей СУБД и пропускает, только если все согласны:
//   bs       — где обратный слэш экранирует кавычку в '…': 'none' | 'E' (только E'…' Postgres) | 'all'
//              ('\'' в MySQL — экранированная кавычка и конец строки, а для разбора «без слэша» — удвоение,
//              строка тянулась дальше и прятала `; DROP TABLE t`);
//   bsDq     — то же для "…" (в MySQL без ANSI_QUOTES это строка);
//   dollar   — долларовые кавычки Postgres ($$…$$, $tag$…$tag$): апостроф внутри них иначе открывал
//              «строку», которая глотала следующий оператор;
//   brackets — [идентификатор] SQLite (с тем же эффектом для апострофа внутри скобок);
//   myDash   — «--» комментарий, только если за ним пробельный/управляющий символ (MySQL: «1--1» — код);
//   hash     — «#» до конца строки — комментарий (MySQL);
//   exec     — /*! … */ и /*M! … */ MySQL/MariaDB ИСПОЛНЯЮТ: их содержимое — код, а не комментарий;
//   keepIdents — вместо идентификатора в кавычках отдать его имя (для поиска функций: "setval"(…)).
// Без lex — прежний разбор: '…', "…", `…` с удвоением, «--» и /* */ — комментарии.
// Незакрытая строка отдаёт хвост как код: лишний отказ возможен, лишнее разрешение — нет.
const WORD_CH = /[\w$\u0080-\uffff]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y;   // длина метки не ограничена
function stripSqlLiterals(sql, lex = {}) {
  const s = String(sql);
  let out = '', i = 0, inExec = false;
  while (i < s.length) {
    const c = s[i], c2 = s[i + 1];
    if (inExec && c === '*' && c2 === '/') { out += ' '; i += 2; inExec = false; continue; }
    if ((c === '-' && c2 === '-' && !(lex.myDash && i + 2 < s.length && s.charCodeAt(i + 2) > 32)) || (c === '#' && lex.hash)) {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const ex = lex.exec ? /^\/\*M?!\d*/.exec(s.slice(i, i + 16)) : null;
      if (ex || inExec) { out += ' '; i += ex ? ex[0].length : 2; inExec = true; continue; }   // «/*» внутри исполняемого — тоже код
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      // Комментарий — разделитель: без пробела «t/**/INTO OUTFILE» склеивался в «tINTO», и \binto\b его не видел.
      i += 2; out += ' '; continue;
    }
    if (c === '$' && lex.dollar && !WORD_CH.test(s[i - 1] || '')) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(s);
      if (m) {
        const close = s.indexOf(m[0], i + m[0].length);
        if (close < 0) { out += s.slice(i); break; }
        out += '$$'; i = close + m[0].length; continue;
      }
    }
    if (c === "'" || c === '"' || c === '`' || (c === '[' && lex.brackets)) {
      const end = c === '[' ? ']' : c;
      const bsOn = c === "'" ? (lex.bs === 'all' || (lex.bs === 'E' && /[eE]/.test(s[i - 1] || '') && !WORD_CH.test(s[i - 2] || '')))
        : (c === '"' && !!lex.bsDq);
      const open = i;
      let closed = false;
      i++;
      while (i < s.length) {
        if (bsOn && s[i] === '\\') { i += 2; continue; }
        if (s[i] !== end) { i++; continue; }
        if (c !== '[' && s[i + 1] === end) { i += 2; continue; }   // удвоение внутри литерала
        i++; closed = true; break;
      }
      // Не нашли закрывающую кавычку — значит это была не строка (например апостроф внутри
      // долларовых кавычек Postgres: `SELECT $$it's$$; DROP TABLE t;`). Проглотить остаток
      // было бы дырой: хвост с DROP исчез бы из проверки. Отдаём его как код.
      if (!closed) { out += s.slice(open); break; }
      if (lex.keepIdents && c !== "'" && !(c === '"' && lex.bsDq)) out += ' ' + s.slice(open + 1, i - 1).replace(/[^\w$]/g, '_') + ' ';
      else out += c + end;                           // пустышка вместо литерала/идентификатора
      continue;
    }
    out += c; i++;
  }
  return out;
}
// Режимы, в которых СУБД режет текст по-разному. Для известной СУБД проверяем только её режимы
// (меньше ложных отказов), без неё — все сразу.
const LEX = {
  postgres: [
    { bs: 'E', dollar: true },                                   // standard_conforming_strings = on (по умолчанию)
    { bs: 'all', dollar: true },                                 // standard_conforming_strings = off
  ],
  mysql: [
    { bs: 'all', bsDq: true, myDash: true, hash: true, exec: true },   // по умолчанию: "…" — строка
    { bs: 'all', myDash: true, hash: true, exec: true },               // ANSI_QUOTES: "…" — идентификатор
    { bs: 'none', myDash: true, hash: true, exec: true },              // NO_BACKSLASH_ESCAPES
  ],
  sqlite: [{ brackets: true }],
};
const ALL_LEX = [{}, ...LEX.postgres, ...LEX.mysql, ...LEX.sqlite];
const lexFor = (dialect) => LEX[dialect] || ALL_LEX;
// dialect — 'postgres' | 'mysql' | 'sqlite' (тип подключения); не задан — проверка по всем СУБД.
function isReadOnlySql(sql, dialect) {
  return lexFor(dialect).every((lex) => {
    const code = stripSqlLiterals(sql, lex);
    if (DESTRUCTIVE.test(code) || READ_WRITE.test(code)) return false;
    if (code.split(';').some((st) => UNSAFE_STMT.test(st) || UNSAFE_SET.test(st))) return false;
    // U&"…" — имя с \XXXX-экранами: под ним прячется любая функция, в чтении такое не нужно
    if (/\bu&""/i.test(code)) return false;
    return !UNSAFE_FN.test(stripSqlLiterals(sql, { ...lex, keepIdents: true }));
  });
}

// ---- разметка SQL для интерфейса SQL-консоли: где код, а где строки/комментарии ----
// Консоль режет «запрос под курсором» по «;» и ищет :параметры. Раньше это делалось по сырому
// тексту: «;» внутри строки ('a;b') резал запрос посередине, а «:b» внутри строки ('a:b')
// превращался в параметр и подменялся значением прямо в литерале. Разметка отличает код от
// строк, идентификаторов в кавычках, комментариев и долларовых кавычек Postgres ($$…$$, $tag$…$tag$).
// Незакрытый литерал тянется до конца текста — для разбиения это безопасно (лишнего «;» не будет).
function sqlSegments(sql) {
  const s = String(sql);
  const out = [];
  let i = 0, codeStart = 0;
  while (i < s.length) {
    const c = s[i], c2 = s[i + 1];
    let end = -1;
    if (c === '-' && c2 === '-') { end = s.indexOf('\n', i); if (end < 0) end = s.length; }
    else if (c === '/' && c2 === '*') { end = s.indexOf('*/', i + 2); end = end < 0 ? s.length : end + 2; }
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      end = s.length;
      while (j < s.length) {
        if (s[j] !== c) { j++; continue; }
        if (s[j + 1] === c) { j += 2; continue; }   // удвоение внутри литерала
        end = j + 1; break;
      }
    } else if (c === '$' && !/[\w$]/.test(s[i - 1] || '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));   // $1 (параметр pg) сюда не попадает
      if (m) { const close = s.indexOf(m[0], i + m[0].length); end = close < 0 ? s.length : close + m[0].length; }
    }
    if (end < 0) { i++; continue; }
    if (i > codeStart) out.push({ code: true, from: codeStart, to: i });
    out.push({ code: false, from: i, to: end });
    i = end; codeStart = end;
  }
  if (s.length > codeStart) out.push({ code: true, from: codeStart, to: s.length });
  return out;
}
// Диапазоны операторов [{from, to}] — «;» учитываются только в коде (сам «;» в диапазон не входит).
function splitSqlStatements(sql) {
  const s = String(sql);
  const out = [];
  let from = 0;
  for (const seg of sqlSegments(s)) {
    if (!seg.code) continue;
    for (let k = seg.from; k < seg.to; k++) if (s[k] === ';') { out.push({ from, to: k }); from = k + 1; }
  }
  out.push({ from, to: s.length });
  return out;
}
// Именованные параметры :name только в коде. Не параметры: приведения типов (x::text), MySQL «:=»,
// срезы массивов (a[1:n]) — перед двоеточием стоит двоеточие, буква или цифра.
const PARAM_RE = /(?<![\w:]):([A-Za-z_]\w*)/g;
function findSqlParams(sql) {
  const s = String(sql);
  const names = [];
  for (const seg of sqlSegments(s)) {
    if (!seg.code) continue;
    for (const m of s.slice(seg.from, seg.to).matchAll(PARAM_RE)) if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}
// Подставить значения параметров: valueOf(name) → готовый SQL-литерал; литералы и комментарии не трогаем.
function substituteSqlParams(sql, valueOf) {
  const s = String(sql);
  return sqlSegments(s).map((seg) => {
    const part = s.slice(seg.from, seg.to);
    return seg.code ? part.replace(PARAM_RE, (_m, name) => valueOf(name)) : part;
  }).join('');
}

module.exports = { isReadOnlySql, stripSqlLiterals, DESTRUCTIVE, sqlSegments, splitSqlStatements, findSqlParams, substituteSqlParams };
