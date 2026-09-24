// isReadOnlySql — защитный фильтр «этот SQL точно ничего не меняет».
//
// Стоит на двух путях модуля «Базы данных»: db:query для соединения, помеченного readOnly (там это
// ЕДИНСТВЕННЫЙ рубеж), и db:queryRo для вкладки AI-DB (там второй эшелон — READ ONLY-транзакция
// самой СУБД). У SQLite ложное «да» ещё и теряет данные: flushSqlite() зовётся по !isReadOnlySql,
// то есть изменение осталось бы в памяти и умерло вместе с процессом.
//
// Чистый модуль без зависимостей — чтобы npm test гонялся ДО npm ci (см. .github/workflows/ci.yml)
// и проверял его обычным node (test/sql-readonly.test.js).
// NB: `replace` is intentionally absent — every destructive REPLACE already trips another token
// (`REPLACE INTO` → into, `CREATE OR REPLACE` → create), and listing it would block the read-only
// `SELECT REPLACE(col,'a','b')` string function as if it were a write.
const DESTRUCTIVE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|call|do|vacuum|reindex|attach|detach|lock|rename|into|load|handler)\b/i;
// Комментарии и строковые литералы снимаем ОДНИМ проходом слева направо, а не тремя regexp'ами
// подряд. Порядок «сначала все комментарии, потом все строки» ломался о `--` ВНУТРИ строки:
// `SELECT 'a--'; DROP TABLE t;` терял всё после апострофа, фильтр видел безобидный `SELECT 'a`
// и пропускал запрос. Для соединения «только чтение» это был прямой обход запрета, а для SQLite
// ещё и потеря данных: flushSqlite() вызывается по !isReadOnlySql, то есть изменение оставалось
// в памяти и умирало вместе с процессом.
//
// Обратный слэш ЭКРАНИРУЮЩИМ не считаем намеренно: диалекты расходятся (MySQL экранирует,
// Postgres со standard_conforming_strings — нет). Ошибка в эту сторону закрывает строку раньше,
// и «хвост» проверяется как код: можно получить лишний отказ, но не лишнее разрешение.
function stripSqlLiterals(sql) {
  const s = String(sql);
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i], c2 = s[i + 1];
    if (c === '-' && c2 === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const open = i;
      let closed = false;
      i++;
      while (i < s.length) {
        if (s[i] !== c) { i++; continue; }
        if (s[i + 1] === c) { i += 2; continue; }   // удвоение внутри литерала
        i++; closed = true; break;
      }
      // Не нашли закрывающую кавычку — значит это была не строка (например апостроф внутри
      // долларовых кавычек Postgres: `SELECT $$it's$$; DROP TABLE t;`). Проглотить остаток
      // было бы дырой: хвост с DROP исчез бы из проверки. Отдаём его как код.
      if (!closed) { out += s.slice(open); break; }
      out += c + c;                                  // пустышка вместо литерала/идентификатора
      continue;
    }
    out += c; i++;
  }
  return out;
}
function isReadOnlySql(sql) {
  return !DESTRUCTIVE.test(stripSqlLiterals(sql));
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
