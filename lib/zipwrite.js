// Потоковая запись ZIP-архива на диск — без сторонних зависимостей (zlib из Node).
// Нужен «Скачать папку как ZIP» в «Удалённых хостах»: файлы приходят по сети потоком (FTP/SFTP),
// заранее в память их не собрать (каталог сайта — гигабайты), а размер и CRC известны только
// в конце передачи. Поэтому каждая запись — deflate «на лету» + дескриптор данных (флаг 3) после неё.
//
// Пишем по явным позициям файла, а не потоком: файл, оборвавшийся посреди передачи (нет прав,
// сервер закрыл канал), откатывается — следующая запись ложится поверх его обрубка, и архив
// остаётся целым без этого файла. В конце файл обрезается по последней записанной позиции.
//
// ZIP64 включается сам: для записи — по подсказке размера (≥ 4 ГБ), для архива — когда смещения,
// размер каталога или число записей не помещаются в классические поля.
const fsp = require('fs/promises');
const zlib = require('zlib');
const { Writable } = require('stream');

const U32 = 0xFFFFFFFF;
const ZIP64_HINT = 0xFFFF0000; // запас: deflate несжимаемого чуть раздувает данные

// время файла → поля DOS (локальное время, как пишут zip/7-Zip; раньше 1980 не выразить)
function dosTime(ms) {
  const d = new Date(ms || Date.now());
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class ZipWriter {
  constructor(fh) { this.fh = fh; this.pos = 0; this.entries = []; }

  static async create(filePath) { return new ZipWriter(await fsp.open(filePath, 'w')); }

  async _write(buf) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, this.pos);
      off += bytesWritten; this.pos += bytesWritten;
    }
  }

  _localHeader(name, t, flags, method, zip64) {
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2); } // размеры придут в дескрипторе
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(zip64 ? 45 : 20, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(t.time, 10);
    h.writeUInt16LE(t.date, 12);
    // crc и размеры — нули (они в дескрипторе), у ZIP64 размеры — 0xFFFFFFFF + extra
    if (zip64) { h.writeUInt32LE(U32, 18); h.writeUInt32LE(U32, 22); }
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(extra.length, 28);
    return Buffer.concat([h, name, extra]);
  }

  // Каталог: запись без данных, имя с «/» на конце.
  async addDir(relName, mtime) {
    const name = Buffer.from(relName.replace(/\/*$/, '/'), 'utf8');
    const t = dosTime(mtime);
    const offset = this.pos;
    await this._write(this._localHeader(name, t, 0x0800, 0, false));
    this.entries.push({ name, t, flags: 0x0800, method: 0, crc: 0, csize: 0, usize: 0, offset, zip64: false, dir: true });
  }

  // Файл: feed(sink) пишет содержимое в sink и завершает его (sink.end — сам или через pipe).
  // Ошибка feed откатывает запись целиком и пробрасывается — архив остаётся пригодным.
  // onChunk(байты) — для прогресса внутри большого файла.
  async addFile(relName, mtime, sizeHint, feed, onChunk) {
    const name = Buffer.from(relName, 'utf8');
    const t = dosTime(mtime);
    const zip64 = sizeHint >= ZIP64_HINT;
    const flags = 0x0808; // бит 3 — дескриптор данных после файла, бит 11 — имя в UTF-8
    const start = this.pos;
    let crc = 0, usize = 0, csize = 0;
    let chain = this._write(this._localHeader(name, t, flags, 8, zip64));
    const deflate = zlib.createDeflateRaw({ level: 6 });
    deflate.on('data', (buf) => {
      csize += buf.length;
      deflate.pause();
      chain = chain.then(() => this._write(buf)).then(() => deflate.resume(), (e) => { deflate.destroy(e); throw e; });
    });
    const flushed = new Promise((res, rej) => {
      deflate.once('end', () => chain.then(res, rej));
      deflate.on('error', rej);
    });
    const sink = new Writable({
      write(chunk, _enc, cb) {
        crc = zlib.crc32(chunk, crc); usize += chunk.length;
        if (onChunk) onChunk(chunk.length);
        if (deflate.write(chunk)) cb(); else deflate.once('drain', () => cb());
      },
      final(cb) { deflate.end(); cb(); },
    });
    deflate.on('error', (e) => sink.destroy(e)); // источник (FTP/SFTP) узнает и оборвёт передачу
    sink.on('error', () => {}); // ошибку sink доносят feed и flushed; без слушателя она уронила бы main
    try {
      await Promise.all([feed(sink), flushed]);
      if (!zip64 && (usize >= U32 || csize >= U32)) throw new Error('Файл вырос больше 4 ГБ во время скачивания');
      const d = Buffer.alloc(zip64 ? 24 : 16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc >>> 0, 4);
      if (zip64) { d.writeBigUInt64LE(BigInt(csize), 8); d.writeBigUInt64LE(BigInt(usize), 16); }
      else { d.writeUInt32LE(csize, 8); d.writeUInt32LE(usize, 12); }
      await this._write(d);
    } catch (e) {
      deflate.destroy(); sink.destroy();
      await chain.catch(() => {}); // дождаться записи в полёте, иначе она легла бы поверх отката
      this.pos = start;
      throw e;
    }
    this.entries.push({ name, t, flags, method: 8, crc: crc >>> 0, csize, usize, offset: start, zip64, dir: false });
    return { size: usize };
  }

  async finish() {
    const cdStart = this.pos;
    const parts = [];
    for (const e of this.entries) {
      const big = e.zip64 || e.offset >= U32;
      const ex = [];
      if (big) {
        if (e.zip64) ex.push(BigInt(e.usize), BigInt(e.csize));
        if (e.offset >= U32) ex.push(BigInt(e.offset));
      }
      const extra = Buffer.alloc(ex.length ? 4 + ex.length * 8 : 0);
      if (ex.length) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(ex.length * 8, 2); ex.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8)); }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | (big ? 45 : 20), 4); // создан на Unix — внешние атрибуты = права
      h.writeUInt16LE(big ? 45 : 20, 6);
      h.writeUInt16LE(e.flags, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.t.time, 12);
      h.writeUInt16LE(e.t.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.zip64 ? U32 : e.csize, 20);
      h.writeUInt32LE(e.zip64 ? U32 : e.usize, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(e.dir ? (((0o40755 << 16) | 0x10) >>> 0) : ((0o100644 << 16) >>> 0), 38);
      h.writeUInt32LE(e.offset >= U32 ? U32 : e.offset, 42);
      parts.push(h, e.name, extra);
    }
    await this._write(Buffer.concat(parts));
    const cdSize = this.pos - cdStart, count = this.entries.length;
    if (count > 0xFFFF || cdStart >= U32 || cdSize >= U32) {
      const z = Buffer.alloc(56 + 20);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE((3 << 8) | 45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      z.writeUInt32LE(0x07064b50, 56);         // локатор ZIP64-конца
      z.writeBigUInt64LE(BigInt(this.pos), 64);
      z.writeUInt32LE(1, 72);
      await this._write(z);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, 0xFFFF), 8);
    end.writeUInt16LE(Math.min(count, 0xFFFF), 10);
    end.writeUInt32LE(Math.min(cdSize, U32), 12);
    end.writeUInt32LE(Math.min(cdStart, U32), 16);
    await this._write(end);
    await this.fh.truncate(this.pos);
    await this.fh.close();
  }

  async abort() { try { await this.fh.close(); } catch (_) { /* уже закрыт */ } }
}

module.exports = { ZipWriter, dosTime };
