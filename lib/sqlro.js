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

module.exports = { isReadOnlySql, stripSqlLiterals, DESTRUCTIVE };
