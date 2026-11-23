// Offline beverage catalog: load, index, search, fuzzy-match scanned products.
import { fold, haversineMiles, slug, tokens } from './util.js';
import { familyOf, normalizeStyle } from './taxonomy.js';

const catalog = { ready: false, items: [], byId: new Map(), makers: [], makerById: new Map(), version: '', promise: null };

const CORPORATE = /anheuser|molson|coors brewing|pabst|constellation|heineken usa|diageo|boston beer|grupo|ab inbev|coca cola company|pepsico|keurig|kdp|e and j gallo|treasury wine/;
const MATCH_STOP = new Set(['the', 'and', 'of', 'co', 'company', 'brewing', 'brewery', 'brewers', 'inc', 'llc', 'can', 'cans', 'bottle', 'bottles', 'pack', 'pk', 'case', 'ct', 'count', 'fl', 'oz', 'ml', 'cl', 'l', 'x', 'beer', 'by', 'with', 'a']);
const MAKER_STOP = /\b(brewing|brewery|breweries|brewers|brewhouse|brew|company|co|beer|beers|ales|works|craft|the|and|llc|inc|ltd|taproom|pub|project|cellars|winery|vineyards|cidery)\b/g;

export function makerKey(name = '') {
  return fold(name).replace(MAKER_STOP, ' ').replace(/\s+/g, ' ').trim();
}

export function loadCatalog() {
  if (!catalog.promise) {
    catalog.promise = fetch('./data/beverages.json')
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(build)
      .catch(error => {
        console.warn('Beverage catalog unavailable', error);
        catalog.ready = true;
        return catalog;
      });
  }
  return catalog.promise;
}

function build(data) {
  catalog.items = [];
  catalog.byId.clear();
  catalog.makerById.clear();
  catalog.makers = (data.makers || []).map(maker => ({ ...maker, key: makerKey(maker.name), brandKey: makerKey(maker.brand || '') }));
  for (const maker of catalog.makers) {
    catalog.makerById.set(maker.id, maker);
    for (const raw of maker.items || []) {
      const entry = Array.isArray(raw) ? { name: raw[0], style: raw[1], abv: raw[2], pop: raw[3], season: raw[4] } : raw;
      if (!entry?.name) continue;
      const brand = maker.brand || maker.name;
      const item = {
        id: `${maker.id}/${slug(entry.name)}`,
        name: entry.name,
        brand,
        maker: maker.name,
        makerId: maker.id,
        type: entry.type || maker.type || 'Beer',
        style: normalizeStyle(entry.style || ''),
        abv: entry.abv ?? null,
        pop: entry.pop || 1,
        season: entry.season || null,
        aka: entry.aka || [],
        size: entry.size || '',
        city: maker.city || '',
        state: maker.state || '',
        country: maker.country || '',
        lat: maker.lat ?? null,
        lng: maker.lng ?? null,
        makerKind: maker.kind || '',
        corporate: CORPORATE.test(fold(maker.name)),
      };
      item.family = familyOf(item);
      item.fullName = fullName(item);
      item.words = tokens(`${brand} ${item.name} ${item.aka.join(' ')}`);
      item.nameWords = tokens(`${item.name} ${item.aka.join(' ')}`).filter(word => !MATCH_STOP.has(word));
      item.brandWords = tokens(brand).filter(word => !MATCH_STOP.has(word));
      item.styleWords = tokens(item.style);
      item.folded = fold(item.name);
      item.foldedFull = fold(item.fullName);
      if (!catalog.byId.has(item.id)) {
        catalog.items.push(item);
        catalog.byId.set(item.id, item);
      }
    }
  }
  catalog.version = data.updated || '';
  catalog.ready = true;
  return catalog;
}

const SELF_BRANDED = new Set(['bud', 'coke', 'pepsi', 'natty', 'pbr', 'dew', 'busch', 'keystone', 'icehouse', 'mgd', 'sprite', 'fanta', 'gatorade']);

/** "Founders All Day IPA" style label for toasts and logs; avoids doubling the brand. */
export function fullName(item) {
  const name = item.name || '';
  const brand = item.brand || '';
  if (!brand) return name;
  const brandWords = tokens(brand);
  const nameWords = tokens(name);
  const brandFirst = brandWords[0];
  const folded = fold(name);
  if (!brandFirst || folded.includes(brandFirst) || CORPORATE.test(fold(brand)) || nameWords.length >= 4) return name;
  // "Bud Light" under brand "Budweiser"
  if (nameWords[0]?.length >= 3 && brandFirst.startsWith(nameWords[0])) return name;
  // Product words that already name the brand ("Diet Coke", "Natty Light").
  if (nameWords.some(word => SELF_BRANDED.has(word))) return name;
  return `${brand} ${name}`;
}

export const catalogReady = () => catalog.ready;
export const catalogItems = () => catalog.items;
export const catalogVersion = () => catalog.version;
export const catalogSize = () => catalog.items.length;
export const getCatalogItem = id => catalog.byId.get(id) || null;
export const getMaker = id => catalog.makerById.get(id) || null;

function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function tokenScore(token, words) {
  let best = 0;
  for (const word of words) {
    if (word === token) return 3;
    if (word.startsWith(token)) best = Math.max(best, token.length > 1 ? 2.2 : 1.2);
    else if (token.length >= 3 && word.includes(token)) best = Math.max(best, 1);
    else if (!best && token.length >= 4 && withinOneEdit(word, token)) best = 0.8;
  }
  return best;
}

/**
 * Typeahead search. Every query word must match (prefix, substring or one typo).
 * `boost(item)` adds smart-suggest context such as locality and history.
 */
export function searchCatalog(query, { limit = 12, type = null, boost = null } = {}) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];
  const phrase = fold(query);
  const results = [];
  for (const item of catalog.items) {
    if (type && item.type !== type) continue;
    let score = 0;
    let matched = true;
    for (const token of queryTokens) {
      let best = tokenScore(token, item.words);
      if (!best) best = tokenScore(token, item.styleWords) * 0.45;
      if (!best) { matched = false; break; }
      score += best;
    }
    if (!matched) continue;
    if (item.folded.startsWith(phrase)) score += 2.4;
    else if (item.foldedFull.startsWith(phrase)) score += 1.8;
    score += item.pop * 0.35;
    if (boost) score += boost(item);
    results.push({ item, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map(result => result.item);
}

/** Strip sizes and packaging words from a product title before matching. */
function matchTokens(text) {
  const cleaned = String(text || '')
    .replace(/\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|oz|ml|cl|l|ltr|liter|litre)\b\.?/gi, ' ')
    .replace(/\b\d+\s*(?:pk|pack|ct|count|cans?|bottles?)\b/gi, ' ')
    .replace(/[®™]/g, ' ');
  return [...new Set(tokens(cleaned).filter(word => !MATCH_STOP.has(word) && !/^\d+%?$/.test(word)))];
}

/**
 * Rank catalog items against a product found by barcode lookup.
 * Returns [{ item, score }] best first; score ~0..1.
 */
export function matchCandidates({ name = '', brand = '' }, { limit = 5 } = {}) {
  const query = matchTokens(`${brand} ${name}`);
  if (!query.length) return [];
  const querySet = new Set(query);
  const brandSet = new Set(matchTokens(brand));
  const results = [];
  for (const item of catalog.items) {
    let nameHit = 0;
    item.nameWords.forEach(word => { if (querySet.has(word)) nameHit += 1; });
    const brandHit = item.brandWords.length > 0 && item.brandWords.every(word => querySet.has(word));
    if (!nameHit && !brandHit) continue;
    const coverage = item.nameWords.length ? nameHit / item.nameWords.length : 0;
    let precisionHits = 0;
    query.forEach(word => { if (item.words.includes(word)) precisionHits += 1; });
    const precision = precisionHits / query.length;
    const brandBonus = brandHit ? 0.22 : brandSet.size && item.brandWords.some(word => brandSet.has(word)) ? 0.1 : 0;
    const score = coverage * 0.55 + precision * 0.3 + brandBonus + item.pop * 0.01;
    results.push({ item, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Catalog maker for a brewery name (e.g. from Open Brewery DB), if we know it. */
export function matchMaker(name, stateCode = '') {
  const key = makerKey(name);
  if (!key) return null;
  return catalog.makers.find(maker => {
    if (maker.key && key === maker.key) return true;
    if (maker.brandKey && key === maker.brandKey) return true;
    const sameState = !stateCode || !maker.state || maker.state === stateCode;
    return sameState && maker.key && maker.key.length >= 4 && key.startsWith(`${maker.key} `);
  }) || null;
}

export function itemsForMaker(makerId) {
  return catalog.items.filter(item => item.makerId === makerId).sort((a, b) => b.pop - a.pop);
}

export function catalogDistance(item, location) {
  if (!location || item.lat == null) return Infinity;
  return haversineMiles(location, item);
}

export function makersList() {
  return catalog.makers;
}
