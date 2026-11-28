// Guest menu sharing: a compact, compressed snapshot of the menu encoded in the
// link itself, so a guest's phone can show what's in the fridge without a server.
import { TYPES } from './taxonomy.js';

const QR_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.mjs';
const MAX_URL = 1400;
let qrModule;

export async function qrSvg(text) {
  qrModule ||= import(QR_URL).then(module => module.default);
  const qrcode = await qrModule;
  const qr = qrcode(0, text.length > 500 ? 'L' : 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
  }
  return `<svg viewBox="-3 -3 ${count + 6} ${count + 6}" shape-rendering="crispEdges" role="img" aria-label="QR code for the fridge menu"><rect x="-3" y="-3" width="${count + 6}" height="${count + 6}" fill="#fff"/><path d="${path}" fill="#111"/></svg>`;
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function deflate(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

async function encodePayload(payload) {
  const json = JSON.stringify(payload);
  if ('CompressionStream' in globalThis) {
    try {
      return `z${toBase64Url(await deflate(json))}`;
    } catch { /* fall back to plain */ }
  }
  return `j${toBase64Url(new TextEncoder().encode(json))}`;
}

function rows(items, { brand = true, rating = true } = {}) {
  return items.map(item => {
    const row = [item.name, brand ? item.brand || '' : '', Math.max(0, TYPES.indexOf(item.type)), item.style || '', item.abv ?? '', item.count];
    if (rating) row.push(item.ratingCount ? Math.round((item.ratingTotal / item.ratingCount) * 10) : 0);
    return row;
  });
}

/** Build the shareable menu URL, trimming detail until it fits a scannable QR code. */
export async function snapshotUrl(baseUrl, fridgeName, items) {
  const sorted = [...items].sort((a, b) => b.count - a.count);
  const attempts = [
    { list: sorted, brand: true, rating: true },
    { list: sorted, brand: true, rating: false },
    { list: sorted, brand: false, rating: false },
  ];
  for (let size = sorted.length - 4; size >= 6; size -= 4) attempts.push({ list: sorted.slice(0, size), brand: false, rating: false });
  let url = baseUrl;
  for (const attempt of attempts) {
    const token = await encodePayload({ v: 1, n: fridgeName, t: Math.round(Date.now() / 60000), i: rows(attempt.list, attempt) });
    url = `${baseUrl}?s=${token}`;
    if (url.length <= MAX_URL) return { url, included: attempt.list.length, total: items.length };
  }
  return { url, included: 0, total: items.length };
}

async function decodePayload(token) {
  const kind = token[0];
  const bytes = fromBase64Url(token.slice(1));
  const json = kind === 'z' ? await inflate(bytes) : new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// Fridge lists: a batch of drinks to stock, packed into a link. The list sits after
// the "#", so it is never sent to the server that hosts the app.

/** `lines` is [{ id: catalogId, count }] or [{ item: { name, brand, type, style, abv, size }, count }]. */
export async function stockLink(baseUrl, title, lines) {
  const token = await encodePayload({ v: 1, n: title, t: Math.round(Date.now() / 60000), i: lines.map(line => [line.id || line.item, line.count]) });
  return `${baseUrl}#stock?l=${token}`;
}

/** Pull the list token out of a pasted link (or accept a bare token). */
export function stockToken(text) {
  const value = String(text || '').trim();
  const fromLink = value.match(/[#?&]l=([A-Za-z0-9_-]{8,})/);
  if (fromLink) return fromLink[1];
  return /^[zj][A-Za-z0-9_-]{8,}$/.test(value) ? value : '';
}

export async function decodeStock(token) {
  const payload = await decodePayload(token);
  if (!Array.isArray(payload.i)) throw new Error('Not a fridge list');
  return {
    title: payload.n || 'Fridge list',
    at: new Date((payload.t || 0) * 60000).toISOString(),
    lines: payload.i
      .map(row => ({ id: typeof row[0] === 'string' ? row[0] : '', item: row[0] && typeof row[0] === 'object' ? row[0] : null, count: Math.max(0, Math.round(Number(row[1]) || 0)) }))
      .filter(line => (line.id || line.item) && line.count > 0),
  };
}

export async function decodeSnapshot(token) {
  const payload = await decodePayload(token);
  return {
    name: payload.n || 'The fridge',
    at: new Date((payload.t || 0) * 60000).toISOString(),
    items: (payload.i || []).map((row, index) => ({
      id: `snap-${index}`,
      name: row[0],
      brand: row[1] || '',
      type: TYPES[row[2]] || 'Other',
      style: row[3] || '',
      abv: row[4] === '' ? null : row[4],
      count: row[5] || 0,
      ratingTotal: row[6] ? row[6] / 10 : 0,
      ratingCount: row[6] ? 1 : 0,
      snapshot: true,
    })),
  };
}
