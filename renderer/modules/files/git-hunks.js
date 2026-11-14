// Парсер unified-диффа по ханкам (маркеры гаттера, попап Inline Peek, патчи отката git apply -R,
// навигация F7/Shift+F7) + расчёт дорожек компактного цветного SVG-графа коммитов для панели Git.

const GRAPH_PALETTE = [
  '#4ade80', '#60a5fa', '#f59e0b', '#c084fc',
  '#f472b6', '#2dd4bf', '#fb7185', '#a3e635',
];

export function parseUnifiedDiff(diff) {
  const result = { headerLines: [], marks: [], hunks: [] };
  if (!diff || !String(diff).trim()) return result;

  const rawAll = String(diff).replace(/\r\n/g, '\n').split('\n');
  // Убираем пустой финальный элемент после завершающего '\n', чтобы не считать его контекстной строкой
  if (rawAll.length && rawAll[rawAll.length - 1] === '') rawAll.pop();

  let idx = 0;
  while (idx < rawAll.length && !rawAll[idx].startsWith('@@')) {
    result.headerLines.push(rawAll[idx]);
    idx++;
  }

  let hunkIndex = 0;
  while (idx < rawAll.length) {
    const hdr = rawAll[idx];
    if (!hdr.startsWith('@@')) { idx++; continue; }
    const m = hdr.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    const oldStart = m ? parseInt(m[1], 10) : 1;
    const oldCount = m ? (m[2] !== undefined ? parseInt(m[2], 10) : 1) : 0;
    const newStart = m ? parseInt(m[3], 10) : 1;
    const newCount = m ? (m[4] !== undefined ? parseInt(m[4], 10) : 1) : 0;

    idx++;
    const bodyLines = [];
    while (idx < rawAll.length && !rawAll[idx].startsWith('@@') && !rawAll[idx].startsWith('diff --git ')) {
      bodyLines.push(rawAll[idx]);
      idx++;
    }

    // Разбираем строки внутри ханка на старый/новый фрагменты и пер-строчные маркеры гаттера
    let newLine = newStart;
    let pendingDel = 0;
    const oldLines = [];
    const newLines = [];
    let firstChangedLine = 0;
    let lastChangedLine = 0;
    let hasAdd = false, hasDel = false;

    const flushDel = (atLine) => {
      if (pendingDel > 0) {
        const markLn = Math.max(1, atLine);
        result.marks.push({ line: markLn, type: 'del', hunkIndex });
        if (!firstChangedLine) firstChangedLine = markLn;
        lastChangedLine = Math.max(lastChangedLine, markLn);
        pendingDel = 0;
      }
    };

    for (const ln of bodyLines) {
      if (ln.startsWith('\\')) continue; // "\ No newline at end of file"
      const ch = ln[0];
      if (ch === '+') {
        hasAdd = true;
        newLines.push(ln.slice(1));
        const type = pendingDel > 0 ? 'mod' : 'add';
        if (pendingDel > 0) pendingDel--;
        result.marks.push({ line: newLine, type, hunkIndex });
        if (!firstChangedLine) firstChangedLine = newLine;
        lastChangedLine = newLine;
        newLine++;
      } else if (ch === '-') {
        hasDel = true;
        oldLines.push(ln.slice(1));
        pendingDel++;
      } else {
        flushDel(newLine);
        newLine++;
      }
    }
    flushDel(newLine);

    const anchorLine = Math.max(1, firstChangedLine || newStart || 1);
    const endLine = Math.max(anchorLine, lastChangedLine || anchorLine);
    const type = hasAdd && hasDel ? 'mod' : hasAdd ? 'add' : 'del';
    const kind = type === 'mod' ? 'modified' : type === 'add' ? 'added' : 'deleted';
    const patch = result.headerLines.length
      ? [...result.headerLines, hdr, ...bodyLines].join('\n') + '\n'
      : '';

    result.hunks.push({
      index: hunkIndex,
      header: hdr,
      oldStart,
      oldCount,
      newStart,
      newCount,
      bodyLines,
      oldLines,
      newLines,
      oldExcerpt: oldLines.join('\n'),
      newExcerpt: newLines.join('\n'),
      anchorLine,
      endLine,
      type,
      kind,
      patch,
    });
    hunkIndex++;
  }

  return result;
}

// Найти ханк, которому принадлежит строка редактора (1-based).
// Принимает либо массив hunks (buf.gitHunks), либо объект parseUnifiedDiff(), возвращает { hunk, index } | null.
export function findHunkAtLine(parsedOrHunks, lineNumber) {
  if (!parsedOrHunks) return null;
  const hunks = Array.isArray(parsedOrHunks) ? parsedOrHunks : parsedOrHunks.hunks;
  if (!Array.isArray(hunks) || !hunks.length) return null;
  if (!Array.isArray(parsedOrHunks) && Array.isArray(parsedOrHunks.marks)) {
    for (const m of parsedOrHunks.marks) {
      if (m.line === lineNumber && hunks[m.hunkIndex]) {
        return { hunk: hunks[m.hunkIndex], index: m.hunkIndex };
      }
    }
  }
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (lineNumber >= h.anchorLine && lineNumber <= h.endLine) {
      return { hunk: h, index: i };
    }
  }
  return null;
}

// Навигация к следующему / предыдущему ханку (F7 / Shift+F7). dir: +1 или -1.
export function stepHunkAnchor(hunks, currentLine, dir = 1) {
  if (!Array.isArray(hunks) || !hunks.length) return null;
  const anchors = hunks.map((h) => h.anchorLine).sort((a, b) => a - b);
  if (dir > 0) {
    const next = anchors.find((ln) => ln > currentLine);
    return next != null ? next : anchors[0];
  }
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (anchors[i] < currentLine) return anchors[i];
  }
  return anchors[anchors.length - 1];
}

// Рассчитать компактные дорожки SVG-графа коммитов (список в топологическом порядке сверху вниз).
// commits: [{ h: string, p: string[] }]
export function layoutCommitGraph(commits, maxLanes = 8) {
  const lanes = [];       // hash ожидаемого коммита в колонке i (или null)
  const laneColors = [];  // цвет дорожки i
  let colorSeq = 0;
  const nextColor = () => GRAPH_PALETTE[colorSeq++ % GRAPH_PALETTE.length];

  const rows = [];
  for (const c of (commits || [])) {
    const hash = c.h || c.hash;
    const parents = Array.isArray(c.p) ? c.p : [];

    // Ищем все дорожки, которые ждали этот коммит
    const incomingCols = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === hash) incomingCols.push(i);
    }

    let col;
    let nodeColor;
    if (incomingCols.length > 0) {
      col = incomingCols[0];
      nodeColor = laneColors[col] || nextColor();
      // Остальные входящие дорожки слились сюда — освобождаем их
      for (let k = 1; k < incomingCols.length; k++) {
        lanes[incomingCols[k]] = null;
      }
    } else {
      const free = lanes.indexOf(null);
      if (free >= 0 && free < maxLanes) {
        col = free;
      } else if (lanes.length < maxLanes) {
        col = lanes.length;
        lanes.push(null);
      } else {
        col = maxLanes - 1;
      }
      nodeColor = nextColor();
      laneColors[col] = nodeColor;
    }

    const topPass = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null && i !== col && !incomingCols.includes(i)) {
        topPass.push({ col: i, color: laneColors[i] });
      }
    }
    const topIncoming = incomingCols.map((ic) => ({ fromCol: ic, toCol: col, color: laneColors[ic] || nodeColor }));

    // Назначаем родителей вниз
    const bottomEdges = [];
    if (parents.length === 0) {
      lanes[col] = null;
    } else {
      const firstParent = parents[0];
      const existingFirst = lanes.indexOf(firstParent);
      if (existingFirst >= 0 && existingFirst !== col) {
        // Родитель уже занял другую дорожку — сводим линию туда и освобождаем текущую
        bottomEdges.push({ fromCol: col, toCol: existingFirst, color: nodeColor });
        lanes[col] = null;
      } else {
        lanes[col] = firstParent;
        laneColors[col] = nodeColor;
        bottomEdges.push({ fromCol: col, toCol: col, color: nodeColor });
      }

      // Merge-родители (второй и далее)
      for (let pi = 1; pi < parents.length; pi++) {
        const pHash = parents[pi];
        let pCol = lanes.indexOf(pHash);
        let pColor;
        if (pCol >= 0) {
          pColor = laneColors[pCol];
        } else {
          const free = lanes.indexOf(null);
          if (free >= 0 && free < maxLanes) pCol = free;
          else if (lanes.length < maxLanes) { pCol = lanes.length; lanes.push(null); }
          else pCol = maxLanes - 1;
          pColor = nextColor();
          lanes[pCol] = pHash;
          laneColors[pCol] = pColor;
        }
        bottomEdges.push({ fromCol: col, toCol: pCol, color: pColor });
      }
    }

    // Сквозные дорожки вниз (те, что были в topPass и остались заняты)
    for (const tp of topPass) {
      if (lanes[tp.col] !== null) {
        bottomEdges.push({ fromCol: tp.col, toCol: tp.col, color: tp.color, passThrough: true });
      }
    }

    // Срезаем пустой хвост массива дорожек
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const activeWidth = Math.max(
      col + 1,
      lanes.length,
      ...topIncoming.map((e) => e.fromCol + 1),
      ...topPass.map((e) => e.col + 1),
      ...bottomEdges.map((e) => Math.max(e.fromCol, e.toCol) + 1),
    );

    rows.push({
      hash,
      col,
      color: nodeColor,
      isMerge: parents.length > 1,
      topIncoming,
      topPass,
      bottomEdges,
      cols: Math.min(maxLanes, Math.max(1, activeWidth)),
    });
  }
  return rows;
}

// Сгенерировать SVG-строку ячейки графа для одной строки коммита (высота rowH = 28px, шаг дорожки step = 11px).
export function buildCommitGraphSvg(row, totalCols = 1, rowH = 28, step = 11) {
  if (!row) return '';
  const cols = Math.max(1, Math.min(8, totalCols || row.cols || 1));
  const padX = 7;
  const w = cols * step + padX * 2;
  const midY = rowH / 2;
  const xOf = (c) => padX + c * step;
  const parts = [];

  // Сквозные линии (верхняя половина)
  for (const tp of row.topPass) {
    const x = xOf(tp.col);
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${midY}" stroke="${tp.color}" stroke-width="1.7"/>`);
  }
  // Входящие сверху к узлу коммита
  for (const inc of row.topIncoming) {
    const x1 = xOf(inc.fromCol), x2 = xOf(inc.toCol);
    if (x1 === x2) parts.push(`<line x1="${x1}" y1="0" x2="${x2}" y2="${midY}" stroke="${inc.color}" stroke-width="1.7"/>`);
    else parts.push(`<path d="M${x1} 0 C${x1} ${midY * 0.65}, ${x2} ${midY * 0.35}, ${x2} ${midY}" fill="none" stroke="${inc.color}" stroke-width="1.7"/>`);
  }
  // Уходящие вниз (и сквозные нижние половины)
  for (const b of row.bottomEdges) {
    const x1 = xOf(b.fromCol), x2 = xOf(b.toCol);
    if (x1 === x2) parts.push(`<line x1="${x1}" y1="${midY}" x2="${x2}" y2="${rowH}" stroke="${b.color}" stroke-width="1.7"/>`);
    else parts.push(`<path d="M${x1} ${midY} C${x1} ${midY + midY * 0.65}, ${x2} ${midY + midY * 0.35}, ${x2} ${rowH}" fill="none" stroke="${b.color}" stroke-width="1.7"/>`);
  }
  // Узел коммита (merge — кольцо, обычный — закрашенный круг)
  const cx = xOf(row.col);
  if (row.isMerge) {
    parts.push(`<circle cx="${cx}" cy="${midY}" r="3.6" fill="var(--mod-bg, #16181a)" stroke="${row.color}" stroke-width="2"/>`);
  } else {
    parts.push(`<circle cx="${cx}" cy="${midY}" r="3.3" fill="${row.color}"/>`);
  }
  return `<svg class="git-graph-svg" width="${w}" height="${rowH}" viewBox="0 0 ${w} ${rowH}" aria-hidden="true">${parts.join('')}</svg>`;
}
