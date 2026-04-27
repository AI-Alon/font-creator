// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const COLS = 50, ROWS = 50, CELL = 10;
const BASELINE_ROW = 37;   // 0-indexed; row 38 in 1-indexed
const CAPHEIGHT_ROW = 7;   // 0-indexed; row 8 in 1-indexed
const STORAGE_KEY = 'fontcreator_glyphs';
const SUPPORTED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!?.,;:@#$%&*()-_+=[]/ \\'.split('');

// ─── STATE ────────────────────────────────────────────────────────────────────
let currentChar = 'A';
let glyphs = {};        // { 'A': Uint8Array(2500), ... }
let tool = 'pencil';
let isDrawing = false;
let drawValue = 1;
let undoStacks = {};
let redoStacks = {};
let zoom = 1;
let saveDebounce = null;
let cardMap = new Map(); // char → DOM element

// ─── ELEMENT REFS ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');
const canvasWrapper = document.getElementById('canvas-wrapper');
const canvasOuter = document.querySelector('.canvas-outer');
const charGrid = document.getElementById('char-grid');
const previewInput = document.getElementById('preview-input');
const previewSm = document.getElementById('preview-canvas-sm');
const previewLg = document.getElementById('preview-canvas-lg');
const currentCharLabel = document.getElementById('current-char-label');
const glyphCount = document.getElementById('glyph-count');
const statTotal = document.getElementById('stat-total');
const statCurrent = document.getElementById('stat-current');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingMsg = document.getElementById('loading-msg');
const fileInput = document.getElementById('file-input');
const zoomSlider = document.getElementById('zoom-slider');
const zoomValueEl = document.getElementById('zoom-value');

// ─── GLYPH HELPERS ────────────────────────────────────────────────────────────
function emptyGlyph() { return new Uint8Array(COLS * ROWS); }
function getGlyph(ch) { if (!glyphs[ch]) glyphs[ch] = emptyGlyph(); return glyphs[ch]; }
function getCell(g, col, row) { return g[row * COLS + col]; }
function setCell(g, col, row, val) { g[row * COLS + col] = val; }
function isGlyphEmpty(ch) { return !glyphs[ch] || glyphs[ch].every(v => v === 0); }

// ─── UNDO / REDO ──────────────────────────────────────────────────────────────
function pushUndo(ch) {
  if (!undoStacks[ch]) undoStacks[ch] = [];
  if (!redoStacks[ch]) redoStacks[ch] = [];
  undoStacks[ch].push(new Uint8Array(getGlyph(ch)));
  if (undoStacks[ch].length > 30) undoStacks[ch].shift();
  redoStacks[ch] = [];
}

function undo() {
  const us = undoStacks[currentChar];
  if (!us || us.length === 0) return;
  if (!redoStacks[currentChar]) redoStacks[currentChar] = [];
  redoStacks[currentChar].push(new Uint8Array(getGlyph(currentChar)));
  glyphs[currentChar] = us.pop();
  afterEdit();
}

function redo() {
  const rs = redoStacks[currentChar];
  if (!rs || rs.length === 0) return;
  if (!undoStacks[currentChar]) undoStacks[currentChar] = [];
  undoStacks[currentChar].push(new Uint8Array(getGlyph(currentChar)));
  glyphs[currentChar] = rs.pop();
  afterEdit();
}

function afterEdit() {
  renderCanvas();
  renderPreviews();
  scheduleSave();
  refreshCard(currentChar);
  updateStats();
}

// ─── RENDER MAIN CANVAS ───────────────────────────────────────────────────────
function renderCanvas() {
  const g = getGlyph(currentChar);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Filled cells
  ctx.fillStyle = '#1a1a1a';
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (getCell(g, col, row)) ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
    }
  }

  // Fine grid
  ctx.strokeStyle = 'rgba(0,0,0,0.04)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= COLS; i++) {
    ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, canvas.height); ctx.stroke();
  }
  for (let j = 0; j <= ROWS; j++) {
    ctx.beginPath(); ctx.moveTo(0, j * CELL); ctx.lineTo(canvas.width, j * CELL); ctx.stroke();
  }

  // Ruler guides every 10 cells
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= COLS; i += 10) {
    ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, canvas.height); ctx.stroke();
  }
  for (let j = 0; j <= ROWS; j += 10) {
    ctx.beginPath(); ctx.moveTo(0, j * CELL); ctx.lineTo(canvas.width, j * CELL); ctx.stroke();
  }

  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;

  // Baseline (blue) — bottom of row 37 = y pixel 380
  ctx.strokeStyle = 'rgba(59,130,246,0.75)';
  ctx.beginPath();
  ctx.moveTo(0, (BASELINE_ROW + 1) * CELL);
  ctx.lineTo(canvas.width, (BASELINE_ROW + 1) * CELL);
  ctx.stroke();

  // Cap height (red) — top of row 7 = y pixel 70
  ctx.strokeStyle = 'rgba(239,68,68,0.75)';
  ctx.beginPath();
  ctx.moveTo(0, CAPHEIGHT_ROW * CELL);
  ctx.lineTo(canvas.width, CAPHEIGHT_ROW * CELL);
  ctx.stroke();

  ctx.setLineDash([]);
}

// ─── CANVAS INTERACTION ───────────────────────────────────────────────────────
function cellFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const col = Math.floor((e.clientX - rect.left) / rect.width * COLS);
  const row = Math.floor((e.clientY - rect.top) / rect.height * ROWS);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return { col, row };
}

let lastPainted = null;

function paintCell(e) {
  const cell = cellFromEvent(e);
  if (!cell) return;
  const key = cell.col + ',' + cell.row;
  if (key === lastPainted) return;
  lastPainted = key;
  const g = getGlyph(currentChar);
  if (getCell(g, cell.col, cell.row) === drawValue) return;
  setCell(g, cell.col, cell.row, drawValue);
  renderCanvas();
  renderPreviews();
}

canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return;

  if (tool === 'bucket') {
    const cell = cellFromEvent(e);
    if (!cell) return;
    pushUndo(currentChar);
    const g = getGlyph(currentChar);
    // Fill with opposite of what was clicked: if cell is empty → fill, if filled → erase
    const fillVal = getCell(g, cell.col, cell.row) === 0 ? 1 : 0;
    const changed = floodFill(g, cell.col, cell.row, fillVal);
    if (changed) {
      renderCanvas();
      renderPreviews();
      scheduleSave();
      refreshCard(currentChar);
      updateStats();
    }
    return;
  }

  pushUndo(currentChar);
  drawValue = (tool === 'eraser') ? 0 : 1;
  lastPainted = null;
  isDrawing = true;
  paintCell(e);
});

window.addEventListener('mousemove', e => { if (isDrawing) paintCell(e); });

window.addEventListener('mouseup', () => {
  if (isDrawing) {
    isDrawing = false;
    scheduleSave();
    refreshCard(currentChar);
    updateStats();
  }
});

canvas.addEventListener('contextmenu', e => e.preventDefault());

// ─── ZOOM ─────────────────────────────────────────────────────────────────────
function applyZoom(z) {
  zoom = z;
  zoomValueEl.textContent = z.toFixed(1).replace('.0', '') + '×';
  canvasWrapper.style.transform = `scale(${z})`;
  canvasWrapper.style.transformOrigin = 'top left';
  canvasOuter.style.width = (500 * z) + 'px';
  canvasOuter.style.height = (500 * z) + 'px';
}

zoomSlider.addEventListener('input', () => applyZoom(parseFloat(zoomSlider.value)));

// ─── CHARACTER SELECTOR ───────────────────────────────────────────────────────
function buildCharGrid() {
  charGrid.innerHTML = '';
  cardMap.clear();
  SUPPORTED_CHARS.forEach(ch => {
    const label = ch === ' ' ? 'SP' : ch;
    const card = document.createElement('div');
    card.className = 'char-card' + (ch === currentChar ? ' active' : '');
    card.title = ch === ' ' ? 'Space' : `"${ch}"`;
    const span = document.createElement('span');
    span.textContent = label;
    card.appendChild(span);
    card.addEventListener('click', () => selectChar(ch));
    charGrid.appendChild(card);
    cardMap.set(ch, card);
  });
  refreshAllCards();
}

function refreshCard(ch) {
  const card = cardMap.get(ch);
  if (!card) return;
  const empty = isGlyphEmpty(ch);
  card.classList.toggle('drawn', !empty);
  let badge = card.querySelector('.char-badge');
  if (!empty) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'char-badge';
      badge.innerHTML = '<svg viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" fill="none" stroke="#6c47ff" stroke-width="2.5"/></svg>';
      card.appendChild(badge);
    }
  } else if (badge) {
    badge.remove();
  }
}

function refreshAllCards() {
  SUPPORTED_CHARS.forEach(ch => refreshCard(ch));
  updateStats();
}

function selectChar(ch) {
  const prevCard = cardMap.get(currentChar);
  if (prevCard) prevCard.classList.remove('active');

  currentChar = ch;
  const label = ch === ' ' ? 'SP' : ch;
  currentCharLabel.textContent = label;
  statCurrent.textContent = ch === ' ' ? 'Space' : `"${ch}"`;

  const newCard = cardMap.get(ch);
  if (newCard) {
    newCard.classList.add('active');
    newCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  renderCanvas();
  renderPreviews();
}

function updateStats() {
  const count = SUPPORTED_CHARS.filter(c => !isGlyphEmpty(c)).length;
  glyphCount.textContent = count + ' drawn';
  statTotal.textContent = count;
}

// ─── LIVE PREVIEW ─────────────────────────────────────────────────────────────
function renderPreviews() {
  const text = previewInput.value || '';
  drawPreview(previewSm, text, 40);
  drawPreview(previewLg, text, 80);
}

function drawPreview(cvs, text, glyphHeight) {
  const scale = glyphHeight / (ROWS * CELL);
  const glyphW = Math.round(COLS * CELL * scale);
  const gap = Math.max(1, Math.round(3 * scale));
  const sidePad = 8;
  const chars = text.split('');
  const totalW = Math.max(sidePad * 2, sidePad * 2 + chars.length * (glyphW + gap) - gap);

  cvs.width = Math.min(totalW, 252);
  cvs.height = glyphHeight + 4;

  const c = cvs.getContext('2d');
  c.clearRect(0, 0, cvs.width, cvs.height);
  c.fillStyle = '#f7f7f5';
  c.fillRect(0, 0, cvs.width, cvs.height);

  chars.forEach((ch, i) => {
    const x = sidePad + i * (glyphW + gap);
    if (x + glyphW > cvs.width + 10) return;
    const y = 2;

    if (isGlyphEmpty(ch) || !glyphs[ch]) {
      c.strokeStyle = '#ccc';
      c.lineWidth = 1;
      c.setLineDash([2, 2]);
      c.strokeRect(x + 0.5, y + 0.5, glyphW - 1, glyphHeight - 1);
      c.setLineDash([]);
    } else {
      const g = glyphs[ch];
      c.fillStyle = '#1a1a1a';
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          if (getCell(g, col, row)) {
            const px = x + Math.round(col * CELL * scale);
            const py = y + Math.round(row * CELL * scale);
            const sz = Math.max(1, Math.round(CELL * scale));
            c.fillRect(px, py, sz, sz);
          }
        }
      }
    }
  });
}

previewInput.addEventListener('input', renderPreviews);

// ─── TOOLBAR ─────────────────────────────────────────────────────────────────
document.getElementById('btn-pencil').addEventListener('click', () => setTool('pencil'));
document.getElementById('btn-eraser').addEventListener('click', () => setTool('eraser'));
document.getElementById('btn-bucket').addEventListener('click', () => setTool('bucket'));

function setTool(t) {
  tool = t;
  canvas.style.cursor = t === 'bucket' ? 'cell' : 'crosshair';
  document.querySelectorAll('.btn-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
}

// ─── FLOOD FILL ───────────────────────────────────────────────────────────────
function floodFill(g, startCol, startRow, fillValue) {
  const target = getCell(g, startCol, startRow);
  if (target === fillValue) return false; // nothing to do

  const stack = [[startCol, startRow]];
  const seen = new Uint8Array(COLS * ROWS); // faster than a Set

  while (stack.length) {
    const [col, row] = stack.pop();
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) continue;
    const idx = row * COLS + col;
    if (seen[idx]) continue;
    if (getCell(g, col, row) !== target) continue;
    seen[idx] = 1;
    setCell(g, col, row, fillValue);
    stack.push([col + 1, row], [col - 1, row], [col, row + 1], [col, row - 1]);
  }
  return true;
}

document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

document.getElementById('btn-clear').addEventListener('click', () => {
  pushUndo(currentChar);
  glyphs[currentChar] = emptyGlyph();
  afterEdit();
});

document.getElementById('btn-clear-all').addEventListener('click', () => {
  const count = SUPPORTED_CHARS.filter(c => !isGlyphEmpty(c)).length;
  if (count === 0) { alert('Font is already empty.'); return; }
  if (!confirm(`Clear all ${count} drawn glyphs and start fresh? This cannot be undone.`)) return;
  glyphs = {};
  undoStacks = {};
  redoStacks = {};
  localStorage.removeItem(STORAGE_KEY);
  renderCanvas();
  renderPreviews();
  refreshAllCards();
});

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.ctrlKey && e.shiftKey && e.key === 'Z') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); return; }

  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
    if (SUPPORTED_CHARS.includes(e.key)) selectChar(e.key);
  }
});

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function scheduleSave() {
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(saveToStorage, 300);
}

function saveToStorage() {
  const data = {};
  SUPPORTED_CHARS.forEach(ch => {
    if (!isGlyphEmpty(ch)) data[ch] = Array.from(glyphs[ch]);
  });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    Object.keys(data).forEach(ch => { glyphs[ch] = new Uint8Array(data[ch]); });
  } catch (e) { /* corrupt */ }
}

// ─── IMPORT FONT ──────────────────────────────────────────────────────────────
document.getElementById('btn-import').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  fileInput.value = '';
  loadingMsg.textContent = 'Parsing font…';
  loadingOverlay.classList.remove('hidden');
  try {
    const buf = await file.arrayBuffer();
    const font = opentype.parse(buf);
    await importFont(font);
  } catch (err) {
    alert('Import failed: ' + err.message);
    console.error(err);
  } finally {
    loadingOverlay.classList.add('hidden');
  }
});

async function importFont(font) {
  const offscreen = document.createElement('canvas');
  offscreen.width = 500;
  offscreen.height = 500;
  const octx = offscreen.getContext('2d');

  // Map font ascender to cap-height pixel row (pixel y = CAPHEIGHT_ROW * CELL = 70)
  // Baseline pixel y = (BASELINE_ROW + 1) * CELL = 380
  const basePixelY = (BASELINE_ROW + 1) * CELL;    // 380
  const capPixelY = CAPHEIGHT_ROW * CELL;           // 70
  const pixelAscent = basePixelY - capPixelY;       // 310 px available above baseline

  const fontAscender = font.ascender || (font.unitsPerEm * 0.8);
  const scale = pixelAscent / fontAscender;
  const fontSize = font.unitsPerEm * scale;

  let processed = 0;
  for (const ch of SUPPORTED_CHARS) {
    if (ch === ' ') continue;
    loadingMsg.textContent = `Rasterizing "${ch}" … (${++processed}/${SUPPORTED_CHARS.length - 1})`;

    let glyph;
    try { glyph = font.charToGlyph(ch); } catch (e) { continue; }
    if (!glyph || glyph.index === 0) continue;

    const bb = glyph.getBoundingBox();
    if (bb.x1 >= bb.x2 || bb.y1 >= bb.y2) continue;

    octx.clearRect(0, 0, 500, 500);
    octx.fillStyle = '#000';

    // Render glyph: x=0 positions left bearing at 0; y=basePixelY is baseline
    // Use a slight left margin so descenders are centered
    const glyphAdvance = (glyph.advanceWidth || font.unitsPerEm) * scale;
    const offsetX = Math.max(0, (500 - glyphAdvance) / 2);

    const path = glyph.getPath(offsetX, basePixelY, fontSize);
    const svgStr = path.toSVG();
    const p2d = new Path2D(svgStr);
    octx.fill(p2d);

    const imageData = octx.getImageData(0, 0, 500, 500);
    const px = imageData.data;
    const g = emptyGlyph();

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        let dark = 0;
        for (let dy = 0; dy < CELL; dy++) {
          for (let dx = 0; dx < CELL; dx++) {
            const idx = ((row * CELL + dy) * 500 + (col * CELL + dx)) * 4;
            const a = px[idx + 3];
            const lum = (px[idx] + px[idx+1] + px[idx+2]) / 3;
            if (a > 50 && lum < 128) dark++;
          }
        }
        if (dark > CELL * CELL * 0.35) setCell(g, col, row, 1);
      }
    }
    glyphs[ch] = g;
    await new Promise(r => setTimeout(r, 0)); // yield
  }

  renderCanvas();
  renderPreviews();
  refreshAllCards();
  saveToStorage();
}

// ─── EXPORT SVG ───────────────────────────────────────────────────────────────
document.getElementById('btn-export-svg').addEventListener('click', exportSVG);

function exportSVG() {
  const drawn = SUPPORTED_CHARS.filter(c => !isGlyphEmpty(c));
  if (drawn.length === 0) { alert('No glyphs drawn yet.'); return; }

  const gSize = 60, labelH = 14, pad = 8;
  const cols = 12;
  const rows = Math.ceil(drawn.length / cols);
  const W = cols * (gSize + pad) + pad;
  const H = rows * (gSize + labelH + pad) + pad;

  let parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="#f7f7f5"/>`];

  drawn.forEach((ch, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const ox = pad + col * (gSize + pad);
    const oy = pad + row * (gSize + labelH + pad);
    const s = gSize / 500;

    parts.push(`<rect x="${ox}" y="${oy}" width="${gSize}" height="${gSize}" fill="white" rx="5"/>`);

    const g = glyphs[ch];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (getCell(g, c, r)) {
          const px = (ox + c * CELL * s).toFixed(2);
          const py = (oy + r * CELL * s).toFixed(2);
          const sz = (CELL * s).toFixed(2);
          parts.push(`<rect x="${px}" y="${py}" width="${sz}" height="${sz}" fill="#1a1a1a"/>`);
        }
      }
    }

    const safeLabel = ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === ' ' ? 'SP' : ch;
    parts.push(`<text x="${ox + gSize/2}" y="${oy + gSize + 10}" text-anchor="middle" font-family="monospace" font-size="10" fill="#aaa">${safeLabel}</text>`);
  });

  parts.push('</svg>');
  triggerDownload(new Blob([parts.join('')], { type: 'image/svg+xml' }), 'myfont.svg');
}

// ─── EXPORT OTF ───────────────────────────────────────────────────────────────
document.getElementById('btn-export-otf').addEventListener('click', exportOTF);

function exportOTF() {
  if (typeof opentype === 'undefined') { alert('opentype.js not loaded.'); return; }

  const UPM = 1000;
  const U = 20;  // grid units per font unit: 50 cols × 20 = 1000

  // Font y coords: row r top-edge → y_font = (BASELINE_ROW - r) * U
  // Row 37 (baseline row) top-edge → y = (37-37)*20 = 0 → baseline at y=0 ✓
  // Row 7 (cap-height)  top-edge → y = (37-7)*20 = 600 ✓
  // Row 38 top-edge (one below baseline) → y = (37-38)*20 = -20
  const rowTopY = r => (BASELINE_ROW - r) * U;

  const ADVANCE = 55 * U; // 1100

  function glyphRects(ch) {
    const g = glyphs[ch];
    if (!g) return [];
    const rects = [];
    // horizontal-run merge per row
    for (let r = 0; r < ROWS; r++) {
      let c = 0;
      while (c < COLS) {
        if (getCell(g, c, r)) {
          let end = c + 1;
          while (end < COLS && getCell(g, end, r)) end++;
          rects.push({ c, r, w: end - c, h: 1 });
          c = end;
        } else c++;
      }
    }
    // vertical merge of same-column same-width adjacent rows
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < rects.length; i++) {
        if (rects[i].merged) continue;
        for (let j = i + 1; j < rects.length; j++) {
          if (rects[j].merged) continue;
          if (rects[j].c === rects[i].c && rects[j].w === rects[i].w &&
              rects[j].r === rects[i].r + rects[i].h) {
            rects[i].h += rects[j].h;
            rects[j].merged = true;
            changed = true;
          }
        }
      }
    }
    return rects.filter(r => !r.merged);
  }

  function buildPath(ch) {
    const rects = glyphRects(ch);
    if (rects.length === 0) return null;
    const path = new opentype.Path();
    rects.forEach(({ c, r, w, h }) => {
      const x1 = c * U;
      const x2 = (c + w) * U;
      // top-edge of first row → highest y; bottom-edge of last row = top-edge of row r+h
      const yTop = rowTopY(r);
      const yBot = rowTopY(r + h);
      // Counter-clockwise for CFF outer contour (y increases upward)
      path.moveTo(x1, yBot);
      path.lineTo(x1, yTop);
      path.lineTo(x2, yTop);
      path.lineTo(x2, yBot);
      path.close();
    });
    return path;
  }

  const GLYPH_NAMES = {
    '!':'exclam','?':'question','.':'period',',':'comma',':':'colon',
    ';':'semicolon','@':'at','#':'numbersign','$':'dollar','%':'percent',
    '&':'ampersand','*':'asterisk','(':'parenleft',')':'parenright',
    '-':'hyphen','_':'underscore','+':'plus','=':'equal','[':'bracketleft',
    ']':'bracketright','/':'slash','\\':'backslash',' ':'space'
  };
  function gName(ch) {
    if (GLYPH_NAMES[ch]) return GLYPH_NAMES[ch];
    return ch;
  }

  // .notdef — simple rectangle outline
  const notdefPath = new opentype.Path();
  notdefPath.moveTo(50, -200);
  notdefPath.lineTo(50, 700);
  notdefPath.lineTo(650, 700);
  notdefPath.lineTo(650, -200);
  notdefPath.close();
  notdefPath.moveTo(100, -150);
  notdefPath.lineTo(600, -150);
  notdefPath.lineTo(600, 650);
  notdefPath.lineTo(100, 650);
  notdefPath.close();

  const glyphObjs = [
    new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: ADVANCE, path: notdefPath }),
    new opentype.Glyph({ name: 'space',   unicode: 32, advanceWidth: ADVANCE, path: new opentype.Path() }),
  ];

  SUPPORTED_CHARS.forEach(ch => {
    if (ch === ' ') return;
    if (isGlyphEmpty(ch)) return;
    const path = buildPath(ch);
    if (!path) return;
    glyphObjs.push(new opentype.Glyph({
      name: gName(ch),
      unicode: ch.codePointAt(0),
      advanceWidth: ADVANCE,
      path,
    }));
  });

  try {
    const font = new opentype.Font({
      familyName: 'MyFont',
      styleName: 'Regular',
      unitsPerEm: UPM,
      ascender: rowTopY(CAPHEIGHT_ROW),   // 600
      descender: rowTopY(ROWS),            // (37-50)*20 = -260
      glyphs: glyphObjs,
    });
    font.download('myfont.otf');
  } catch (err) {
    alert('Export error: ' + err.message);
    console.error(err);
  }
}

// ─── DOWNLOAD HELPER ──────────────────────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

// ─── POPULAR FONTS ────────────────────────────────────────────────────────────
const POPULAR_FONTS = [
  // System
  { name: 'Arial',           family: 'Arial',            cat: 'System', type: 'system' },
  { name: 'Arial Black',     family: 'Arial Black',       cat: 'System', type: 'system' },
  { name: 'Comic Sans MS',   family: 'Comic Sans MS',     cat: 'System', type: 'system' },
  { name: 'Times New Roman', family: 'Times New Roman',   cat: 'System', type: 'system' },
  { name: 'Georgia',         family: 'Georgia',            cat: 'System', type: 'system' },
  { name: 'Verdana',         family: 'Verdana',            cat: 'System', type: 'system' },
  { name: 'Impact',          family: 'Impact',             cat: 'System', type: 'system' },
  { name: 'Trebuchet MS',    family: 'Trebuchet MS',       cat: 'System', type: 'system' },
  { name: 'Tahoma',          family: 'Tahoma',             cat: 'System', type: 'system' },
  { name: 'Palatino',        family: 'Palatino Linotype',  cat: 'System', type: 'system' },
  // Sans-serif Google
  { name: 'Roboto',          family: 'Roboto',             cat: 'Sans',    type: 'google' },
  { name: 'Open Sans',       family: 'Open Sans',          cat: 'Sans',    type: 'google' },
  { name: 'Lato',            family: 'Lato',               cat: 'Sans',    type: 'google' },
  { name: 'Montserrat',      family: 'Montserrat',         cat: 'Sans',    type: 'google' },
  { name: 'Poppins',         family: 'Poppins',            cat: 'Sans',    type: 'google' },
  { name: 'Oswald',          family: 'Oswald',             cat: 'Sans',    type: 'google' },
  { name: 'Raleway',         family: 'Raleway',            cat: 'Sans',    type: 'google' },
  { name: 'Bebas Neue',      family: 'Bebas Neue',         cat: 'Sans',    type: 'google' },
  { name: 'Nunito',          family: 'Nunito',             cat: 'Sans',    type: 'google' },
  { name: 'Ubuntu',          family: 'Ubuntu',             cat: 'Sans',    type: 'google' },
  // Serif Google
  { name: 'Playfair Display',family: 'Playfair Display',   cat: 'Serif',   type: 'google' },
  { name: 'Merriweather',    family: 'Merriweather',       cat: 'Serif',   type: 'google' },
  { name: 'Lora',            family: 'Lora',               cat: 'Serif',   type: 'google' },
  { name: 'PT Serif',        family: 'PT Serif',           cat: 'Serif',   type: 'google' },
  { name: 'Crimson Text',    family: 'Crimson Text',       cat: 'Serif',   type: 'google' },
  // Display / Handwriting Google
  { name: 'Pacifico',        family: 'Pacifico',           cat: 'Display', type: 'google' },
  { name: 'Dancing Script',  family: 'Dancing Script',     cat: 'Display', type: 'google' },
  { name: 'Lobster',         family: 'Lobster',            cat: 'Display', type: 'google' },
  { name: 'Righteous',       family: 'Righteous',          cat: 'Display', type: 'google' },
  { name: 'Permanent Marker',family: 'Permanent Marker',   cat: 'Display', type: 'google' },
  { name: 'Caveat',          family: 'Caveat',             cat: 'Display', type: 'google' },
  // Mono Google
  { name: 'Roboto Mono',     family: 'Roboto Mono',        cat: 'Mono',    type: 'google' },
  { name: 'Source Code Pro', family: 'Source Code Pro',    cat: 'Mono',    type: 'google' },
  { name: 'JetBrains Mono',  family: 'JetBrains Mono',    cat: 'Mono',    type: 'google' },
  { name: 'Press Start 2P',  family: 'Press Start 2P',     cat: 'Mono',    type: 'google' },
  { name: 'Space Mono',      family: 'Space Mono',         cat: 'Mono',    type: 'google' },
  { name: 'Courier New',     family: 'Courier New',        cat: 'Mono',    type: 'system' },
];

// ─── MODAL STATE ──────────────────────────────────────────────────────────────
let selectedFontEntry = null;
let activeTab = 'All';
let googleFontsLoaded = false;

const fontModal    = document.getElementById('font-modal');
const fontModalGrid = document.getElementById('font-modal-grid');
const fontSearch   = document.getElementById('font-search');
const modalSelLabel = document.getElementById('modal-selected-label');
const btnModalImport = document.getElementById('btn-modal-import');

document.getElementById('btn-popular').addEventListener('click', openFontModal);
document.getElementById('modal-close').addEventListener('click', closeFontModal);
document.getElementById('btn-modal-cancel').addEventListener('click', closeFontModal);
fontModal.addEventListener('click', e => { if (e.target === fontModal) closeFontModal(); });

function openFontModal() {
  selectedFontEntry = null;
  updateModalFooter();
  fontSearch.value = '';
  activeTab = 'All';
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === 'All'));
  fontModal.classList.remove('hidden');
  injectGoogleFontsCss();
  renderFontGrid();
  fontSearch.focus();
}

function closeFontModal() {
  fontModal.classList.add('hidden');
}

function injectGoogleFontsCss() {
  if (googleFontsLoaded) return;
  googleFontsLoaded = true;
  const families = POPULAR_FONTS
    .filter(f => f.type === 'google')
    .map(f => f.family.replace(/ /g, '+'))
    .join('&family=');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${families}&display=swap`;
  document.head.appendChild(link);
}

// Tab switching
document.getElementById('modal-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.modal-tab');
  if (!tab) return;
  activeTab = tab.dataset.cat;
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === activeTab));
  renderFontGrid();
});

fontSearch.addEventListener('input', renderFontGrid);

function renderFontGrid() {
  const query = fontSearch.value.trim().toLowerCase();
  const filtered = POPULAR_FONTS.filter(f => {
    const matchCat = activeTab === 'All' || f.cat === activeTab;
    const matchQ   = !query || f.name.toLowerCase().includes(query) || f.family.toLowerCase().includes(query);
    return matchCat && matchQ;
  });

  fontModalGrid.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'font-modal-empty';
    empty.textContent = 'No fonts match your search.';
    fontModalGrid.appendChild(empty);
    return;
  }

  filtered.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'font-modal-card' + (selectedFontEntry === entry ? ' selected' : '');

    const tagClass = entry.type === 'google' ? 'fmc-tag-google' : 'fmc-tag-system';
    const tagLabel = entry.type === 'google' ? 'Google' : 'System';

    card.innerHTML = `
      <div class="fmc-check"><svg viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" fill="none" stroke="white" stroke-width="2.5"/></svg></div>
      <div class="fmc-preview" style="font-family:'${entry.family}',serif">Aa</div>
      <div class="fmc-name" title="${entry.name}">${entry.name}</div>
      <span class="fmc-tag ${tagClass}">${tagLabel}</span>
    `;

    card.addEventListener('click', () => {
      selectedFontEntry = entry;
      fontModalGrid.querySelectorAll('.font-modal-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      updateModalFooter();
    });

    fontModalGrid.appendChild(card);
  });
}

function updateModalFooter() {
  if (selectedFontEntry) {
    modalSelLabel.textContent = `Selected: ${selectedFontEntry.name}`;
    modalSelLabel.classList.add('has-selection');
    btnModalImport.disabled = false;
  } else {
    modalSelLabel.textContent = 'No font selected';
    modalSelLabel.classList.remove('has-selection');
    btnModalImport.disabled = true;
  }
}

btnModalImport.addEventListener('click', async () => {
  if (!selectedFontEntry) return;
  closeFontModal();

  const entry = selectedFontEntry;
  loadingMsg.textContent = `Loading "${entry.name}"…`;
  loadingOverlay.classList.remove('hidden');

  try {
    if (entry.type === 'google') {
      await ensureFontLoaded(entry.family);
    }
    await rasterizeFontToGlyphs(entry.family);
    renderCanvas();
    renderPreviews();
    refreshAllCards();
    saveToStorage();
  } catch (err) {
    alert(`Failed to import "${entry.name}": ${err.message}`);
    console.error(err);
  } finally {
    loadingOverlay.classList.add('hidden');
  }
});

async function ensureFontLoaded(family) {
  // Inject link if somehow not present
  if (!document.querySelector(`link[href*="${family.replace(/ /g,'+')}"]`)) {
    injectGoogleFontsCss();
  }
  // document.fonts.load waits until the font is usable in canvas
  await document.fonts.load(`700px "${family}"`, 'AaBbGgXx');
}

async function rasterizeFontToGlyphs(fontFamily) {
  const off = document.createElement('canvas');
  off.width = 500;
  off.height = 500;
  const c = off.getContext('2d');

  // Baseline at pixel y = 380 (row 37 bottom edge)
  const BASE_Y    = (BASELINE_ROW + 1) * CELL;  // 380
  // Target cap height at pixel y = 70 (row 7 top edge), so 310px of ascender room.
  // CSS font-size in canvas: for most fonts cap-height ≈ 0.72 × em.
  // We want cap-height pixels = 310 → em = 310 / 0.72 ≈ 430.
  const FONT_SIZE = 430;

  let done = 0;
  for (const ch of SUPPORTED_CHARS) {
    if (ch === ' ') continue;
    loadingMsg.textContent = `Rasterizing "${ch}"… (${++done}/${SUPPORTED_CHARS.length - 1})`;

    c.clearRect(0, 0, 500, 500);
    c.fillStyle = '#000000';
    c.font = `${FONT_SIZE}px "${fontFamily}", serif`;
    c.textBaseline = 'alphabetic';

    const w = c.measureText(ch).width;
    const x = Math.max(2, (500 - w) / 2);
    c.fillText(ch, x, BASE_Y);

    const data = c.getImageData(0, 0, 500, 500).data;
    const g = emptyGlyph();
    let anyFilled = false;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        let dark = 0;
        for (let dy = 0; dy < CELL; dy++) {
          for (let dx = 0; dx < CELL; dx++) {
            const idx = ((row * CELL + dy) * 500 + (col * CELL + dx)) * 4;
            if (data[idx + 3] > 80) dark++;
          }
        }
        if (dark >= CELL * CELL * 0.28) {
          setCell(g, col, row, 1);
          anyFilled = true;
        }
      }
    }

    if (anyFilled) glyphs[ch] = g;
    await new Promise(r => setTimeout(r, 0));
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
loadFromStorage();
buildCharGrid();
renderCanvas();
renderPreviews();
applyZoom(1);
