// Can / bottle artwork. A drink with a label image (data/labels, set in the catalog)
// wears its real label on the drawn can or bottle. Every other drink gets a generated
// label: colors come from a hash of the brand and the style's liquid color, so each
// one is stable and distinct.
import { esc, hash } from './util.js';
import { liquidColor } from './taxonomy.js';

// [label color, ink color]
const PALETTE = [
  ['#1f4e3d', '#f4ebd0'], ['#0f3b5f', '#f2e6c9'], ['#7a1f2b', '#f7e7d3'], ['#c8553d', '#fff3e6'],
  ['#e0a526', '#2a1f0b'], ['#2b2d42', '#edf2f4'], ['#3d7ea6', '#f7fbff'], ['#5b3a6e', '#f5e9ff'],
  ['#eadfc8', '#2c2a26'], ['#1e7f74', '#effffb'], ['#d96c1e', '#fff4e8'], ['#141414', '#f5c542'],
  ['#b23a48', '#fff0f0'], ['#6b8f3e', '#f6fbea'], ['#f2f0eb', '#1b4d89'], ['#24453f', '#f6c453'],
];

let counter = 0;

export function containerFor(item) {
  const size = String(item.size || '').toLowerCase();
  if (item.type === 'Wine') return /\bcan\b/.test(size) ? 'slim' : 'wine';
  if (item.type === 'Spirits') return 'spirit';
  if (item.type === 'Water') return /\bcan\b/.test(size) ? 'tall' : 'water';
  if (/bottle/.test(size)) return 'bottle';
  if (/\b(16|19\.2|24|25)\s*(fl)?\s*oz/.test(size) || /\b(473|500|568|710)\s*ml/.test(size)) return 'tall';
  if (item.type === 'Ready-to-Drink' || item.type === 'Carbonated') return 'slim';
  return 'can';
}

function monogram(brand = '') {
  const words = brand.replace(/[^A-Za-z0-9\s&]/g, ' ').split(/\s+/).filter(word => word && !/^(the|co|company|brewing|brewery|&)$/i.test(word));
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

/** Wrap `text` into 1-3 lines and pick the largest font size that fits the box. */
function fitText(text, width, height, maxSize, charWidth = 0.52) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], size: maxSize };
  let best = null;
  for (let count = 1; count <= Math.min(3, words.length); count += 1) {
    const target = words.join(' ').length / count;
    const lines = [];
    let current = '';
    words.forEach(word => {
      const next = current ? `${current} ${word}` : word;
      if (current && next.length > target * 1.15 && lines.length < count - 1) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    });
    lines.push(current);
    const longest = Math.max(...lines.map(line => line.length));
    const size = Math.min(maxSize, width / (longest * charWidth), height / (lines.length * 1.04));
    if (!best || size > best.size * 1.12) best = { lines, size };
  }
  return best;
}

function textBlock({ lines, size }, centerY, color, family, weight = 800, spacing = 0) {
  const lineHeight = size * 1.02;
  const top = centerY - ((lines.length - 1) * lineHeight) / 2;
  return lines.map((line, index) =>
    `<text x="50" y="${(top + index * lineHeight).toFixed(1)}" fill="${color}" font-family="${family}" font-weight="${weight}" font-size="${size.toFixed(1)}" letter-spacing="${spacing}" text-anchor="middle" dominant-baseline="central">${esc(line)}</text>`
  ).join('');
}

const CONDENSED = "'Avenir Next Condensed','Roboto Condensed','Arial Narrow',ui-sans-serif,sans-serif";
const SERIF = "ui-serif,'New York','Iowan Old Style',Georgia,serif";

const SHAPES = {
  can: { body: 'M22,49 L78,49 Q80,49 80.6,51 L82,59 L82,164 L79,172 Q78.4,174 76,174 L24,174 Q21.6,174 21,172 L18,164 L18,59 L19.4,51 Q20,49 22,49 Z', lid: [50, 49, 28], label: { x: 18, y: 59, w: 64, h: 105 }, rims: [[49, 59], [164, 174]] },
  tall: { body: 'M22,14 L78,14 Q80,14 80.6,16 L82,24 L82,164 L79,172 Q78.4,174 76,174 L24,174 Q21.6,174 21,172 L18,164 L18,24 L19.4,16 Q20,14 22,14 Z', lid: [50, 14, 28], label: { x: 18, y: 24, w: 64, h: 140 }, rims: [[14, 24], [164, 174]] },
  slim: { body: 'M31,20 L69,20 Q71,20 71.4,22 L72,30 L72,166 L70,172 Q69.4,174 67,174 L33,174 Q30.6,174 30,172 L28,166 L28,30 L28.6,22 Q29,20 31,20 Z', lid: [50, 20, 19], label: { x: 28, y: 30, w: 44, h: 136 }, rims: [[20, 30], [166, 174]] },
  bottle: { body: 'M41,12 L59,12 L60,56 Q61,67 67,74 Q74,81 74,92 L74,166 Q74,174 66,174 L34,174 Q26,174 26,166 L26,92 Q26,81 33,74 Q39,67 40,56 Z', cap: { x: 39.5, y: 6, w: 21, h: 9 }, label: { x: 26, y: 100, w: 48, h: 56 }, zone: [93, 169], glass: true },
  wine: { body: 'M44,8 L56,8 L56,52 Q56,64 66,72 Q73,78 73,92 L73,168 Q73,174 67,174 L33,174 Q27,174 27,168 L27,92 Q27,78 34,72 Q44,64 44,52 Z', capsule: { x: 43.5, y: 6, w: 13, h: 34 }, label: { x: 30, y: 108, w: 40, h: 50 }, zone: [94, 168], glass: true },
  water: { body: 'M44,18 L56,18 L56,28 Q56,34 64,40 Q72,46 72,58 L72,166 Q72,174 64,174 L36,174 Q28,174 28,166 L28,58 Q28,46 36,40 Q44,34 44,28 Z', cap: { x: 42, y: 8, w: 16, h: 11 }, label: { x: 28, y: 92, w: 44, h: 44 }, glass: true },
  spirit: { body: 'M45,10 L55,10 L55,40 Q55,50 66,56 Q76,62 76,74 L76,164 Q76,174 66,174 L34,174 Q24,174 24,164 L24,74 Q24,62 34,56 Q45,50 45,40 Z', cap: { x: 43, y: 4, w: 14, h: 12 }, label: { x: 27, y: 92, w: 46, h: 66 }, glass: true },
};

function glassColor(item) {
  if (item.type === 'Wine') {
    if (/Rosé/.test(item.style || '')) return '#e9a9a1';
    if (/Sparkling|Prosecco|Champagne/.test(item.style || '')) return '#1f3324';
    return /White|Chardonnay|Sauvignon|Grigio|Riesling|Moscato/.test(item.style || '') ? '#3b4a2c' : '#1d2620';
  }
  if (item.type === 'Water') return '#d8edf8';
  if (item.type === 'Spirits') return '#e9ecea';
  return /Pilsner|Lager|Light/.test(item.style || '') ? '#2f5a33' : '#5b3411';
}

/** Size of each can's printed area, so label crops can be cut to fit exactly. */
export const LABEL_BOX = Object.fromEntries(Object.entries(SHAPES).map(([name, shape]) => [name, { w: shape.label.w, h: shape.label.h }]));

/**
 * `image` is a real label: { src, ar?, w?, flat?, cap?, band? }.
 *   ar   width / height of the picture (bottles; cans are cropped to the printed area)
 *   w    share of the bottle's width the label covers (default 1, a wrap-around label)
 *   flat true for flat artwork, false for a crop of a product photo (already lit)
 *   cap  bottle cap color
 *   band true (or an ink color) to set the beer's name under a logo-only picture
 */
export function artSVG(item, { label: ariaLabel, image = null } = {}) {
  const photo = image?.src ? image : null;
  const id = `a${(counter += 1)}`;
  const brand = item.brand || '';
  const seed = hash(`${brand}|${brand ? '' : item.name}`);
  const [labelColor, ink] = PALETTE[seed % PALETTE.length];
  const accent = liquidColor(item);
  const container = containerFor(item);
  const shape = SHAPES[container];
  const box = shape.label;
  const pattern = (seed >>> 5) % 5;
  const styleText = [item.style, item.abv != null && item.abv !== '' ? `${Number(item.abv).toFixed(1).replace(/\.0$/, '')}%` : ''].filter(Boolean).join(' · ');
  const name = item.name || 'New drink';
  const isGlass = Boolean(shape.glass);
  const labelFill = isGlass ? (item.type === 'Wine' ? '#f3ecdc' : labelColor) : labelColor;
  const labelInk = isGlass && item.type === 'Wine' ? '#2a211a' : ink;

  // A photographed label already carries the studio lighting, so it gets a lighter touch.
  const shade = !photo ? { left: 0.28, shine: 0.38, right: 0.34 } : photo.flat ? { left: 0.3, shine: 0.3, right: 0.36 } : { left: 0.2, shine: 0.1, right: 0.26 };

  const defs = `<defs>
    <linearGradient id="${id}m" x1="0" x2="1"><stop offset="0" stop-color="#7d838a"/><stop offset=".22" stop-color="#eef1f3"/><stop offset=".5" stop-color="#b9bfc5"/><stop offset=".78" stop-color="#e6e9ec"/><stop offset="1" stop-color="#6b7178"/></linearGradient>
    <linearGradient id="${id}s" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="${shade.left}"/><stop offset=".14" stop-color="#fff" stop-opacity=".0"/><stop offset=".26" stop-color="#fff" stop-opacity="${shade.shine}"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/><stop offset=".72" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${shade.right}"/></linearGradient>
    <clipPath id="${id}c"><path d="${shape.body}"/></clipPath>
  </defs>`;

  // Label decoration behind the text.
  let decoration = '';
  const { x, y, w, h } = box;
  if (pattern === 0) decoration = `<circle cx="50" cy="${y + h * 0.3}" r="${Math.min(w, h) * 0.26}" fill="${accent}" opacity=".95"/><circle cx="50" cy="${y + h * 0.3}" r="${Math.min(w, h) * 0.26 - 2.4}" fill="none" stroke="${labelColor}" stroke-width="1.2" opacity=".7"/>`;
  if (pattern === 1) decoration = `<rect x="${x}" y="${y + h * 0.64}" width="${w}" height="${h * 0.2}" fill="${accent}" opacity=".9"/><rect x="${x}" y="${y + h * 0.6}" width="${w}" height="1.4" fill="${accent}" opacity=".9"/>`;
  if (pattern === 2) decoration = `<path d="M${x},${y + h * 0.98} L${x + w},${y + h * 0.66} L${x + w},${y + h * 0.78} L${x},${y + h * 1.1} Z" fill="${accent}" opacity=".9"/>`;
  if (pattern === 3) decoration = `<path d="M${x},${y + h * 0.72} C${x + w * 0.3},${y + h * 0.65} ${x + w * 0.6},${y + h * 0.8} ${x + w},${y + h * 0.7} L${x + w},${y + h} L${x},${y + h} Z" fill="${accent}" opacity=".85"/>`;
  if (pattern === 4) decoration = `<path d="M${x},${y + h * 0.9} L${x + w * 0.28},${y + h * 0.7} L${x + w * 0.45},${y + h * 0.8} L${x + w * 0.66},${y + h * 0.66} L${x + w},${y + h * 0.86} L${x + w},${y + h} L${x},${y + h} Z" fill="${accent}" opacity=".9"/>`;

  const padding = container === 'slim' ? 4 : 6;
  const textWidth = w - padding * 2;
  let content = '';
  let extraDefs = '';
  if (photo && isGlass) {
    // Bottle: the label sits on the straight part of the body, as wide as the picture allows.
    const [zoneTop, zoneBottom] = shape.zone || [y - 4, y + h + 8];
    const share = Math.min(1, Math.max(0.4, Number(photo.w) || 1));
    const labelW = w * share;
    const labelH = Math.min(zoneBottom - zoneTop, labelW / (Number(photo.ar) || 1));
    const labelX = 50 - labelW / 2;
    const labelY = (zoneTop + zoneBottom) / 2 - labelH / 2;
    extraDefs = `<clipPath id="${id}l"><rect x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" width="${labelW.toFixed(2)}" height="${labelH.toFixed(2)}" rx="${share < 1 ? 2.2 : 0}"/></clipPath>`;
    content = `<image href="${esc(photo.src)}" x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" width="${labelW.toFixed(2)}" height="${labelH.toFixed(2)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}l)"/>`;
  } else if (photo) {
    // Can: the label covers the whole printed area between the rims.
    content = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#d5d9dd"/>
      <image href="${esc(photo.src)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>
      <rect x="${x}" y="${y}" width="${w}" height="1" fill="#000" opacity=".22"/><rect x="${x}" y="${y + h - 1}" width="${w}" height="1" fill="#000" opacity=".26"/>`;
    if (photo.band) {
      // The picture is only the brewery's mark (a plain can with a logo): set the beer's name under it.
      const bandInk = typeof photo.band === 'string' ? photo.band : '#f4efe6';
      const nameFit = fitText(name.toUpperCase(), w - 10, h * 0.17, 10.5);
      const nameY = y + h * 0.69;
      content += `<rect x="${x + w * 0.3}" y="${(nameY - (nameFit.lines.length * nameFit.size) / 2 - 5).toFixed(1)}" width="${w * 0.4}" height=".7" fill="${bandInk}" opacity=".55"/>
        ${textBlock(nameFit, nameY, bandInk, CONDENSED, 800, 0.5)}
        ${textBlock(fitText(styleText, w - 14, 5.4, 5.4, 0.56), nameY + (nameFit.lines.length * nameFit.size) / 2 + 6.5, bandInk, CONDENSED, 600, 0.4)}`;
    }
  } else if (isGlass) {
    // Bottle label: brand, name, style — compact.
    const nameFit = fitText(name, textWidth, h * 0.46, 13);
    content = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${labelFill}"/>
      ${item.type === 'Wine' ? `<rect x="${x + 2.5}" y="${y + 2.5}" width="${w - 5}" height="${h - 5}" rx="2" fill="none" stroke="${accent}" stroke-width=".8"/>` : decoration}
      ${textBlock(fitText(brand.toUpperCase(), textWidth, 6, 6, 0.66), y + 8, labelInk, CONDENSED, 700, 0.8)}
      ${textBlock(nameFit, y + h * 0.5, labelInk, item.type === 'Wine' ? SERIF : CONDENSED, item.type === 'Wine' ? 700 : 800)}
      ${textBlock(fitText(styleText, textWidth, 5.5, 5.5, 0.56), y + h - 7, labelInk, CONDENSED, 600, 0.3)}`;
  } else {
    const nameCenter = pattern === 0 ? y + h * 0.66 : y + h * 0.4;
    const nameFit = fitText(name, textWidth, h * (pattern === 0 ? 0.3 : 0.38), container === 'slim' ? 14 : 17);
    content = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${labelFill}"/>${decoration}
      ${pattern === 0 ? textBlock(fitText(monogram(brand || name), Math.min(w, h) * 0.34, 14, 14, 0.62), y + h * 0.3, labelColor, SERIF, 800) : ''}
      ${textBlock(fitText(brand.toUpperCase(), textWidth, 7, 7, 0.66), y + 9, ink, CONDENSED, 700, 0.9)}
      ${textBlock(nameFit, nameCenter, ink, CONDENSED, 800)}
      <rect x="${x}" y="${y + h - 15}" width="${w}" height="15" fill="${ink}" opacity=".92"/>
      ${textBlock(fitText(styleText, textWidth, 6.5, 6.5, 0.56), y + h - 7.5, labelColor, CONDENSED, 700, 0.3)}`;
  }

  let hardware = '';
  if (shape.lid) {
    const [cx, cy, rx] = shape.lid;
    hardware += shape.rims.map(([top, bottom]) => `<rect x="0" y="${top}" width="100" height="${bottom - top}" fill="url(#${id}m)" clip-path="url(#${id}c)"/>`).join('');
    hardware += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="3.4" fill="#d9dde1" stroke="#8d939a" stroke-width=".8"/><ellipse cx="${cx}" cy="${cy}" rx="${rx * 0.38}" ry="1.6" fill="#b5bbc1"/>`;
  }
  if (shape.cap) {
    const { x: cx, y: cy, w: cw, h: ch } = shape.cap;
    const capColor = photo?.cap || (item.type === 'Water' ? '#2f7fc1' : accent);
    hardware += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="2" fill="${capColor}"/><rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="2" fill="url(#${id}s)"/>`;
  }
  if (shape.capsule) {
    const { x: cx, y: cy, w: cw, h: ch } = shape.capsule;
    const foil = /Sparkling|Prosecco|Champagne/.test(item.style || '') ? '#d9b45a' : labelColor;
    hardware += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="2.5" fill="${foil}"/><rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="2.5" fill="url(#${id}s)"/>`;
  }

  const bodyFill = isGlass ? glassColor(item) : photo ? '#c9ced3' : labelColor;
  const glassOpacity = item.type === 'Water' ? 0.75 : 1;
  const aria = ariaLabel ? `role="img" aria-label="${esc(ariaLabel)}"` : 'aria-hidden="true"';
  return `<svg class="art art-${container}${photo ? ' art-real' : ''}" viewBox="0 0 100 180" ${aria} focusable="false">${defs}${extraDefs ? `<defs>${extraDefs}</defs>` : ''}
    <ellipse cx="50" cy="175" rx="${container === 'slim' ? 22 : 30}" ry="3.2" fill="#000" opacity=".18"/>
    <g clip-path="url(#${id}c)"><path d="${shape.body}" fill="${bodyFill}" opacity="${glassOpacity}"/>${content}<rect x="0" y="0" width="100" height="180" fill="url(#${id}s)"/></g>
    ${hardware}
  </svg>`;
}
