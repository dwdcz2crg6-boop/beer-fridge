// App state + persistence (localStorage), migration from the first version,
// transactions with undo, learned barcodes and the beer-run list.
import { fold, uid } from './util.js';
import { TYPES, TYPE_META, normalizeStyle } from './taxonomy.js';
import { canonicalCode, companyPrefixes } from './lookup.js';
import { fullName } from './catalog.js';

const KEY = 'um-fridge-v2';
const LEGACY_INVENTORY = 'um-fridge-inventory';
const LEGACY_ACTIVITY = 'um-fridge-activity';
// Placeholder codes from the first demo build; never match real scans against them.
const LEGACY_FAKE_CODES = ['817548012101', '850015540027', '012086604308', '083837000105', '012000001033', '085000029306'];

export const DEFAULT_SETTINGS = {
  fridgeName: "Uncle Mike's Beer Fridge",
  location: null,
  rapidScan: true,
  beep: true,
  defaultPar: 3,
  upcProxy: '',
  menuView: 'flow',
  menuGroup: 'style',
  invView: 'flow',
  invGroup: 'style',
  lastBy: '',
  recentNames: [],
  dismissed: [],
  stockLists: [],
};

export const store = {
  items: [],
  activity: [],
  settings: { ...DEFAULT_SETTINGS },
  upcMap: {},
  prefixMap: {},
  beerRun: [],
};

const listeners = new Set();
export const subscribe = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const nowIso = () => new Date().toISOString();
const hoursAgo = hours => new Date(Date.now() - hours * 3600000).toISOString();

export function normalizeItem(raw = {}) {
  const type = TYPES.includes(raw.type) ? raw.type : raw.type === 'Seltzer' ? 'Carbonated' : 'Other';
  const abv = raw.abv === '' || raw.abv == null || Number.isNaN(Number(raw.abv)) ? null : Math.round(Number(raw.abv) * 10) / 10;
  return {
    id: String(raw.id || '').replace(/[^\w-]/g, '') || uid('item'),
    name: String(raw.name || '').trim() || 'Unnamed drink',
    brand: String(raw.brand || '').trim(),
    type,
    style: normalizeStyle(raw.style || ''),
    abv,
    size: raw.size ?? TYPE_META[type]?.size ?? '',
    count: Math.max(0, Math.round(Number(raw.count) || 0)),
    par: raw.par == null || raw.par === '' ? null : Math.max(0, Math.round(Number(raw.par))),
    ratingTotal: Number(raw.ratingTotal) || 0,
    ratingCount: Number(raw.ratingCount) || 0,
    barcodes: [...new Set((raw.barcodes || []).filter(Boolean))],
    catalogId: raw.catalogId || null,
    city: raw.city || '',
    state: raw.state || '',
    country: raw.country || '',
    lat: raw.lat ?? null,
    lng: raw.lng ?? null,
    image: raw.image || '',
    addedAt: raw.addedAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
  };
}

function demoData() {
  const items = [
    { name: 'All Day IPA', brand: 'Founders', type: 'Beer', style: 'Session IPA', abv: 4.7, count: 14, ratingTotal: 19, ratingCount: 4, city: 'Grand Rapids', state: 'MI', country: 'US' },
    { name: 'Pale Ale', brand: 'Sierra Nevada', type: 'Beer', style: 'Pale Ale', abv: 5.6, count: 9, ratingTotal: 21, ratingCount: 5, city: 'Chico', state: 'CA', country: 'US' },
    { name: 'Especial', brand: 'Modelo', type: 'Beer', style: 'Mexican Lager', abv: 4.4, count: 6, ratingTotal: 22, ratingCount: 5, country: 'MX' },
    { name: 'White', brand: 'Allagash', type: 'Beer', style: 'Witbier', abv: 5.2, count: 2, ratingTotal: 18, ratingCount: 4, city: 'Portland', state: 'ME', country: 'US' },
    { name: 'Draught', brand: 'Guinness', type: 'Beer', style: 'Irish Stout', abv: 4.2, size: '14.9 fl oz', count: 4, ratingTotal: 17, ratingCount: 4, city: 'Dublin', country: 'IE' },
    { name: 'Run Wild IPA', brand: 'Athletic Brewing', type: 'Beer', style: 'Non-Alcoholic IPA', abv: 0.5, count: 5, ratingTotal: 12, ratingCount: 3, city: 'Milford', state: 'CT', country: 'US' },
    { name: 'Peach', brand: 'High Noon', type: 'Ready-to-Drink', style: 'Hard Seltzer', abv: 4.5, count: 8, ratingTotal: 15, ratingCount: 4 },
    { name: 'Diet Coke', brand: 'Coca-Cola', type: 'Soft Drink', style: 'Diet Cola', count: 11, ratingTotal: 17, ratingCount: 4 },
    { name: 'Mineral Water', brand: 'Topo Chico', type: 'Carbonated', style: 'Mineral Water', count: 3, ratingTotal: 13, ratingCount: 3 },
    { name: 'Cabernet Sauvignon', brand: 'Austin Hope', type: 'Wine', style: 'Cabernet Sauvignon', abv: 14.5, count: 2, ratingTotal: 24, ratingCount: 5, city: 'Paso Robles', state: 'CA', country: 'US' },
  ].map((item, index) => normalizeItem({ ...item, id: `demo-${index + 1}`, addedAt: hoursAgo(72 + index) }));
  const byName = name => items.find(item => item.name === name);
  const activity = [
    ['out', 'Peach', 1, 1.2, 'Sam'],
    ['out', 'All Day IPA', 2, 3.5, 'Mike'],
    ['in', 'All Day IPA', 12, 6],
    ['out', 'Especial', 2, 26, 'Jen'],
    ['in', 'Pale Ale', 12, 50],
    ['out', 'White', 2, 52, 'Mike'],
  ].map(([kind, name, qty, hours, by]) => ({ id: uid('a'), kind, itemId: byName(name).id, name: fullName(byName(name)), qty, at: hoursAgo(hours), by: by || '' }));
  return { items, activity };
}

function migrateLegacy() {
  let inventory;
  try { inventory = JSON.parse(localStorage.getItem(LEGACY_INVENTORY) || 'null'); } catch { inventory = null; }
  if (!Array.isArray(inventory)) return null;
  let legacyActivity;
  try { legacyActivity = JSON.parse(localStorage.getItem(LEGACY_ACTIVITY) || 'null') || []; } catch { legacyActivity = []; }
  const items = inventory.map(old => normalizeItem({
    id: old.id,
    name: old.name,
    type: /high noon|cutwater/i.test(old.name || '') ? 'Ready-to-Drink' : old.type,
    style: old.style,
    size: old.size,
    count: old.count,
    ratingTotal: old.ratingTotal,
    ratingCount: old.ratingCount,
    barcodes: old.barcode && !LEGACY_FAKE_CODES.includes(old.barcode) ? [canonicalCode(old.barcode)] : [],
  }));
  const activity = legacyActivity.map(entry => ({
    id: uid('a'),
    kind: entry.kind,
    itemId: items.find(item => item.name === entry.name)?.id || null,
    name: entry.name,
    qty: entry.quantity || 1,
    at: null,
    whenLabel: entry.when || '',
    by: '',
  }));
  return { items, activity };
}

export function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
  if (saved?.v === 2) {
    store.items = (saved.items || []).map(normalizeItem);
    store.activity = saved.activity || [];
    store.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
    store.upcMap = saved.upcMap || {};
    store.prefixMap = saved.prefixMap || {};
    store.beerRun = saved.beerRun || [];
    return 'loaded';
  }
  const migrated = migrateLegacy();
  const data = migrated || demoData();
  store.items = data.items;
  store.activity = data.activity;
  save();
  return migrated ? 'migrated' : 'demo';
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      v: 2,
      items: store.items,
      activity: store.activity.slice(0, 1000),
      settings: store.settings,
      upcMap: store.upcMap,
      prefixMap: store.prefixMap,
      beerRun: store.beerRun,
    }));
  } catch (error) {
    console.warn('Could not save fridge data', error);
  }
}

function commit(reason) {
  save();
  listeners.forEach(listener => listener(reason));
}

// ---------------------------------------------------------------------------
// Lookups

export const findItem = id => store.items.find(item => item.id === id) || null;

export function findByBarcode(code, format) {
  const key = canonicalCode(code, format);
  return store.items.find(item => item.barcodes.includes(key)) || null;
}

export function findSame(candidate) {
  if (candidate.catalogId) {
    const byCatalog = store.items.find(item => item.catalogId === candidate.catalogId);
    if (byCatalog) return byCatalog;
  }
  const name = fold(candidate.name);
  const brand = fold(candidate.brand || '');
  return store.items.find(item => fold(item.name) === name && (!brand || !item.brand || fold(item.brand) === brand)) || null;
}

// ---------------------------------------------------------------------------
// Transactions

function rememberName(by) {
  if (!by) return;
  store.settings.lastBy = by;
  store.settings.recentNames = [by, ...store.settings.recentNames.filter(name => name !== by)].slice(0, 6);
}

function checkOffBeerRun(item) {
  const name = fold(item.name);
  store.beerRun = store.beerRun.filter(entry => !(entry.itemId === item.id || (item.catalogId && entry.catalogId === item.catalogId) || fold(entry.name) === name));
}

/** Add stock. `data` can be an existing item or a new drink description. */
export function stockIn(data, qty, { code, format } = {}) {
  let item = data.id ? findItem(data.id) : null;
  let created = false;
  if (!item) item = findSame(data);
  if (!item) {
    item = normalizeItem({ ...data, id: undefined, count: 0 });
    store.items.push(item);
    created = true;
  }
  const undoBarcode = code ? attachBarcode(item, code, format) : null;
  item.count += qty;
  item.updatedAt = nowIso();
  const entry = { id: uid('a'), kind: 'in', itemId: item.id, name: fullName(item), qty, at: nowIso(), by: '' };
  store.activity.unshift(entry);
  const beerRunBefore = store.beerRun;
  checkOffBeerRun(item);
  const checkedOff = beerRunBefore.length !== store.beerRun.length;
  commit('stock');
  const undo = () => {
    item.count = Math.max(0, item.count - qty);
    undoBarcode?.();
    store.activity = store.activity.filter(activity => activity.id !== entry.id);
    if (created) store.items = store.items.filter(existing => existing.id !== item.id);
    store.beerRun = beerRunBefore;
    commit('undo');
  };
  return { item, created, checkedOff, undo };
}

// Sample drinks from the demo fridge keep their `demo-N` ids.
const isSample = item => /^demo-\d+$/.test(item.id);
export const sampleItems = () => store.items.filter(isSample);
export const stockListLoaded = key => (store.settings.stockLists || []).find(entry => entry.key === key) || null;

/**
 * Stock several drinks at once (a fridge list opened from a link). One save and one undo.
 * `lines` is [{ data, qty }]; `dropSamples` clears the demo drinks first.
 */
export function stockBatch(lines, { dropSamples = false, listKey = '' } = {}) {
  const before = JSON.stringify({ items: store.items, activity: store.activity, beerRun: store.beerRun, stockLists: store.settings.stockLists || [] });
  if (dropSamples) {
    const gone = new Set(sampleItems().map(item => item.id));
    store.items = store.items.filter(item => !gone.has(item.id));
    store.activity = store.activity.filter(entry => !gone.has(entry.itemId));
  }
  let drinks = 0;
  let units = 0;
  const at = nowIso();
  lines.forEach(({ data, qty }) => {
    const count = Math.max(0, Math.round(Number(qty) || 0));
    if (!data || !count) return;
    let item = findSame(data);
    if (!item) {
      item = normalizeItem({ ...data, id: undefined, count: 0 });
      // A drink that arrives as a single or a pair isn't "running low" on day one:
      // alert once it drops below what it came in with.
      if (item.par == null && count <= store.settings.defaultPar) item.par = Math.max(0, count - 1);
      store.items.push(item);
    } else if (data.catalogId && !item.catalogId) {
      item.catalogId = data.catalogId;
      ['size', 'city', 'state', 'country', 'lat', 'lng', 'style'].forEach(field => { if (!item[field] && data[field] != null) item[field] = data[field]; });
    }
    item.count += count;
    item.updatedAt = at;
    store.activity.unshift({ id: uid('a'), kind: 'in', itemId: item.id, name: fullName(item), qty: count, at, by: '' });
    checkOffBeerRun(item);
    drinks += 1;
    units += count;
  });
  if (listKey) store.settings.stockLists = [{ key: listKey, at }, ...(store.settings.stockLists || []).filter(entry => entry.key !== listKey)].slice(0, 12);
  commit('stock');
  return {
    drinks,
    units,
    undo: () => {
      const saved = JSON.parse(before);
      store.items = saved.items.map(normalizeItem);
      store.activity = saved.activity;
      store.beerRun = saved.beerRun;
      store.settings.stockLists = saved.stockLists;
      commit('undo');
    },
  };
}

export function checkout(lines, { by = '' } = {}) {
  const entries = [];
  lines.forEach(({ id, qty }) => {
    const item = findItem(id);
    if (!item || qty <= 0) return;
    const taken = Math.min(qty, item.count);
    if (!taken) return;
    item.count -= taken;
    item.updatedAt = nowIso();
    const entry = { id: uid('a'), kind: 'out', itemId: item.id, name: fullName(item), qty: taken, at: nowIso(), by };
    store.activity.unshift(entry);
    entries.push({ item, entry, taken });
  });
  rememberName(by);
  commit('checkout');
  const undo = () => {
    entries.forEach(({ item, entry, taken }) => {
      item.count += taken;
      store.activity = store.activity.filter(activity => activity.id !== entry.id);
    });
    commit('undo');
  };
  return { entries, undo };
}

export function adjustCount(id, count) {
  const item = findItem(id);
  if (!item) return null;
  const next = Math.max(0, Math.round(count));
  const delta = next - item.count;
  if (!delta) return null;
  const before = item.count;
  item.count = next;
  item.updatedAt = nowIso();
  const entry = { id: uid('a'), kind: 'adjust', itemId: item.id, name: fullName(item), qty: delta, at: nowIso(), by: '' };
  store.activity.unshift(entry);
  commit('adjust');
  return {
    undo: () => {
      item.count = before;
      store.activity = store.activity.filter(activity => activity.id !== entry.id);
      commit('undo');
    },
  };
}

export function saveItem(data) {
  const existing = data.id ? findItem(data.id) : null;
  if (existing) {
    const next = normalizeItem({ ...existing, ...data, id: existing.id, count: existing.count, barcodes: existing.barcodes, addedAt: existing.addedAt, updatedAt: nowIso() });
    Object.assign(existing, next);
    commit('edit');
    return existing;
  }
  const item = normalizeItem({ ...data, count: 0 });
  store.items.push(item);
  commit('edit');
  return item;
}

export function deleteItem(id) {
  const index = store.items.findIndex(item => item.id === id);
  if (index < 0) return null;
  const [item] = store.items.splice(index, 1);
  commit('delete');
  return {
    item,
    undo: () => {
      store.items.splice(index, 0, item);
      commit('undo');
    },
  };
}

export function rateItem(id, stars) {
  const item = findItem(id);
  if (!item) return null;
  item.ratingTotal += stars;
  item.ratingCount += 1;
  commit('rate');
  return item;
}

export function linkCatalog(item, catalogItem) {
  item.catalogId = catalogItem.id;
  ['city', 'state', 'country', 'lat', 'lng'].forEach(field => {
    if (!item[field] && catalogItem[field] != null) item[field] = catalogItem[field];
  });
  if (!item.brand) item.brand = catalogItem.brand;
  if (!item.style) item.style = catalogItem.style;
  if (item.abv == null && catalogItem.abv != null) item.abv = catalogItem.abv;
}

export function persist(reason = 'update') {
  commit(reason);
}

// ---------------------------------------------------------------------------
// Learned barcodes

const brandKeyOf = item => (item.catalogId ? item.catalogId.split('/')[0] : fold(item.brand || ''));

function learnPrefixes(key, brandKey, brand, makerId, delta) {
  if (!brandKey) return;
  companyPrefixes(key).forEach(prefix => {
    const bucket = (store.prefixMap[prefix] ||= {});
    const entry = (bucket[brandKey] ||= { brand, makerId, n: 0 });
    entry.n += delta;
    if (entry.n <= 0) delete bucket[brandKey];
    if (!Object.keys(bucket).length) delete store.prefixMap[prefix];
  });
}

/** Link a barcode to a drink (moving it off any other drink). Returns an undo function. */
export function attachBarcode(item, code, format) {
  const key = canonicalCode(code, format);
  if (!key) return () => {};
  const previous = store.upcMap[key] ? { ...store.upcMap[key] } : null;
  const owners = store.items.filter(other => other.barcodes.includes(key)).map(other => ({ other, barcodes: [...other.barcodes] }));
  const ownBarcodes = [...item.barcodes];
  const brandKey = item.brand ? brandKeyOf(item) : '';
  const makerId = item.catalogId ? brandKey : null;
  const changedBrand = !previous || previous.brandKey !== brandKey;
  // A barcode belongs to one product: a correction also unlearns the old brand.
  if (changedBrand && previous?.brandKey) learnPrefixes(key, previous.brandKey, previous.brand, previous.makerId, -1);
  store.items.forEach(other => {
    if (other !== item) other.barcodes = other.barcodes.filter(existing => existing !== key);
  });
  if (!item.barcodes.includes(key)) item.barcodes.push(key);
  if (changedBrand) learnPrefixes(key, brandKey, item.brand, makerId, 1);
  store.upcMap[key] = { itemId: item.id, catalogId: item.catalogId, name: item.name, brand: item.brand, brandKey, makerId, type: item.type, style: item.style, abv: item.abv, size: item.size };
  return () => {
    owners.forEach(({ other, barcodes }) => { other.barcodes = barcodes; });
    item.barcodes = ownBarcodes;
    if (changedBrand) {
      learnPrefixes(key, brandKey, item.brand, makerId, -1);
      if (previous?.brandKey) learnPrefixes(key, previous.brandKey, previous.brand, previous.makerId, 1);
    }
    if (previous) store.upcMap[key] = previous;
    else delete store.upcMap[key];
  };
}

export const learnedProduct = (code, format) => store.upcMap[canonicalCode(code, format)] || null;

/** Which brand probably owns an unknown barcode, based on barcodes you've scanned before. */
export function brandHintFor(code, format) {
  for (const prefix of companyPrefixes(canonicalCode(code, format))) {
    const bucket = store.prefixMap[prefix];
    if (!bucket) continue;
    const entries = Object.values(bucket).sort((a, b) => b.n - a.n);
    const total = entries.reduce((sum, entry) => sum + entry.n, 0);
    if (entries[0] && entries[0].n / total >= 0.7) return entries[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Beer run (shopping list)

export function addToBeerRun(entry) {
  const name = fold(entry.name);
  if (store.beerRun.some(existing => (entry.catalogId && existing.catalogId === entry.catalogId) || fold(existing.name) === name)) return false;
  store.beerRun.unshift({ id: uid('run'), catalogId: entry.catalogId || null, itemId: entry.itemId || null, name: entry.name, brand: entry.brand || '', style: entry.style || '', addedAt: nowIso() });
  commit('beer-run');
  return true;
}

export function removeFromBeerRun(id) {
  store.beerRun = store.beerRun.filter(entry => entry.id !== id);
  commit('beer-run');
}

// ---------------------------------------------------------------------------
// Settings and data management

export function updateSettings(patch) {
  Object.assign(store.settings, patch);
  commit('settings');
}

export function dismissSuggestion(id) {
  store.settings.dismissed = [...new Set([...store.settings.dismissed, id])].slice(-200);
  commit('settings');
}

export function exportData() {
  return JSON.stringify({ app: 'uncle-mikes-beer-fridge', exportedAt: nowIso(), v: 2, items: store.items, activity: store.activity, settings: store.settings, upcMap: store.upcMap, prefixMap: store.prefixMap, beerRun: store.beerRun }, null, 2);
}

export function importData(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.items)) throw new Error('That file is not a fridge backup.');
  store.items = data.items.map(normalizeItem);
  store.activity = Array.isArray(data.activity) ? data.activity : [];
  store.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  store.upcMap = data.upcMap || {};
  store.prefixMap = data.prefixMap || {};
  store.beerRun = data.beerRun || [];
  commit('import');
}

export function resetDemo() {
  const data = demoData();
  store.items = data.items;
  store.activity = data.activity;
  store.beerRun = [];
  commit('reset');
}

export function eraseAll() {
  store.items = [];
  store.activity = [];
  store.beerRun = [];
  store.upcMap = {};
  store.prefixMap = {};
  // Keep the record of lists already loaded, or the house list would refill an erased fridge.
  store.settings = { ...DEFAULT_SETTINGS, fridgeName: store.settings.fridgeName, stockLists: store.settings.stockLists || [] };
  localStorage.removeItem(LEGACY_INVENTORY);
  localStorage.removeItem(LEGACY_ACTIVITY);
  commit('erase');
}
