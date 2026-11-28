// Uncle Mike's Beer Fridge: UI controller.
//
// The app is one fixed screen per tab and nothing scrolls at page level. Every job on a drink
// happens under the can (Take one, the dial, Stock in) or on its own list row, and every sheet
// closes itself when its job is done and lands on the drink it touched.
import { $, $$, debounce, dayLabel, esc, fold, hash, haversineMiles, plural, relativeTime, formatTime } from './util.js';
import { FAMILY_ORDER, SEASON_LABEL, SIZES, STATE_NAMES, STYLES, TYPES, TYPE_META, currentSeason, familyOf, inferStyle, inferType, isNonAlcoholic, stylesForType, stateCode } from './taxonomy.js';
import { artSVG } from './art.js';
import { catalogItems, catalogReady, catalogSize, catalogVersion, fullName, getCatalogItem, itemsForMaker, labelFor, loadCatalog, makerOf, makersList, matchCandidates, searchCatalog } from './catalog.js';
import { canonicalCode, digitsOnly, displayCode, isValidGtin, lookupBarcode } from './lookup.js';
import { Scanner, cameraErrorMessage, decodeImageFile, primeAudio, scanFeedback } from './scanner.js';
import { breweriesStale, buildContext, cachedBreweries, fetchBreweries, locateDevice, locateQuery, lowStock, searchBoost, suggest } from './suggest.js';
import { createCoverflow } from './coverflow.js';
import { createWheel } from './wheel.js';
import { decodeSnapshot, decodeStock, qrSvg, snapshotUrl, stockToken } from './share.js';
import {
  addToBeerRun, adjustCount, brandHintFor, checkout, deleteItem, dismissSuggestion, eraseAll, exportData, findByBarcode, findItem, findSame,
  importData, learnedProduct, linkCatalog, load, markListLoaded, mergeItems, nameCheckout, persist, rateItem, removeFromBeerRun, resetDemo, sampleItems, saveItem, stockBatch, stockIn, stockListLoaded, store, subscribe, updateSettings, attachBarcode,
} from './store.js';

// ---------------------------------------------------------------------------
// UI state

const ui = {
  screen: 'screen-home',
  guest: null,
  breweries: [],
  breweriesLoading: false,
  breweriesError: false,
  breweriesShown: 24,
  add: { mode: 'scan', kind: 'session', pending: null, candidate: null, qty: 1, alts: [], session: [], unknown: null, lookupToken: 0 },
  itemId: null,        // the drink open in the Details sheet (one that is not on the shelf)...
  itemCatalog: null,   // ...or a catalog drink, for an idea
  form: null,
  back: false,         // the can in the middle is turned round (its back label is showing)
  backAbout: false,
  round: null,         // drinks just taken: { takes: [{ entryId, itemId, name, undo }], by }
  who: null,           // check-outs waiting for a typed name
  pack: null,          // the open "how many?" picker: { host, key }
  packAt: 0,
  tapGuard: 0,
  lastUndo: null,      // { label, undo }: the last change, still undoable from Activity
  discover: null,      // the kind of suggestion showing
  discoverScroll: {},
  locOpen: false,
  justListed: new Set(), // put on the beer run from a card this session: it stays in view, marked
  actFilter: 'all',
  actItem: null,
  find: { intent: 'shelf', open: null },
  booting: false,
  shareUrl: '',
  version: 0,
};

// The owner's shelf and the guest's read-only menu share the grouping, the rail and the Cover Flow.
const newLineup = (id, sort) => ({ id, type: 'all', group: 'all', query: '', sort, grouping: 'style', flowId: null, signature: '', mapKey: '', types: [], groups: [], groupOf: new Map(), shown: [], filterable: false, flow: null });
// The shelf is in name order by default, so a can keeps its place when its count changes.
const lineups = { inv: newLineup('inv', 'name'), menu: newLineup('menu', 'name'), find: newLineup('find', 'name') };

let scanner = null;
let suggestionCache = null;
let suggestionKey = '';

const ROUTES = { '': 'screen-home', menu: 'screen-home', run: 'screen-run', discover: 'screen-discover', activity: 'screen-activity' };
const FACE_NAME = { 'screen-home': 'Fridge', 'screen-run': 'Beer run', 'screen-discover': 'Discover', 'screen-activity': 'Activity', 'screen-menu': 'Menu' };
const PACKS = [1, 4, 6, 12, 24];
const parPlaceholder = () => store.settings.defaultPar;
const icon = (name, extra = '') => `<svg aria-hidden="true"${extra}><use href="#${name}"/></svg>`;

// ---------------------------------------------------------------------------
// Display helpers

const abvText = item => (item.abv != null && item.abv !== '' ? `${Number(item.abv).toFixed(1).replace(/\.0$/, '')}%` : '');
const metaLine = (item, { size = true } = {}) => [item.style || item.type, abvText(item) && `${abvText(item)} ABV`, size && item.size].filter(Boolean).join(' · ');
const average = item => (item.ratingCount ? item.ratingTotal / item.ratingCount : 0);
const art = (item, label = '') => artSVG(item, { label, image: labelFor(item) });
const typeChip = type => TYPE_META[type]?.chip || type;

function originText(item) {
  const place = [item.city, item.state || (item.country && item.country !== 'US' ? item.country : '')].filter(Boolean).join(', ');
  return place;
}

function starsHtml(item, { count = true } = {}) {
  const avg = average(item);
  if (!item.ratingCount) return '<span class="stars-empty">Not rated yet</span>';
  return `<span class="stars" style="--rating:${avg.toFixed(2)}" aria-hidden="true"></span><span class="rating-num">${avg.toFixed(1)}${count ? ` <small>(${item.ratingCount})</small>` : ''}</span><span class="visually-hidden">${avg.toFixed(1)} out of 5 stars</span>`;
}

function familyColor(type, family) {
  const entry = Object.values(STYLES).find(info => info.type === type && info.family === family);
  return entry?.color || TYPE_META[type]?.color || '#ccc';
}

function chipsHtml(options, active, attribute) {
  return options.map(option => `<button type="button" class="chip${option.value === active ? ' is-active' : ''}" data-${attribute}="${esc(option.value)}" aria-pressed="${option.value === active}">${option.dot ? `<i class="dot" style="background:${option.dot}"></i>` : ''}${esc(option.label)}${option.count != null ? `<span class="chip-count">${option.count}</span>` : ''}</button>`).join('');
}

function emptyHtml(title, body, action = '') {
  return `<div class="empty-card"><svg aria-hidden="true"><use href="#i-fridge"/></svg><b>${esc(title)}</b><p>${esc(body)}</p>${action}</div>`;
}

function shortBrewery(name = '') {
  return name.replace(/\s+(brewing|brewery|beer|ales?|brewhouse|brewers)(\s+(company|co\.?|works|house|project))?\.?$/i, '').replace(/\s+(company|co\.?)$/i, '').trim() || name;
}

// ---------------------------------------------------------------------------
// Grouping, filtering and sorting (shared by the fridge lineup and the menu)

const GROUPINGS = [['style', 'By style'], ['brewery', 'By brewery'], ['type', 'By type'], ['strength', 'By strength'], ['rating', 'By rating'], ['origin', 'By origin'], ['none', 'No groups']];
const GROUP_COLORS = ['#8fb7a5', '#d9b86a', '#c98f7a', '#8aa9d6', '#b79ad6', '#d6a3b8', '#9fc27a', '#e0a35c'];
const OTHER_LABEL = { Beer: 'Other beer', Wine: 'Other wine', 'Ready-to-Drink': 'Other RTDs', 'Soft Drink': 'Other soft drinks', Carbonated: 'Other sparkling' };
const NO_ALCOHOL_TYPES = ['Soft Drink', 'Carbonated', 'Water'];
const groupingSetting = key => (GROUPINGS.some(([value]) => value === store.settings[key]) ? store.settings[key] : 'style');
const parOf = item => item.par ?? store.settings.defaultPar;

const SORTERS = {
  count: (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  low: (a, b) => (a.count - parOf(a)) - (b.count - parOf(b)) || a.count - b.count,
  name: (a, b) => fullName(a).localeCompare(fullName(b)),
  recent: (a, b) => String(b.addedAt).localeCompare(String(a.addedAt)),
  rating: (a, b) => average(b) - average(a) || b.ratingCount - a.ratingCount,
};

let regionNames;
function countryName(code = '') {
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try {
    regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

/** Which group a drink belongs to under a grouping: { key, label, rank, dot? }. */
function groupInfo(item, grouping) {
  if (grouping === 'style') {
    const family = familyOf(item);
    const families = FAMILY_ORDER[item.type] || [];
    return {
      key: `${item.type}|${family}`,
      label: family !== 'Other' ? family : OTHER_LABEL[item.type] || typeChip(item.type),
      rank: TYPES.indexOf(item.type) * 100 + (families.indexOf(family) + 1 || 99),
      dot: familyColor(item.type, family),
    };
  }
  if (grouping === 'brewery') {
    return item.brand ? { key: `b:${fold(item.brand)}`, label: shortBrewery(item.brand), rank: 0 } : { key: 'b:', label: 'No brand listed', rank: 1 };
  }
  if (grouping === 'type') return { key: item.type, label: typeChip(item.type), rank: TYPES.indexOf(item.type), dot: TYPE_META[item.type]?.color };
  if (grouping === 'strength') {
    const known = item.abv != null && item.abv !== '';
    const abv = Number(item.abv);
    if (NO_ALCOHOL_TYPES.includes(item.type) || isNonAlcoholic(item) || (known && abv <= 0.5)) return { key: 'zero', label: 'No alcohol', rank: 0, dot: '#8fc3e6' };
    if (!known) return { key: 'unknown', label: 'ABV not listed', rank: 5, dot: '#9aa59f' };
    if (abv < 5) return { key: 'light', label: 'Under 5%', rank: 1, dot: '#f1d58a' };
    if (abv < 7) return { key: 'mid', label: '5 to 6.9%', rank: 2, dot: '#e0a83a' };
    if (abv < 10) return { key: 'strong', label: '7 to 9.9%', rank: 3, dot: '#c0782a' };
    return { key: 'big', label: '10% and up', rank: 4, dot: '#8a4a1c' };
  }
  if (grouping === 'rating') {
    if (!item.ratingCount) return { key: 'unrated', label: 'Not rated yet', rank: 3, dot: '#9aa59f' };
    const avg = average(item);
    if (avg >= 4) return { key: 'top', label: '4 stars and up', rank: 0, dot: '#eaa53d' };
    if (avg >= 3) return { key: 'good', label: '3 to 4 stars', rank: 1, dot: '#d9c07a' };
    return { key: 'low', label: 'Under 3 stars', rank: 2, dot: '#b7a59a' };
  }
  if (grouping === 'origin') {
    if (item.country && item.country !== 'US') return { key: `c:${item.country}`, label: countryName(item.country), rank: 1 };
    if (item.state) return { key: `s:${item.state}`, label: STATE_NAMES[item.state] || item.state, rank: item.state === store.settings.location?.state ? -1 : 0 };
    return { key: 'o:', label: 'Origin not listed', rank: 2 };
  }
  return { key: 'all', label: '', rank: 0 };
}

/** Filter, group and sort a lineup's drinks. The result is kept on the lineup. */
function organize(lineup, list, grouping) {
  const types = TYPES.filter(type => list.some(item => item.type === type));
  if (lineup.type !== 'all' && !types.includes(lineup.type)) lineup.type = 'all';
  const query = fold(lineup.query);
  const pool = list.filter(item => (lineup.type === 'all' || item.type === lineup.type)
    && (!query || fold(`${item.brand} ${item.name} ${item.style} ${item.type}`).includes(query)));
  const groupOf = new Map();
  const byKey = new Map();
  if (grouping !== 'none') {
    pool.forEach(item => {
      const info = groupInfo(item, grouping);
      const group = byKey.get(info.key) || { ...info, dot: info.dot || GROUP_COLORS[hash(info.key) % GROUP_COLORS.length], count: 0 };
      group.count += 1;
      byKey.set(info.key, group);
      groupOf.set(item.id, group);
    });
  }
  const groups = [...byKey.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  groups.forEach((group, index) => { group.order = index; });
  // Grouping by type would only repeat the type chips, so it gets no second row.
  const filterable = grouping !== 'type' && groups.length > 1;
  if (!filterable || !byKey.has(lineup.group)) lineup.group = 'all';
  const sorter = SORTERS[lineup.sort] || SORTERS.name;
  const shown = pool
    .filter(item => lineup.group === 'all' || groupOf.get(item.id)?.key === lineup.group)
    .sort((a, b) => (groupOf.get(a.id)?.order ?? 0) - (groupOf.get(b.id)?.order ?? 0) || sorter(a, b));
  return Object.assign(lineup, { grouping, types, groups, groupOf, shown, filterable });
}

const showsGroups = lineup => lineup.grouping !== 'none' && lineup.group === 'all' && lineup.groups.length > 1;

// ---------------------------------------------------------------------------
// The rail under a shelf: one chip per group. A chip jumps the shelf to its group, and the
// chip of the group in the middle is marked. Nothing is filtered out, so there is never a
// filtered state to find the way out of.

let railTouched = -1e9;

function renderRail(lineup) {
  const el = $(`#${lineup.id}-group-chips`);
  const show = showsGroups(lineup);
  el.hidden = !show;
  const key = show ? lineup.shown.map(item => lineup.groupOf.get(item.id).key).join('|') : '';
  if (key !== lineup.mapKey) {
    lineup.mapKey = key;
    const first = new Map();
    lineup.shown.forEach((item, index) => {
      const group = lineup.groupOf.get(item.id);
      if (group && !first.has(group.key)) first.set(group.key, index);
    });
    el.innerHTML = show
      ? lineup.groups.map(group => `<button type="button" class="chip" data-jump="${lineup.id}" data-index="${first.get(group.key) ?? 0}" data-group="${esc(group.key)}" aria-label="Jump to ${esc(group.label)}, ${plural(group.count, 'drink')}"><i class="dot" style="background:${group.dot}"></i>${esc(group.label)}<span class="chip-count">${group.count}</span></button>`).join('')
      : '';
  }
  markRail(lineup);
}

function markRail(lineup) {
  const current = lineup.groupOf.get(lineup.flowId)?.key;
  $$(`#${lineup.id}-group-chips .chip`).forEach(chip => {
    const on = chip.dataset.group === current;
    if (on === chip.classList.contains('is-current')) return;
    chip.classList.toggle('is-current', on);
    if (!on) { chip.removeAttribute('aria-current'); return; }
    chip.setAttribute('aria-current', 'true');
    // Keep the current group in view, unless a finger is busy with the row.
    const row = chip.parentElement;
    if (performance.now() - railTouched < 1500 || !row.clientWidth) return;
    const left = chip.offsetLeft - row.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2;
    row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  });
}

/** Items rendered in order, with a heading wherever a new group starts. */
function groupedHtml(lineup, renderItem) {
  const headings = showsGroups(lineup);
  let last = null;
  return lineup.shown.map(item => {
    const group = lineup.groupOf.get(item.id);
    const heading = headings && group !== last ? `<h3 class="group-head"><i class="dot" style="background:${group.dot}"></i>${esc(group.label)}<span>${group.count}</span></h3>` : '';
    last = group;
    return heading + renderItem(item);
  }).join('');
}

// ---------------------------------------------------------------------------
// Cover Flow (the owner's shelf, and the guest menu)

const cardKey = item => [item.id, item.name, item.brand, item.style, item.abv, item.size, item.type, labelFor(item)?.src || ''].join('~');

function flowCard(item) {
  // .cf-inner carries the 3D tilt. The card itself must stay flat: scroll-snap measures it,
  // and a tilted card snaps off center and gets skipped by a swipe.
  return `<button class="cf-card" type="button" role="option" data-id="${item.id}" aria-label="${esc(fullName(item))}"><span class="cf-inner"><span class="cf-art">${art(item)}</span></span></button>`;
}

const preloadedLabels = new Map();

/** Fetch and decode label pictures ahead of the swipe, so no can scrolls in without its label. */
function preloadLabels(items) {
  items.forEach(item => {
    const src = labelFor(item)?.src;
    if (!src || preloadedLabels.has(src)) return;
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
    preloadedLabels.set(src, image);
  });
}

/** A drink is about to leave the shelf: keep the Cover Flow where it is, on its neighbour. */
function leaveShelf(itemId) {
  const lineup = lineups.inv;
  const index = lineup.shown.findIndex(entry => entry.id === itemId);
  if (index < 0 || lineup.flowId !== itemId) return;
  lineup.flowId = (lineup.shown[index + 1] || lineup.shown[index - 1])?.id || null;
}

/**
 * Take a drink off the shelf (the flick-up gesture, or "Out of stock" on its back label). The
 * drink is marked out of stock, not deleted: it leaves the shelf, stays on the beer run, and
 * keeps its ratings and barcode for the next restock.
 */
function markOut(id) {
  const item = findItem(id);
  if (!item || ui.guest || item.count < 1) return;
  flushCount(); // a count change still waiting to save belongs to the ledger first
  closeBack();
  leaveShelf(id);
  const onHand = item.count;
  const result = adjustCount(id, 0);
  if (!result) return;
  toast(`${fullName(item)} is off the shelf and on the beer run (was ${onHand})`, {
    undo: () => {
      lineups.inv.flowId = id; // back to where it stood
      result.undo();
    },
    tone: 'ok',
    actions: [{ label: 'Beer run', run: () => showScreen('screen-run', { focus: true }) }],
  });
}

function renderFlow(lineup) {
  const owner = lineup.id === 'inv';
  lineup.flow ||= createCoverflow($(`#${lineup.id}-coverflow`), {
    onChange: index => {
      const id = lineup.shown[index]?.id || null;
      const moved = id !== lineup.flowId;
      lineup.flowId = id;
      if (owner && moved) {
        // The back label and an open "how many?" belong to the can that was in the middle.
        ui.back = false;
        if (ui.pack?.host === 'dock') ui.pack = null;
      }
      renderFlowCaption(lineup);
      markRail(lineup);
    },
    // Tap the can in the middle and it turns round.
    onActivate: index => { if (owner && lineup.shown[index]) toggleBack(); },
    // The owner's shelf only: press and hold a can, flick it up, and it leaves the fridge...
    onFlickUp: owner ? index => { const item = lineup.shown[index]; if (item) markOut(item.id); } : null,
    // ...and press, hold and let go to edit it.
    onHoldRelease: owner ? index => {
      const item = lineup.shown[index];
      if (item && !ui.guest) openForm({ mode: 'edit', item });
    } : null,
    canLift: () => !ui.back,
    flickText: { idle: 'Let go to edit · flick up to remove', armed: 'Let go to remove' },
  });
  preloadLabels(lineup.shown);
  const signature = lineup.shown.map(cardKey).join('|');
  if (signature !== lineup.signature) {
    lineup.signature = signature;
    const index = Math.max(0, lineup.shown.findIndex(item => item.id === lineup.flowId));
    lineup.flowId = lineup.shown[index]?.id || null;
    lineup.flow.setCards(lineup.shown.map(flowCard).join(''), { index });
  } else {
    const index = lineup.shown.findIndex(item => item.id === lineup.flowId);
    if (index >= 0 && lineup.flow.index !== index) lineup.flow.goTo(index, false);
    lineup.flow.refresh();
  }
  renderRail(lineup);
  renderFlowCaption(lineup);
}

function flowItem(lineup) {
  return lineup.shown.find(entry => entry.id === lineup.flowId) || lineup.shown[0] || null;
}

function renderFlowCaption(lineup) {
  if (lineup.id === 'inv') renderInvCaption();
  else renderGuestCaption();
}

/** The name block under a shelf. Its height never changes, so nothing below it moves on a swipe. */
function captionHtml(lineup, item, extra = '') {
  const position = lineup.shown.length > 1 ? `<p class="cap-pos">${lineup.shown.indexOf(item) + 1} of ${lineup.shown.length}</p>` : '';
  const rating = item.ratingCount ? `<span class="cap-star"><span aria-hidden="true">★ ${average(item).toFixed(1)}</span><span class="visually-hidden">, ${average(item).toFixed(1)} out of 5 stars</span></span>` : '';
  return `${position}
    <p class="brand-line">${esc(item.brand || typeChip(item.type))}</p>
    <h2 class="cap-name${item.name.length > 17 ? ' is-long' : ''}"><span>${esc(item.name)}</span></h2>
    <p class="cap-meta">${esc(metaLine(item))}${rating}${extra}</p>`;
}

// ---------------------------------------------------------------------------
// Count dial: slide to correct what's on hand. It saves itself a moment after
// the dial stops, then confirms with a message that offers Undo.

const countCtls = {};
const countEdit = { itemId: null, value: 0, timer: 0 };
const COUNT_HINT = 'On hand · slide or tap ± to fix the count';
const COUNT_SAVE_DELAY = 800;

function setupCountCtl(name, rootId) {
  const root = $(`#${rootId}`);
  const ctl = { name, root, itemId: null, note: $('.count-note', root) };
  root.dataset.ctl = name;
  ctl.wheel = createWheel($('.wheel', root), {
    onInput: value => { if (ctl.itemId) previewCount(ctl.itemId, value); },
    onSettle: value => { if (ctl.itemId) queueCount(ctl.itemId, value); },
  });
  countCtls[name] = ctl;
}

/** The dial is moving: remember where it is, hold off saving. */
function previewCount(itemId, value) {
  if (countEdit.itemId && countEdit.itemId !== itemId) flushCount();
  clearTimeout(countEdit.timer);
  countEdit.itemId = itemId;
  countEdit.value = value;
  renderCountNotes();
}

/** The dial stopped: save shortly unless it starts moving again. */
function queueCount(itemId, value) {
  previewCount(itemId, value);
  const item = findItem(itemId);
  if (!item || item.count === value) {
    countEdit.itemId = null;
    renderCountNotes();
    return;
  }
  countEdit.timer = setTimeout(flushCount, COUNT_SAVE_DELAY);
}

/** Save a pending dial change now and confirm it. */
function flushCount() {
  clearTimeout(countEdit.timer);
  const { itemId, value } = countEdit;
  countEdit.itemId = null;
  const item = itemId && findItem(itemId);
  if (!item || item.count === value) {
    renderCountNotes();
    return;
  }
  const before = item.count;
  if (value === 0) leaveShelf(item.id);
  const result = adjustCount(item.id, value);
  if (!result) return;
  // The dial is for fixing a count. If it just went down by one or two, the drink was probably
  // drunk: offer to log it as taken, so it counts in "taken this week" and the favourites.
  const drop = before - value;
  const actions = drop === 1 || drop === 2
    ? [{ label: 'Log as taken', run: () => logAsTaken(item.id, drop, result) }]
    : value === 0 ? [{ label: 'Beer run', run: () => showScreen('screen-run', { focus: true }) }] : [];
  toast(value === 0 ? `${fullName(item)} is out: off the shelf, on the beer run (was ${before})` : `${fullName(item)}: now ${value} on hand (was ${before})`, {
    undo: () => {
      if (value === 0) lineups.inv.flowId = item.id; // back to where it stood
      result.undo();
    },
    tone: 'ok',
    actions,
  });
}

function renderCountNotes() {
  Object.values(countCtls).forEach(ctl => {
    const item = ctl.itemId && findItem(ctl.itemId);
    const pending = Boolean(item) && countEdit.itemId === item.id && countEdit.value !== item.count;
    ctl.root.classList.toggle('is-pending', pending);
    ctl.note.textContent = pending ? `Changing ${item.count} to ${countEdit.value}…` : COUNT_HINT;
  });
}

/** Point a count control at a drink and show its current count. */
function syncCount(ctl, item) {
  const switched = ctl.itemId !== item.id;
  // A change still in flight for the drink we're leaving gets saved, not dropped.
  if (switched && ctl.itemId && countEdit.itemId === ctl.itemId) setTimeout(flushCount, 0);
  ctl.itemId = item.id;
  if (switched || countEdit.itemId !== item.id) ctl.wheel.setValue(item.count, { force: switched });
  renderCountNotes();
}

// ---------------------------------------------------------------------------
// Sheets (native <dialog>). One at a time; each closes itself when its job is done.

const openSheets = [];
let closeToken = 0;

function openSheet(id) {
  const dialog = $(`#${id}`);
  if (dialog.open && !dialog.dataset.closing) return dialog;
  // Whatever is open makes way. The one exception is the drink form opened from inside the
  // scanner, which sits over the paused camera so the camera need not start again.
  [...openSheets].forEach(other => {
    if (other !== id && !(id === 'sheet-form' && other === 'sheet-add')) closeSheet(other, { instant: true, replaced: true });
  });
  if (dialog.open) dialog.close(); // it was on its way out
  delete dialog.dataset.closing;
  dialog.classList.remove('is-closing');
  dialog.showModal();
  if (!openSheets.includes(id)) openSheets.push(id);
  document.body.classList.add('has-sheet');
  return dialog;
}

/** Close a sheet. `then` runs once it is really gone, so a message that follows is not hidden under it. */
function closeSheet(id, { instant = false, replaced = false, then = null } = {}) {
  const dialog = $(`#${id}`);
  if (!dialog.open) { then?.(); return; }
  if (dialog.dataset.closing && !instant) return;
  const token = String(closeToken += 1);
  dialog.dataset.closing = token;
  const finish = () => {
    if (dialog.dataset.closing !== token || !dialog.open) return;
    delete dialog.dataset.closing;
    dialog.classList.remove('is-closing');
    dialog.close();
    const at = openSheets.indexOf(id);
    if (at >= 0) openSheets.splice(at, 1);
    const toastEl = $('#toast');
    if (dialog.contains(toastEl)) (openSheets.length ? $(`#${openSheets.at(-1)}`) : document.body).append(toastEl);
    if (!openSheets.length) document.body.classList.remove('has-sheet');
    sheetClosed(id, { replaced });
    then?.();
  };
  if (instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
  dialog.classList.add('is-closing');
  setTimeout(finish, 170);
}

function sheetClosed(id, { replaced = false } = {}) {
  if (id === 'sheet-add') {
    scanner?.stop();
    const added = ui.add.session.filter(entry => !entry.undone);
    ui.add = { ...ui.add, pending: null, candidate: null, unknown: null, alts: [], qty: 1, session: [] };
    $('#add-query').value = '';
    $('#confirm').hidden = true;
    $('#sheet-add').classList.remove('has-confirm');
    if (added.length && !replaced) landAfterAdds(added);
  }
  if (id === 'sheet-form' && ui.form?.returnTo === 'add' && $('#sheet-add').open) {
    if (ui.add.mode === 'scan' && !ui.add.candidate) scanner?.resume();
  }
  if (id === 'sheet-find') {
    ui.find.open = null;
    if (ui.pack?.host === 'find') ui.pack = null;
  }
  if (id === 'sheet-item') {
    if (ui.pack?.host === 'item') ui.pack = null;
    if (!replaced) { ui.itemId = null; ui.itemCatalog = null; }
  }
}

// ---------------------------------------------------------------------------
// Messages. On the shelf a message is a receipt on the line above the dial (the slip), which is
// always there, so it never covers a control. Anywhere else it is a small toast that lets
// touches through everywhere but its buttons. Either way it can carry Undo and one or two
// next steps.

const notice = { timer: 0, el: null, undo: null, actions: [], kind: '', duration: 0, held: false };

function noticeHost() {
  if (openSheets.length) return { el: $('#toast'), parent: $(`#${openSheets.at(-1)}`) };
  if (ui.screen === 'screen-home' && !ui.guest && !$('#inv-dock').hidden) return { el: $('#slip'), parent: null };
  return { el: $('#toast'), parent: document.body };
}

function toast(message, { undo = null, undoLabel = 'Undo', duration = 3600, tone = '', actions = [], kind = '', remember = true } = {}) {
  hideToast({ keepRound: kind === 'round' });
  const { el, parent } = noticeHost();
  Object.assign(notice, { el, undo, actions, kind, duration: undo || actions.length ? Math.max(duration, 6000) : duration });
  if (undo && remember && kind !== 'round') ui.lastUndo = { label: message, undo };
  const buttons = actions.map((action, index) => `<button type="button" class="slip-btn${action.name ? ' is-name' : ''}" data-notice="${index}">${action.icon ? icon(action.icon) : ''}${esc(action.label)}</button>`).join('');
  if (el.id === 'slip') {
    el.innerHTML = `<span class="slip-text">${esc(message)}</span>${buttons}${undo ? `<button type="button" class="slip-btn" data-notice="undo">${esc(undoLabel)}</button>` : ''}`;
    el.classList.toggle('is-ok', tone === 'ok');
    el.hidden = false;
  } else {
    if (el.parentElement !== parent) parent.append(el);
    $('#toast-text').textContent = message;
    $('#toast-actions').innerHTML = buttons;
    const action = $('#toast-action');
    action.hidden = !undo;
    action.textContent = undoLabel;
    el.classList.toggle('is-ok', tone === 'ok');
    el.classList.add('is-visible');
  }
  armNotice();
}

function armNotice(ms = notice.duration) {
  clearTimeout(notice.timer);
  if (notice.held) return;
  notice.timer = setTimeout(() => hideToast(), ms);
}

function hideToast({ keepRound = false } = {}) {
  clearTimeout(notice.timer);
  $('#toast').classList.remove('is-visible');
  const slip = $('#slip');
  slip.hidden = true;
  slip.innerHTML = '';
  if (notice.kind === 'round' && !keepRound) ui.round = null;
  Object.assign(notice, { el: null, undo: null, actions: [], kind: '', held: false });
}

/** A button on the message was pressed. */
function runNotice(which) {
  if (which === 'undo') {
    const { undo, kind } = notice;
    if (!undo) return;
    if (ui.lastUndo?.undo === undo) ui.lastUndo = null;
    if (kind !== 'round') hideToast();
    if (undo() !== false) {
      hideToast();
      setTimeout(() => toast('Undone'), 120);
    }
    return;
  }
  const action = notice.actions[Number(which)];
  if (!action) return;
  if (!action.keep) hideToast();
  action.run();
}

/** Swap the receipt for a quick choice on the same line (who took it, how good was it). */
function slipChoice(html) {
  const slip = $('#slip');
  if (slip.hidden) return false;
  slip.innerHTML = html;
  armNotice(8000);
  return true;
}

/** Undo the last change again after its message has gone (the line at the top of Activity). */
function undoLastChange() {
  const last = ui.lastUndo;
  if (!last) return;
  ui.lastUndo = null;
  hideToast();
  if (last.undo() !== false) toast('Undone');
  if (ui.screen === 'screen-activity') renderActivity();
}

/** Two-tap confirmation for destructive buttons. The button says what the second tap will do. */
function armed(button, label, action) {
  const disarm = () => {
    button.dataset.armed = 'false';
    button.classList.remove('is-armed');
    button.innerHTML = button.dataset.original;
    if (button.dataset.originalLabel) button.setAttribute('aria-label', button.dataset.originalLabel);
  };
  if (button.dataset.armed === 'true') {
    disarm();
    action();
    return;
  }
  button.dataset.original = button.innerHTML;
  button.dataset.originalLabel = button.getAttribute('aria-label') || '';
  button.dataset.armed = 'true';
  button.classList.add('is-armed');
  button.textContent = label;
  if (button.dataset.originalLabel) button.setAttribute('aria-label', label);
  setTimeout(() => { if (button.isConnected && button.dataset.armed === 'true') disarm(); }, 3500);
}

// ---------------------------------------------------------------------------
// Routing: four faces for the owner, one for a guest. No face scrolls, so there is no
// position to lose on the way in or out.

function parseHash() {
  let raw = location.hash.slice(1);
  try { raw = decodeURIComponent(raw); } catch { /* keep the raw hash */ }
  const [route = '', query = ''] = raw.split('?');
  return { route, params: new URLSearchParams(query) };
}

function showScreen(id, { updateUrl = true, focus = false } = {}) {
  if (ui.guest) id = 'screen-menu';
  flushCount();
  if (ui.screen !== id) {
    ui.back = false;
    ui.pack = null;
    if (notice.el?.id === 'slip') hideToast();
  }
  ui.screen = id;
  $$('.screen').forEach(screen => {
    const on = screen.id === id;
    screen.classList.toggle('is-active', on);
    screen.inert = !on;
  });
  $$('.tab[data-screen]').forEach(tab => {
    const active = tab.dataset.screen === id;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.body.dataset.face = id.replace('screen-', '');
  if (updateUrl && !ui.guest) {
    const route = $(`#${id}`).dataset.route;
    history.replaceState(null, '', route ? `#${route}` : location.pathname + location.search);
  }
  renderScreen();
  if (focus) $(`#${id} h1`)?.focus({ preventScroll: true });
}

function renderScreen() {
  if (ui.guest) { renderMenu(); return; }
  renderStrip();
  if (ui.screen === 'screen-home') renderHome();
  if (ui.screen === 'screen-run') renderRun();
  if (ui.screen === 'screen-discover') renderDiscover();
  if (ui.screen === 'screen-activity') renderActivity();
}

/** The strip at the top of every face: how much is cold, and whether anything needs buying. */
function renderStrip() {
  const name = store.settings.fridgeName;
  $('#fridge-title').textContent = name;
  document.title = ui.screen === 'screen-home' ? name : `${FACE_NAME[ui.screen]} · ${name}`;
  const items = store.items;
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const kinds = items.filter(item => item.count > 0).length;
  const out = items.length - kinds;
  const low = lowStock(items, store.activity, store.settings.defaultPar).filter(({ item }) => item.count > 0).length;
  $('#hero-total').textContent = total;
  $('#hero-drinks').textContent = total === 1 ? 'drink' : 'drinks';
  $('#hero-sub').textContent = plural(kinds, 'kind');
  const alert = [low ? `${low} low` : '', out ? `${out} out` : ''].filter(Boolean).join(' · ');
  $('#glance-alert').textContent = alert ? ` · ${alert}` : '';
  $('#inv-out').setAttribute('aria-label', `${total} ${total === 1 ? 'drink' : 'drinks'}, ${plural(kinds, 'kind')}. ${alert ? `${low} running low, ${out} out of stock. ` : ''}Open the beer run`);
  const toGet = restockList().length + store.beerRun.length;
  const tab = $('#tab-run');
  tab.dataset.badge = toGet ? String(toGet) : '';
  tab.setAttribute('aria-label', toGet ? `Beer run, ${toGet} to get` : 'Beer run');
}

// ---------------------------------------------------------------------------
// Suggestions (cached per data version)

function suggestions() {
  const location = store.settings.location;
  // Drinks already on the beer run are not suggested again (except the ones just listed).
  const listed = store.beerRun.map(entry => entry.catalogId).filter(id => id && !ui.justListed.has(id));
  const key = [ui.version, catalogSize(), ui.breweries.length, location?.lat, location?.lng, store.settings.dismissed.length, listed.join(','), new Date().toDateString()].join('|');
  if (suggestionCache && key === suggestionKey) return suggestionCache;
  const ctx = buildContext({ items: store.items, activity: store.activity, location, breweries: ui.breweries, dismissed: store.settings.dismissed, listed });
  suggestionCache = { ctx, ...suggest(ctx, { items: store.items }) };
  suggestionKey = key;
  return suggestionCache;
}

// ---------------------------------------------------------------------------
// The shelf (Fridge): the cans, the drink in the middle, and everything you do to it.

function renderHome() {
  const items = store.items;
  // Out-of-stock drinks leave the shelf. They stay in the app, on the beer run, until restocked.
  const shelf = items.filter(item => item.count > 0);
  const lineup = lineups.inv;
  Object.assign(lineup, { type: 'all', group: 'all', query: '' }); // the shelf is never filtered
  organize(lineup, shelf, groupingSetting('invGroup'));
  const empty = ui.booting || !lineup.shown.length;
  $('#inv-dock').hidden = empty;
  $('#inv-coverflow').hidden = empty;
  const emptyEl = $('#inv-empty');
  emptyEl.hidden = !empty;
  if (empty) {
    ui.back = false;
    renderBack();
    const out = items.length;
    emptyEl.innerHTML = ui.booting
      ? emptyHtml('Loading your fridge…', 'One moment.')
      : out
        ? emptyHtml('Everything is out', `${out === 1 ? 'The one drink you had is' : `All ${out} drinks are`} on the beer run, ready to restock.`, '<button class="btn btn-small" type="button" data-go-run="1">See the beer run</button>')
        : emptyHtml('The fridge is empty', 'Scan a can or add a drink by name to get started.', `<div class="empty-actions"><button class="btn btn-small" type="button" data-open-add="scan">${icon('i-scan')}Scan the first drink</button><button class="btn btn-small btn-ghost" type="button" data-find="shelf">${icon('i-search')}Add by name</button></div>`);
    return;
  }
  renderFlow(lineup);
}

/** Under the cans: the drink in the middle, its dial, and its two verbs. */
function renderInvCaption() {
  const lineup = lineups.inv;
  const item = flowItem(lineup);
  if (!item) return;
  const low = item.count <= parOf(item);
  $('#inv-cap-info').innerHTML = captionHtml(lineup, item, low ? '<span class="cap-avail is-low">Low</span>' : '');
  syncCount(countCtls.inv, item);
  renderDockActions();
  renderBack();
}

function renderDockActions() {
  const item = flowItem(lineups.inv);
  const el = $('#inv-cap-actions');
  if (!item) { el.innerHTML = ''; return; }
  const key = `item:${item.id}`;
  if (ui.pack?.host === 'dock' && ui.pack.key === key) {
    el.innerHTML = packHtml(key);
    return;
  }
  el.innerHTML = `<button class="btn btn-amber take" type="button" data-take="${item.id}" aria-label="Take one ${esc(fullName(item))}, ${item.count} on hand">${icon('i-out')}Take one</button>
    <button class="btn btn-ghost" type="button" data-pack-open="dock" data-pack-key="${key}" aria-label="Stock in ${esc(fullName(item))}">${icon('i-in')}Stock in</button>`;
}

// ---------------------------------------------------------------------------
// The back of the can. Tap the can in the middle and its back label lies over the cans: what
// it is, who brews it, its rating and alert level, its last few ins and outs, and the rare
// tools. The dial, Take one and Stock in stay live underneath, and swiping on turns it back.

const MAKER_KIND = { micro: 'Craft brewery', nano: 'Small-batch brewery', brewpub: 'Brewpub', regional: 'Regional brewery', large: 'Large brewery', contract: 'Contract-brewed', taproom: 'Taproom brewery', cidery: 'Cidery', meadery: 'Meadery' };

function toggleBack() {
  if (ui.guest || !flowItem(lineups.inv)) return;
  ui.back = !ui.back;
  ui.backAbout = false;
  if (ui.back && ui.pack?.host === 'dock') { ui.pack = null; renderDockActions(); }
  renderBack();
}

function closeBack() {
  if (!ui.back) return;
  ui.back = false;
  renderBack();
}

function renderBack() {
  const el = $('#inv-back');
  const item = ui.back && !ui.guest ? flowItem(lineups.inv) : null;
  if (!item) ui.back = false;
  el.hidden = !item;
  $('#inv-more').setAttribute('aria-expanded', String(Boolean(item)));
  $('#screen-home .cans').classList.toggle('is-back', Boolean(item));
  el.innerHTML = item ? detailsHtml(item, { where: 'back' }) : '';
}

function breweryHtml(item, { open = false, button = true } = {}) {
  const maker = makerOf(item);
  if (!maker || !(maker.about || maker.founded || maker.url)) return '';
  const place = [maker.city, maker.state || (maker.country && maker.country !== 'US' ? maker.country : '')].filter(Boolean).join(', ');
  const home = store.settings.location;
  const miles = home && maker.lat != null && !ui.guest ? haversineMiles(home, maker) : null;
  const meta = [MAKER_KIND[maker.kind] || '', place, maker.founded ? `Since ${maker.founded}` : '', miles != null && miles <= 400 ? `${Math.max(1, Math.round(miles))} mi away` : ''].filter(Boolean).join(' · ');
  const url = /^https:\/\//i.test(maker.url || '') ? maker.url : '';
  const head = `${icon('i-pin')}<span><b>${esc(maker.name)}</b><small>${esc(meta)}</small></span>`;
  const more = open
    ? `${maker.about ? `<p class="d-about">${esc(maker.about)}</p>` : ''}${url && button ? `<a class="d-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon('i-globe')}${esc(new URL(url).hostname.replace(/^www\./, ''))}</a>` : ''}`
    : '';
  return button
    ? `<button class="d-brewery" type="button" data-back-about="1" aria-expanded="${open}">${head}${icon('i-right', ' class="d-chev"')}</button>${more}`
    : `<div class="d-brewery">${head}</div>${more}`;
}

const describe = item => (item.catalogId ? getCatalogItem(item.catalogId)?.desc : item.desc) || '';

function historyHtml(item, rows, { link = true } = {}) {
  const history = store.activity.filter(entry => entry.itemId === item.id).slice(0, rows);
  if (!history.length) return '';
  return `<div class="d-history"><p class="results-title">History${link ? `<button type="button" data-history="${item.id}">All history</button>` : ''}</p>${history.map(entry => `<div class="hist-row"><span class="hist-${entry.kind}">${entry.kind === 'in' || (entry.kind === 'adjust' && entry.qty > 0) ? '+' : '−'}${Math.abs(entry.qty)}</span><span>${entry.kind === 'in' ? 'Stocked' : entry.kind === 'out' ? `Taken${entry.by ? ` by ${esc(entry.by)}` : ''}` : 'Count corrected'}</span><time>${esc(entry.at ? relativeTime(entry.at) : entry.whenLabel || '')}</time></div>`).join('')}</div>`;
}

const starPicker = item => `<div class="star-picker" role="group" aria-label="Rate ${esc(fullName(item))}">${[1, 2, 3, 4, 5].map(stars => `<button type="button" data-rate="${item.id}" data-stars="${stars}" class="${item.ratingCount && stars <= Math.round(average(item)) ? 'is-on' : ''}" aria-label="${plural(stars, 'star')}">${icon('i-star')}</button>`).join('')}</div>`;

/**
 * What the back of a can says. `where` is 'back' (over the cans, for a drink on the shelf),
 * 'sheet' (the Details sheet, for a drink that is out of stock) or 'idea' (a catalog drink the
 * fridge does not have).
 */
function detailsHtml(item, { where = 'back' } = {}) {
  const desc = describe(item);
  const description = desc ? `<p class="d-desc">${esc(desc)}</p>` : '';
  if (where === 'idea') {
    const listed = store.beerRun.some(entry => entry.catalogId === item.id);
    const key = `cat:${item.id}`;
    return `${description}${breweryHtml(item, { open: true })}
      <div class="d-actions">${ui.pack?.host === 'item' && ui.pack.key === key
        ? packHtml(key)
        : `<button class="btn btn-ghost" type="button" data-cat-run="${esc(item.id)}" aria-pressed="${listed}">${icon(listed ? 'i-check' : 'i-list')}${listed ? 'On the list' : 'Beer run'}</button>
           <button class="btn" type="button" data-pack-open="item" data-pack-key="${esc(key)}">${icon('i-in')}Stock in</button>`}</div>`;
  }
  const about = where === 'sheet' || ui.backAbout;
  const rated = item.ratingCount ? `${average(item).toFixed(1)} (${item.ratingCount})` : 'Rate it';
  const rate = `<div class="d-row d-rate">${starPicker(item)}<span class="d-avg">${rated}</span></div>
    <div class="d-row d-alertrow">
      <div class="d-alert"><span>Low-stock alert at</span><div class="stepper" role="group" aria-label="Low-stock alert level"><button type="button" data-par-step="-1" data-par-id="${item.id}" aria-label="Lower">${icon('i-minus')}</button><output>${parOf(item)}</output><button type="button" data-par-step="1" data-par-id="${item.id}" aria-label="Higher">${icon('i-plus')}</button></div></div>
      ${where === 'back' ? `<button class="d-all" type="button" data-history="${item.id}">History${icon('i-right')}</button>` : ''}
    </div>`;
  const codes = `<p class="d-codes">${item.barcodes.length ? `Barcode${item.barcodes.length > 1 ? 's' : ''}: ${item.barcodes.map(displayCode).join(', ')}` : 'No barcode linked yet. Scan it once and it will be remembered.'}</p>`;
  const name = esc(fullName(item));
  if (where === 'sheet') {
    const key = `item:${item.id}`;
    return `<p class="item-status">Out of stock, on the beer run</p>
      <div class="d-actions">${ui.pack?.host === 'item' && ui.pack.key === key
        ? packHtml(key)
        : `<button class="btn" type="button" data-pack-open="item" data-pack-key="${key}">${icon('i-in')}Got it</button>
           <button class="btn btn-ghost" type="button" data-edit="${item.id}">${icon('i-edit')}Edit</button>
           <button class="btn btn-ghost btn-danger" type="button" data-delete="${item.id}" aria-label="Delete ${name}">Delete</button>`}</div>
      ${description}${breweryHtml(item, { open: true })}${rate}${historyHtml(item, 5)}${codes}`;
  }
  return `${about ? '' : description}${breweryHtml(item, { open: about })}${about ? '' : `${rate}${historyHtml(item, 3, { link: false })}${codes}`}
    <div class="d-actions">
      <button class="btn btn-ghost" type="button" data-edit="${item.id}">Edit</button>
      <button class="btn btn-ghost" type="button" data-item-run="${item.id}">Beer run</button>
      <button class="btn btn-ghost" type="button" data-mark-out="${item.id}">Out of stock</button>
      <button class="btn btn-ghost btn-danger d-trash" type="button" data-delete="${item.id}" aria-label="Delete ${name}">${icon('i-trash')}</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Take one: one tap is a real check-out, written to the ledger as taken. The receipt offers
// Undo, who took it and a rating; nothing has to be answered, and nothing has to be closed.
// Takes made while the receipt is still up are one round.

function takeOne(id) {
  const item = findItem(id);
  if (!item || ui.guest || item.count < 1 || performance.now() < ui.tapGuard) return;
  flushCount();
  if (ui.pack) ui.pack = null;
  if (item.count === 1) leaveShelf(id); // the last one: the neighbour slides in
  const round = ui.round || { takes: [], by: '' };
  const name = fullName(item);
  const { entries, undo } = checkout([{ id, qty: 1 }], { by: round.by });
  if (!entries.length) return;
  round.takes.push({ entryId: entries[0].entry.id, itemId: id, name, qty: 1, undo });
  ui.round = round;
  showReceipt();
}

/** The dial went down by one or two and it was a drink, not a miscount: log it as taken. */
function logAsTaken(id, qty, adjusted) {
  adjusted.undo();
  const item = findItem(id);
  if (!item) return;
  if (item.count <= qty) leaveShelf(id);
  const name = fullName(item);
  const { entries, undo } = checkout([{ id, qty }], { by: '' });
  if (!entries.length) return;
  ui.round = { takes: [{ entryId: entries[0].entry.id, itemId: id, name, qty, undo }], by: '' };
  showReceipt();
}

function showReceipt() {
  const round = ui.round;
  if (!round?.takes.length) return;
  const last = round.takes.at(-1);
  const item = findItem(last.itemId);
  const left = !item ? '' : item.count ? `${item.count} left` : 'the last one';
  const total = round.takes.reduce((sum, take) => sum + take.qty, 0);
  const text = [
    round.takes.length > 1 ? `Round of ${total} · last: ${last.name}` : `Took ${last.qty} × ${last.name}`,
    round.takes.length > 1 ? '' : left,
    last.rated ? `${last.rated} ★` : '',
  ].filter(Boolean).join(' · ');
  // Undo peels back one take at a time, never the whole round at once.
  const peel = () => {
    const take = round.takes.pop();
    if (!take) { ui.lastUndo = null; return false; }
    lineups.inv.flowId = take.itemId; // back to where it stood
    take.undo();
    if (!round.takes.length) {
      ui.lastUndo = null;
      if (ui.round === round) ui.round = null;
      hideToast();
      toast(`Put back: ${take.name}`);
    } else if (ui.round === round) {
      showReceipt();
    } else {
      toast(`Put back: ${take.name}`);
    }
    return false;
  };
  ui.lastUndo = { label: text, undo: peel };
  toast(text, {
    kind: 'round',
    tone: 'ok',
    duration: 8000,
    undo: peel,
    undoLabel: round.takes.length > 1 ? 'Undo last' : 'Undo',
    actions: [
      { label: round.by || 'Who?', name: Boolean(round.by), keep: true, run: showWho },
      ...(last.rated ? [] : [{ label: 'Rate', icon: 'i-star', keep: true, run: showStars }]),
    ],
  });
}

function showWho() {
  const round = ui.round;
  if (!round) return;
  const names = store.settings.recentNames.slice(0, 3);
  const shown = slipChoice(`<span class="slip-text">Who?</span>${names.map(name => `<button type="button" class="slip-btn is-name" data-round-by="${esc(name)}">${esc(name)}</button>`).join('')}<button type="button" class="slip-btn" data-round-other="1">${names.length ? 'Other' : 'Add a name'}</button>`);
  if (!shown) openWho(round.takes.map(take => take.entryId));
}

function showStars() {
  const take = ui.round?.takes.at(-1);
  if (!take) return;
  slipChoice(`<span class="slip-text">Rate ${esc(take.name)}</span><span class="slip-stars" role="group" aria-label="Rate ${esc(take.name)}">${[1, 2, 3, 4, 5].map(stars => `<button type="button" data-round-star="${stars}" aria-label="${plural(stars, 'star')}">${icon('i-star')}</button>`).join('')}</span>`);
}

function nameRound(by) {
  const round = ui.round;
  if (!round || !by) return;
  nameCheckout(round.takes.map(take => take.entryId), by);
  round.by = by;
  showReceipt();
}

function rateRound(stars) {
  const take = ui.round?.takes.at(-1);
  if (!take) return;
  if (rateItem(take.itemId, stars)) take.rated = stars;
  showReceipt();
}

/** A name that is not one of the recent ones: the only time a name needs a keyboard. */
function openWho(entryIds) {
  ui.who = { entryIds };
  $('#order-by').value = '';
  openSheet('sheet-who');
  $('#order-by').focus();
}

function saveWho(event) {
  event.preventDefault();
  const by = $('#order-by').value.trim();
  const who = ui.who;
  ui.who = null;
  closeSheet('sheet-who', {
    then: () => {
      if (!by || !who) return;
      nameCheckout(who.entryIds, by);
      if (ui.round && ui.screen === 'screen-home') { ui.round.by = by; showReceipt(); }
      else toast(`Saved: taken by ${by}`);
    },
  });
}

// ---------------------------------------------------------------------------
// "How many?" in place: Stock in, Got it and Stock turn into 1 · 4 · 6 · 12 · 24 right where
// they were pressed, and one more tap stocks that many. No sheet for a drink the app knows.

const fromItem = item => ({ ...item, itemId: item.id });

function fromCatalog(catalogItem) {
  const existing = findSame({ catalogId: catalogItem.id, name: catalogItem.name, brand: catalogItem.brand });
  return {
    itemId: existing?.id || null,
    catalogId: catalogItem.id,
    name: catalogItem.name,
    brand: catalogItem.brand,
    type: catalogItem.type,
    style: catalogItem.style,
    abv: catalogItem.abv,
    size: existing?.size || catalogItem.size || TYPE_META[catalogItem.type]?.size || '',
    city: catalogItem.city,
    state: catalogItem.state,
    country: catalogItem.country,
    lat: catalogItem.lat,
    lng: catalogItem.lng,
  };
}

/** What a picker key points at: an owned drink, a catalog drink or a line on the beer run. */
function packTarget(key) {
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (kind === 'item') {
    const item = findItem(id);
    return item ? { candidate: fromItem(item), preset: { item } } : null;
  }
  if (kind === 'cat') {
    const catalogItem = getCatalogItem(id);
    return catalogItem ? { candidate: fromCatalog(catalogItem), preset: { catalogItem } } : null;
  }
  const entry = store.beerRun.find(run => run.id === id);
  if (!entry) return null;
  const catalogItem = entry.catalogId && getCatalogItem(entry.catalogId);
  const item = entry.itemId && findItem(entry.itemId);
  if (catalogItem) return { candidate: fromCatalog(catalogItem), preset: { catalogItem } };
  if (item) return { candidate: fromItem(item), preset: { item } };
  const type = inferType(entry.name) || 'Beer';
  return { candidate: { itemId: null, name: entry.name, brand: entry.brand, type, style: entry.style || inferStyle(entry.name, type), size: TYPE_META[type]?.size || '' }, preset: { query: entry.name } };
}

/** The pack this drink last came in as, to ring on the picker. */
function usualPack(key) {
  if (!key.startsWith('item:')) return 0;
  const id = key.slice(5);
  return store.activity.find(entry => entry.kind === 'in' && entry.itemId === id)?.qty || 0;
}

function packHtml(key) {
  const usual = usualPack(key);
  // Cancel sits at the right, where Stock in was: a second tap on the same spot does nothing.
  return `<div class="pack" role="group" aria-label="How many to add">${PACKS.map(qty => `<button type="button" class="pack-chip${qty === usual ? ' is-usual' : ''}" data-pack-qty="${qty}" data-pack-key="${esc(key)}" aria-label="Add ${qty}">${qty}</button>`).join('')}<button type="button" class="pack-chip pack-other" data-pack-other="${esc(key)}">Other</button><button type="button" class="pack-chip pack-cancel" data-pack-cancel="1" aria-label="Cancel"><span>Cancel</span>${icon('i-x')}</button></div>`;
}

function renderPackHost(host) {
  if (host === 'dock') renderDockActions();
  if (host === 'run' && ui.screen === 'screen-run') renderRun();
  if (host === 'card' && ui.screen === 'screen-discover') renderDiscover();
  if (host === 'find' && $('#sheet-find').open) renderFind();
  if (host === 'item' && $('#sheet-item').open) renderItemSheet();
}

function openPack(host, key) {
  if (ui.guest) return;
  const before = ui.pack?.host;
  if (ui.pack?.host === host && ui.pack.key === key) { closePack(); return; } // the same button again puts it away
  ui.pack = { host, key };
  ui.packAt = performance.now();
  if (host === 'dock' && ui.back) closeBack();
  if (before && before !== host) renderPackHost(before);
  renderPackHost(host);
}

function closePack() {
  if (!ui.pack) return;
  const { host } = ui.pack;
  ui.pack = null;
  ui.tapGuard = performance.now() + 350; // a late second tap must not land on Take one
  renderPackHost(host);
}

/** Stock a drink the app already knows: the ledger line, the catalog link, the beer-run check-off. */
function stockCandidate(candidate, qty, pending = {}) {
  flushCount();
  const data = candidate.itemId ? { id: candidate.itemId } : { ...candidate };
  const result = stockIn(data, qty, pending);
  if (candidate.catalogId && !result.item.catalogId) {
    const catalogItem = getCatalogItem(candidate.catalogId);
    if (catalogItem) { linkCatalog(result.item, catalogItem); persist('link'); }
  }
  return result;
}

const addedText = (result, qty) => `Added ${qty} × ${fullName(result.item)}${result.checkedOff ? ' · checked off the beer run' : ''}${result.eased != null ? ` · low-stock alert now at ${result.eased}` : ''}`;

function commitPack(key, qty) {
  // A double tap on the button that opened the picker lands here too early to be a choice.
  if (!ui.pack || ui.pack.key !== key || performance.now() - ui.packAt < 350) return;
  const { host } = ui.pack;
  const target = packTarget(key);
  ui.pack = null;
  ui.tapGuard = performance.now() + 350;
  if (!target) { renderPackHost(host); return; }
  const result = stockCandidate(target.candidate, qty);
  const text = addedText(result, qty);
  const id = result.item.id;
  if (host === 'find') {
    closeSheet('sheet-find', { then: () => landOnShelf(id, text, { undo: result.undo }) });
    return;
  }
  if (host === 'dock') lineups.inv.flowId = id;
  const tell = () => toast(text, { undo: result.undo, tone: 'ok', actions: host === 'dock' ? [] : [{ label: 'Show', run: () => showDrink(id) }] });
  if (host === 'item') closeSheet('sheet-item', { then: tell });
  else { renderPackHost(host); tell(); }
}

/** An odd amount: the scanner sheet's own card, with its stepper, opened on this drink. */
function packOther(key) {
  const target = packTarget(key);
  const host = ui.pack?.host;
  ui.pack = null;
  if (host) renderPackHost(host);
  if (target) openAdd('search', target.preset, 'preset');
}

/** Put the shelf on a drink. A drink that is out of stock lives on the beer run instead. */
function showDrink(itemId) {
  const item = findItem(itemId);
  if (!item || ui.guest) return;
  if (item.count < 1) {
    if (ui.screen !== 'screen-run') showScreen('screen-run', { focus: true });
    return;
  }
  const lineup = lineups.inv;
  if (ui.screen !== 'screen-home') {
    lineup.flowId = itemId;
    showScreen('screen-home');
    return;
  }
  const index = lineup.shown.findIndex(entry => entry.id === itemId);
  if (index >= 0 && lineup.flow) lineup.flow.goTo(index); // glide there: "here it is"
  else { lineup.flowId = itemId; renderHome(); }
}

/** Every add, find and edit ends here: on the shelf, on the drink it touched, with its receipt. */
function landOnShelf(itemId, message = '', { undo = null, undoLabel = 'Undo', tone = 'ok' } = {}) {
  showDrink(itemId);
  if (message) setTimeout(() => toast(message, { undo, undoLabel, tone }), 80);
}

function landAfterAdds(added) {
  const last = added[0];
  const units = added.reduce((sum, entry) => sum + entry.qty, 0);
  const drinks = new Set(added.map(entry => entry.itemId)).size;
  const message = added.length > 1 ? `${plural(drinks, 'drink')} added, ${units} cans and bottles` : last.text;
  landOnShelf(last.itemId, message, { undo: last.undo, undoLabel: added.length > 1 ? 'Undo last' : 'Undo' });
}

// ---------------------------------------------------------------------------
// Guest menu: a read-only copy of the shelf for a shared link. Nothing to open, nothing that
// pretends to order.

function renderMenu() {
  const available = ui.guest.items.filter(item => item.count > 0);
  $('#guest-name').textContent = ui.guest.name;
  $('#guest-when').textContent = `Menu · shared ${relativeTime(ui.guest.at).toLowerCase()}`;
  const lineup = lineups.menu;
  Object.assign(lineup, { type: 'all', group: 'all', query: '' });
  organize(lineup, available, groupingSetting('menuGroup'));
  const empty = !lineup.shown.length;
  $('#menu-dock').hidden = empty;
  $('#menu-coverflow').hidden = empty;
  $('#menu-empty').hidden = !empty;
  $('#menu-find-text').textContent = `See all ${available.length}`;
  // Only someone who keeps a fridge of their own on this device gets a way back to it.
  $('#guest-home').hidden = !store.items.some(item => !/^demo-\d+$/.test(item.id));
  if (empty) {
    $('#menu-empty').innerHTML = emptyHtml('Nothing cold yet', 'The host hasn’t stocked anything in this snapshot.');
    return;
  }
  renderFlow(lineup);
}

function renderGuestCaption() {
  const lineup = lineups.menu;
  const item = flowItem(lineup);
  if (!item) return;
  $('#menu-caption').innerHTML = captionHtml(lineup, item, `<span class="cap-avail">${item.count} cold</span>`);
  const desc = describe(item);
  $('#menu-story').innerHTML = `${desc ? `<p class="d-desc">${esc(desc)}</p>` : ''}${breweryHtml(item, { open: true, button: false })}`;
}

// ---------------------------------------------------------------------------
// Beer run: the shopping list, and the home of every drink that is out of stock.

/**
 * What the beer run lists on its own: every drink that is out, then what is running low.
 * Out-of-stock drinks are hidden from the shelf, so this list is where they live until
 * they are restocked or deleted.
 */
function restockList() {
  const saved = new Set(store.beerRun.map(entry => entry.itemId).filter(Boolean));
  const out = store.items.filter(item => item.count === 0).map(item => ({ item, taken: 0 }));
  const low = lowStock(store.items, store.activity, store.settings.defaultPar).filter(({ item }) => item.count > 0);
  return [...out, ...low].filter(({ item }) => !saved.has(item.id));
}

const entryName = entry => (entry.brand && !fold(entry.name).includes(fold(entry.brand).split(' ')[0]) ? `${entry.brand} ${entry.name}` : entry.name);

function runRow({ key, name, status, dot = '', opens = true, remove = '' }) {
  const open = ui.pack?.host === 'run' && ui.pack.key === key;
  const label = `<b>${esc(name)}</b><small>${esc(status)}</small>`;
  return `<div class="run-row${open ? ' is-open' : ''}">
      <span class="run-dot ${dot}" aria-hidden="true"></span>
      ${opens ? `<button class="run-name" type="button" data-run-open="${esc(key)}" aria-label="${esc(name)}, ${esc(status)}. Open">${label}</button>` : `<div class="run-name">${label}</div>`}
      <button class="mini-btn mini-primary" type="button" data-pack-open="run" data-pack-key="${esc(key)}" aria-expanded="${open}" aria-label="Got it: ${esc(name)}">Got it</button>
      ${remove ? `<button class="icon-btn icon-btn-small" type="button" data-run-remove="${esc(remove)}" aria-label="Remove ${esc(name)} from the list">${icon('i-x')}</button>` : '<span></span>'}
      ${open ? packHtml(key) : ''}
    </div>`;
}

function renderRun() {
  const auto = restockList();
  const out = auto.filter(({ item }) => item.count === 0);
  const low = auto.filter(({ item }) => item.count > 0);
  const saved = store.beerRun;
  const total = auto.length + saved.length;
  $('#run-count').textContent = total ? `${total} to get` : '';
  const section = (title, rows) => (rows.length ? `<h2 class="run-head">${title}<span>${rows.length}</span></h2>${rows.join('')}` : '');
  const list = $('#run-list');
  const top = $('#run-panel').scrollTop;
  list.innerHTML = total
    ? section('Out of stock', out.map(({ item }) => runRow({ key: `item:${item.id}`, name: fullName(item), status: 'Out of stock' })))
      + section('Running low', low.map(({ item }) => runRow({ key: `item:${item.id}`, name: fullName(item), status: `${item.count} left`, dot: 'run-low' })))
      + section('On the list', saved.map(entry => runRow({ key: `run:${entry.id}`, name: entryName(entry), status: entry.style || 'On the list', dot: 'run-saved', opens: Boolean((entry.itemId && findItem(entry.itemId)) || (entry.catalogId && getCatalogItem(entry.catalogId))), remove: entry.id })))
    : `<div class="run-empty">${icon('i-check')}<b>Nothing to get</b><p>Drinks that run low or run out land here by themselves.</p><button class="btn btn-small btn-ghost" type="button" data-screen="screen-discover">See suggestions</button></div>`;
  $('#run-panel').scrollTop = top;
  $('#run-share').hidden = !total;
  // One idea under the list: the beer run and the suggestions are one loop.
  const idea = catalogSize() ? suggestions().top.find(entry => !saved.some(run => run.catalogId === entry.item.id)) : null;
  const ideaEl = $('#run-idea');
  ideaEl.hidden = !idea;
  ideaEl.innerHTML = idea
    ? `<p><b>Idea:</b> ${esc(idea.item.fullName)}${idea.reason ? ` · ${esc(idea.reason)}` : ''}</p><button class="mini-btn" type="button" data-cat-run="${esc(idea.item.id)}" aria-label="Add ${esc(idea.item.fullName)} to the beer run">${icon('i-plus')}List</button>`
    : '';
}

function beerRunText() {
  const low = restockList();
  const lines = [
    ...low.map(({ item }) => `• ${fullName(item)}${item.count === 0 ? ' (out)' : ` (${item.count} left)`}`),
    ...store.beerRun.map(entry => `• ${entryName(entry)}`),
  ];
  return `Beer run for ${store.settings.fridgeName}:\n${lines.join('\n')}`;
}

/** Put a catalog drink on the beer run, or take it off again (the List button is a toggle). */
function toggleListed(catalogId) {
  const item = getCatalogItem(catalogId);
  if (!item) return;
  const entry = store.beerRun.find(run => run.catalogId === catalogId);
  if (entry) {
    removeFromBeerRun(entry.id);
    ui.justListed.delete(catalogId);
    toast(`${item.fullName} is off the beer run`);
    return;
  }
  ui.justListed.add(catalogId); // it stays in view, marked, instead of vanishing under the finger
  addToBeerRun({ catalogId: item.id, name: item.name, brand: item.brand, style: item.style });
  toast(`${item.fullName} is on the beer run`, { tone: 'ok', actions: ui.screen === 'screen-run' ? [] : [{ label: 'Beer run', run: () => showScreen('screen-run', { focus: true }) }] });
}

// ---------------------------------------------------------------------------
// Discover: one kind of suggestion at a time, as one sideways row of cards.

const GAP_CHIP = { na: 'No alcohol', easy: 'Easy drinking', variety: 'Variety', 'non-beer': 'Not beer' };

function pickCard(entry) {
  const item = entry.item;
  const key = `cat:${item.id}`;
  const listed = store.beerRun.some(run => run.catalogId === item.id);
  const picking = ui.pack?.host === 'card' && ui.pack.key === key;
  return `<article class="pick">
    <button class="pick-art" type="button" data-cat-open="${esc(item.id)}" aria-label="About ${esc(item.fullName)}">${art(item)}</button>
    <div class="pick-body">
      <p class="pick-reason">${esc(entry.reason || '')}</p>
      <p class="brand-line">${esc(item.brand)}</p>
      <h3>${esc(item.name)}</h3>
      <p class="pick-meta">${esc(metaLine(item, { size: false }))}</p>
    </div>
    <div class="pick-actions">${picking ? packHtml(key) : `
      <button class="mini-btn" type="button" data-cat-run="${esc(item.id)}" aria-pressed="${listed}" aria-label="${listed ? `${esc(item.fullName)} is on the beer run. Take it off` : `Add ${esc(item.fullName)} to the beer run`}">${icon(listed ? 'i-check' : 'i-list')}${listed ? 'On the list' : 'List'}</button>
      <button class="mini-btn mini-primary" type="button" data-pack-open="card" data-pack-key="${esc(key)}" aria-label="Stock ${esc(item.fullName)}">${icon('i-plus')}Stock</button>`}
    </div>
    <button class="pick-x" type="button" data-cat-dismiss="${esc(item.id)}" aria-label="Hide ${esc(item.fullName)}">${icon('i-x')}</button>
  </article>`;
}

function locationCard() {
  const location = store.settings.location;
  return `<section class="loc-card" aria-label="Fridge location">
      <div class="loc-row">
        <span class="loc-icon">${icon('i-pin')}</span>
        <div class="loc-text"><b>${location ? esc(location.label) : 'Set the fridge’s home base'}</b><span>See breweries near you and beers brewed in your state.</span></div>
      </div>
      <form class="loc-form" data-loc-form>
        <label class="search-field">${icon('i-pin')}<input placeholder="ZIP code or city" autocomplete="postal-code" enterkeyhint="go" aria-label="ZIP code or city" data-loc-input /></label>
        <button class="btn btn-small" type="submit">Set</button>
        <button class="btn btn-small btn-ghost" type="button" data-loc-device="1">${icon('i-locate')}Use my location</button>
        ${location ? '<button class="text-btn" type="button" data-loc-cancel="1">Cancel</button>' : ''}
      </form>
      <p class="form-note" data-loc-status aria-live="polite"></p>
    </section>`;
}

function breweryCards() {
  const all = ui.breweries;
  if (ui.breweriesLoading && !all.length) return '<div class="discover-note"><p>Finding breweries…</p></div>';
  const shown = all.slice(0, ui.breweriesShown);
  const more = all.length - shown.length;
  return `<div class="h-scroll">${shown.map(brewery => `<article class="brewery-card">
      <div class="brewery-top">
        <div><b>${esc(brewery.name)}</b><span>${esc(brewery.typeLabel)} · ${esc(brewery.city)}${brewery.state ? `, ${esc(brewery.state)}` : ''}</span></div>
        <span class="miles">${brewery.miles < 1 ? '<1' : Math.round(brewery.miles)} mi</span>
      </div>
      ${brewery.beers.length ? `<div class="brewery-beers">${brewery.beers.map(beer => `<button class="beer-chip" type="button" data-cat-open="${esc(beer.id)}"><i class="dot" style="background:${familyColor(beer.type, beer.family)}"></i>${esc(beer.name)}</button>`).join('')}</div>` : ''}
      <div class="brewery-actions">
        <button class="mini-btn" type="button" data-brewery-add="${esc(brewery.id)}">${icon('i-plus')}Add a beer from here</button>
        ${/^https?:\/\//i.test(brewery.url) ? `<a class="mini-btn" href="${esc(brewery.url)}" target="_blank" rel="noopener noreferrer">${icon('i-globe')}Website</a>` : ''}
      </div>
    </article>`).join('')}${more > 0 ? `<button class="more-card" type="button" data-more-breweries="1">Show ${more} more</button>` : ''}</div>`;
}

function discoverPanels() {
  const location = store.settings.location;
  const data = suggestions();
  const { ctx } = data;
  const panels = [];
  if (ctx.occasion && data.occasion.length) panels.push({ key: 'occasion', chip: ctx.occasion.label, eyebrow: 'Right now', title: ctx.occasion.label, blurb: ctx.occasion.blurb, picks: data.occasion });
  data.gaps.forEach(gap => panels.push({ key: `gap:${gap.id}`, chip: GAP_CHIP[gap.id] || gap.title, eyebrow: 'Fill a gap', title: gap.title, blurb: gap.blurb, picks: gap.picks }));
  panels.push({ key: 'foryou', chip: 'For you', eyebrow: 'Smart suggest', title: 'Picked for this fridge', blurb: data.favorites.length ? `Because you like ${data.favorites.slice(0, 2).join(' and ')}.` : 'Based on ratings, checkouts and the season.', picks: data.forYou, none: 'Rate a few drinks to get personal picks.' });
  panels.push({
    key: 'near',
    chip: 'Near you',
    eyebrow: 'Close to home',
    title: location ? `Brewed near ${location.city || 'you'}` : 'Brewed near you',
    blurbHtml: location ? `Home base: ${esc(location.label)}<button class="text-btn" type="button" data-loc-change="1">Change</button>` : 'Set a home base to see what is brewed nearby.',
    picks: data.local,
    setup: !location || ui.locOpen,
    none: 'Nothing from the catalog is brewed near this home base yet.',
  });
  if (location && (ui.breweries.length || ui.breweriesLoading)) {
    const status = ui.breweriesLoading ? 'Finding breweries nearby…' : `${plural(ui.breweries.length, 'brewery', 'breweries')} within 80 miles`;
    panels.push({ key: 'breweries', chip: 'Breweries', eyebrow: 'Within driving distance', title: 'Breweries near you', blurbHtml: `${status} · data: <a href="https://www.openbrewerydb.org/" target="_blank" rel="noopener">Open Brewery DB</a>`, breweries: true });
  }
  const season = SEASON_LABEL[currentSeason()];
  panels.push({ key: 'seasonal', chip: season, eyebrow: 'Seasonal', title: `${season} picks`, blurb: 'In season now.', picks: data.seasonal });
  return panels;
}

function renderDiscover() {
  const panelEl = $('#discover-panel');
  const chips = $('#discover-chips');
  if (!catalogSize()) {
    $('#discover-eyebrow span').textContent = 'Smart suggest';
    $('#discover-title').textContent = 'Discover';
    $('#discover-blurb').textContent = '';
    chips.innerHTML = '';
    panelEl.innerHTML = `<div class="discover-note"><p>${catalogReady() ? 'The drink catalog couldn’t load. Check your connection and reload.' : 'Loading the drink catalog…'}</p></div>`;
    return;
  }
  const panels = discoverPanels();
  const panel = panels.find(entry => entry.key === ui.discover) || panels[0];
  ui.discover = panel.key;
  $('#discover-eyebrow span').textContent = panel.eyebrow;
  $('#discover-title').textContent = panel.title;
  if (panel.blurbHtml) $('#discover-blurb').innerHTML = panel.blurbHtml;
  else $('#discover-blurb').textContent = panel.blurb || '';
  const chipLeft = chips.scrollLeft;
  chips.innerHTML = panels.map(entry => `<button type="button" class="chip${entry.key === panel.key ? ' is-current' : ''}" data-discover="${esc(entry.key)}" aria-pressed="${entry.key === panel.key}">${esc(entry.chip)}</button>`).join('');
  chips.scrollLeft = chipLeft;
  // The home-base form keeps what is being typed across a re-render.
  const typed = $('[data-loc-input]', panelEl)?.value || '';
  panelEl.innerHTML = panel.setup
    ? locationCard()
    : panel.breweries
      ? breweryCards()
      : panel.picks.length
        ? `<div class="h-scroll">${panel.picks.map(pickCard).join('')}</div>`
        : `<div class="discover-note"><p>${esc(panel.none || 'Nothing to suggest here right now.')}</p></div>`;
  if (typed && $('[data-loc-input]', panelEl)) $('[data-loc-input]', panelEl).value = typed;
  const scroller = $('.h-scroll', panelEl);
  if (scroller) scroller.scrollLeft = ui.discoverScroll[panel.key] || 0;
}

async function setLocation(promise, statusText, form) {
  const status = form?.parentElement.querySelector('[data-loc-status]');
  if (status) status.textContent = statusText;
  try {
    const location = await promise;
    ui.locOpen = false;
    $('#s-loc-box').hidden = true;
    updateSettings({ location });
    $('#s-loc').textContent = location.label;
    toast(`Home base set to ${location.label}`, { tone: 'ok' });
    await refreshBreweries(true);
  } catch (error) {
    if (status?.isConnected) status.textContent = error.message || 'Couldn’t set the location.';
    else toast(error.message || 'Couldn’t set the location.');
  }
}

async function refreshBreweries(force = false) {
  const location = store.settings.location;
  if (!location) return;
  ui.breweriesLoading = true;
  ui.breweriesError = false;
  if (ui.screen === 'screen-discover') renderDiscover();
  try {
    ui.breweries = await fetchBreweries(location, { force });
  } catch {
    ui.breweriesError = true;
  }
  ui.breweriesLoading = false;
  ui.version += 1;
  // Only Discover shows breweries; redrawing another face here would close an open picker.
  if (ui.screen === 'screen-discover') renderDiscover();
}

// ---------------------------------------------------------------------------
// Activity: the ledger, this week's totals, and a way back to any drink.

function renderActivity() {
  const week = Date.now() - 7 * 86400000;
  const inWeek = entry => entry.at && new Date(entry.at).getTime() >= week;
  const recent = store.activity.filter(inWeek);
  const sum = kind => recent.filter(entry => entry.kind === kind).reduce((total, entry) => total + entry.qty, 0);
  const tally = key => {
    const counts = {};
    recent.filter(entry => entry.kind === 'out' && entry[key]).forEach(entry => { counts[entry[key]] = (counts[entry[key]] || 0) + entry.qty; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  };
  const topDrink = tally('name');
  const topPerson = tally('by');
  $('#act-summary').textContent = topDrink ? `Most popular: ${topDrink[0]}${topPerson ? ` · top grabber: ${topPerson[0]} (${topPerson[1]})` : ''}` : 'Every drink in and out.';
  const tile = (value, label, figure, tone = '') => `<button class="stat" type="button" data-act-filter="${value}" aria-pressed="${ui.actFilter === value}"><span>${label}</span><b class="${tone}">${figure}</b></button>`;
  $('#act-stats').innerHTML = tile('all', 'Everything', store.activity.length) + tile('in', 'In this week', `+${sum('in')}`, 'stat-in') + tile('out', 'Out this week', `−${sum('out')}`, 'stat-out');

  // Undo is not only a six-second button: the last change can still be taken back here.
  const undoEl = $('#act-undo');
  undoEl.hidden = !ui.lastUndo;
  undoEl.innerHTML = ui.lastUndo ? `<span>${esc(ui.lastUndo.label)}</span><button class="btn btn-small btn-ghost" type="button" data-undo-last="1">${icon('i-undo')}Undo</button>` : '';

  // The latest round keeps its questions open: who took it, and how was it.
  const twoHours = Date.now() - 2 * 3600000;
  const round = ui.actItem ? [] : store.activity.filter(entry => entry.kind === 'out' && entry.at && new Date(entry.at).getTime() >= twoHours).slice(0, 4);
  const names = store.settings.recentNames.slice(0, 3);
  const roundEl = $('#act-round');
  roundEl.hidden = !round.length;
  roundEl.innerHTML = round.length ? `<p class="results-title">Latest round</p>${round.map(entry => {
    const item = entry.itemId && findItem(entry.itemId);
    return `<div class="round-row">
        <b>${entry.qty > 1 ? `${entry.qty} × ` : ''}${esc(entry.name)}</b>
        <time datetime="${entry.at}">${esc(relativeTime(entry.at))}${entry.by ? ` · ${esc(entry.by)}` : ''}</time>
        ${item ? starPicker(item) : '<span></span>'}
        <div class="round-names">${names.filter(name => name !== entry.by).slice(0, 2).map(name => `<button type="button" class="chip" data-entry-by="${entry.id}" data-by="${esc(name)}">${esc(name)}</button>`).join('')}<button type="button" class="chip" data-entry-other="${entry.id}">${entry.by ? 'Change' : 'Who?'}</button></div>
      </div>`;
  }).join('')}` : '';

  const list = $('#activity-list');
  if (!store.activity.length) {
    list.innerHTML = emptyHtml('No activity yet', 'Stock-ins and checkouts will show up here.');
    return;
  }
  const drink = ui.actItem && findItem(ui.actItem);
  if (ui.actItem && !drink) ui.actItem = null;
  let entries = store.activity.slice(0, 250);
  if (drink) entries = store.activity.filter(entry => entry.itemId === drink.id).slice(0, 250);
  if (ui.actFilter !== 'all') entries = entries.filter(entry => entry.kind === ui.actFilter && inWeek(entry));
  const groups = [];
  entries.forEach(entry => {
    const label = entry.at ? dayLabel(entry.at) : 'Earlier';
    const group = groups.at(-1);
    if (group?.label === label) group.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  });
  const glyph = { in: 'i-in', out: 'i-out', adjust: 'i-edit' };
  const filterLine = drink ? `<div class="act-filter"><span class="chip is-active">${esc(fullName(drink))} only</span><button class="text-btn" type="button" data-act-clear="1">Show everything</button></div>` : '';
  list.innerHTML = filterLine + (groups.length ? groups.map(group => `<h3 class="day-label">${esc(group.label)}</h3>
    ${group.entries.map(entry => {
      const verb = entry.kind === 'in' ? `Stocked ${entry.qty}` : entry.kind === 'out' ? `Took ${entry.qty}` : `Count ${entry.qty > 0 ? '+' : '−'}${Math.abs(entry.qty)}`;
      const sub = entry.kind === 'out' ? (entry.by ? `by ${entry.by}` : 'Checked out') : entry.kind === 'in' ? 'Added to the fridge' : 'Count corrected';
      const body = `<span class="act-icon">${icon(glyph[entry.kind] || 'i-edit')}</span>
        <span class="act-text"><b>${esc(verb)} · ${esc(entry.name)}</b><small>${esc(sub)}</small></span>
        <time ${entry.at ? `datetime="${entry.at}"` : ''}>${esc(entry.at ? formatTime(entry.at) : entry.whenLabel || '')}</time>`;
      // A row leads back to its drink, wherever that drink is now.
      return entry.itemId && findItem(entry.itemId)
        ? `<button class="act-row act-${entry.kind}" type="button" data-act-item="${entry.itemId}" aria-label="${esc(verb)}, ${esc(entry.name)}. Show this drink">${body}</button>`
        : `<div class="act-row act-${entry.kind}">${body}</div>`;
    }).join('')}`).join('') : '<p class="muted">Nothing here for this week yet.</p>');
}

function resultRow(item, { actions = false, tag = '', attr = `data-cat-stock="${esc(item.id)}"` } = {}) {
  const origin = originText(item);
  return `<div class="result">
    <button class="result-main" type="button" ${attr}>
      <span class="thumb">${art(item)}</span>
      <span class="result-text"><span class="brand-line">${esc(item.brand || typeChip(item.type))}${tag ? ` <em class="tag">${esc(tag)}</em>` : ''}</span><b>${esc(item.name)}</b><span class="result-meta">${esc([metaLine(item, { size: false }), origin].filter(Boolean).join(' · '))}</span></span>
    </button>
    ${actions ? `<button class="icon-btn icon-btn-small" type="button" data-cat-run="${esc(item.id)}" aria-label="Add ${esc(item.fullName || item.name)} to the beer run"><svg><use href="#i-list"/></svg></button>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Add drinks: scan, search, confirm (the camera sheet). Its insides are as they were; what
// changed is how it is entered and where it leaves you.

/**
 * `kind` says why the sheet is open. A 'session' (the Scan button) stays open after each add
 * while "Keep scanning" is on, because a case of cans is one job. A 'preset' (an odd amount of
 * one known drink) always closes after its add.
 */
function openAdd(mode = 'scan', preset = {}, kind = 'session') {
  if (ui.guest) return;
  primeAudio();
  flushCount();
  const keep = $('#sheet-add').open && !$('#sheet-add').dataset.closing;
  ui.add = { mode, kind, pending: null, candidate: null, qty: 1, alts: [], session: keep ? ui.add.session : [], unknown: null, lookupToken: ui.add.lookupToken + 1 };
  $('#sheet-add').dataset.kind = kind;
  $('#rapid-toggle').checked = store.settings.rapidScan;
  $('#add-query').value = preset.query || '';
  $('#confirm').hidden = true;
  $('#sheet-add').classList.remove('has-confirm');
  renderSession();
  openSheet('sheet-add');
  setAddMode(preset.catalogItem || preset.item ? 'search' : mode, { focus: !preset.catalogItem && !preset.item });
  if (preset.catalogItem) showConfirm(fromCatalog(preset.catalogItem), { source: 'Catalog' });
  if (preset.item) showConfirm(fromItem(preset.item), { source: 'In your fridge' });
}

function setAddMode(mode, { focus = true } = {}) {
  ui.add.mode = mode;
  $('#sheet-add').dataset.mode = mode;
  $$('#add-mode [data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  if (mode === 'scan') {
    startScanner();
  } else {
    scanner?.stop();
    if (focus) $('#add-query').focus();
  }
  renderAddResults();
}

async function startScanner() {
  scanner ||= new Scanner($('#scan-video'), { onCode: handleScan, onState: scanState });
  $('#scan-fallback').hidden = true;
  $('#scan-stage').classList.remove('is-error');
  try {
    await scanner.start();
    $('#torch-btn').hidden = !scanner.torchSupported;
    if (ui.add.candidate || ui.add.unknown) scanner.pause();
  } catch (error) {
    $('#scan-stage').classList.add('is-error');
    $('#scan-fallback').hidden = false;
    $('#scan-fallback-msg').textContent = cameraErrorMessage(error);
    $('#scan-status').textContent = 'Camera off';
  }
}

function scanState(state, info = {}) {
  const status = $('#scan-status');
  if (state === 'starting') status.textContent = 'Starting camera…';
  if (state === 'scanning') status.textContent = info.engine === 'zxing' ? 'Hold the barcode inside the frame' : 'Point at a barcode. Upright cans work too.';
  $('#scan-stage').dataset.state = state;
}

function flashReticle() {
  const stage = $('#scan-stage');
  stage.classList.remove('is-hit');
  void stage.offsetWidth;
  stage.classList.add('is-hit');
}

async function handleScan(code) {
  scanFeedback(store.settings.beep);
  flashReticle();
  $('#scan-status').textContent = `Read ${displayCode(code.key)}`;
  await resolveBarcode(code.value, code.format);
}

async function resolveBarcode(value, format) {
  const token = (ui.add.lookupToken += 1);
  ui.add.pending = { code: value, format };
  ui.add.unknown = null;
  scanner?.pause();
  const owned = findByBarcode(value, format);
  if (owned) return showConfirm(fromItem(owned), { source: 'In your fridge', tone: 'ok' });
  const learned = learnedProduct(value, format);
  if (learned) {
    const known = learned.catalogId && getCatalogItem(learned.catalogId);
    return showConfirm(known ? fromCatalog(known) : { ...learned, itemId: null }, { source: 'Remembered' });
  }
  showConfirmLoading(displayCode(canonicalCode(value, format)));
  const product = navigator.onLine ? await lookupBarcode(value, { format, proxy: store.settings.upcProxy }) : null;
  if (token !== ui.add.lookupToken || !$('#sheet-add').open) return null;
  if (product) {
    const candidates = matchCandidates(product);
    const best = candidates[0];
    if (best && best.score >= 0.72) {
      const candidate = fromCatalog(best.item);
      if (!candidate.size && product.size) candidate.size = product.size;
      return showConfirm(candidate, { source: `${product.source} · catalog match`, image: product.image, alts: candidates.slice(1, 5).map(entry => entry.item) });
    }
    const type = product.type || 'Beer';
    return showConfirm({ itemId: null, name: product.name || product.brand || 'New drink', brand: product.brand, type, style: product.style || inferStyle(product.name, type), abv: product.abv, size: product.size || TYPE_META[type]?.size || '', image: product.image }, { source: product.source, image: product.image, alts: candidates.slice(0, 4).map(entry => entry.item), isNew: true });
  }
  return showUnknown(value, format);
}

function showConfirmLoading(code) {
  $('#confirm').hidden = false;
  $('#sheet-add').classList.add('has-confirm');
  $('#confirm').classList.add('is-loading');
  $('#confirm-art').innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  $('#confirm-source').textContent = 'Looking up';
  $('#confirm-brand').textContent = '';
  $('#confirm-name').textContent = code;
  $('#confirm-meta').textContent = 'Checking the catalog and Open Food Facts…';
  $('#confirm-stock').textContent = '';
  $('#confirm-alts').hidden = true;
}

function showUnknown(value, format) {
  const code = displayCode(canonicalCode(value, format));
  ui.add.unknown = { code, hint: brandHintFor(value, format) };
  ui.add.candidate = null;
  $('#confirm').hidden = true;
  $('#confirm').classList.remove('is-loading');
  $('#sheet-add').classList.remove('has-confirm');
  renderAddResults();
  if (ui.add.mode === 'search') $('#add-query').focus();
}

function showConfirm(candidate, { source = '', tone = '', image: rawImage = '', alts = [], isNew = false } = {}) {
  const image = /^https:\/\//i.test(rawImage) ? rawImage : '';
  ui.add.candidate = candidate;
  ui.add.alts = alts;
  ui.add.unknown = null;
  scanner?.pause();
  const existing = candidate.itemId ? findItem(candidate.itemId) : findSame(candidate);
  if (existing && !candidate.itemId) candidate.itemId = existing.id;
  const confirm = $('#confirm');
  confirm.hidden = false;
  confirm.classList.remove('is-loading');
  confirm.dataset.tone = tone;
  $('#sheet-add').classList.add('has-confirm');
  $('#confirm-art').innerHTML = image ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />${art(candidate)}` : art(candidate);
  $('#confirm-art').classList.toggle('has-photo', Boolean(image));
  $('#confirm-source').textContent = isNew ? `${source} · new` : source;
  $('#confirm-brand').textContent = candidate.brand || '';
  $('#confirm-name').textContent = candidate.name;
  $('#confirm-meta').textContent = metaLine(candidate);
  const pending = ui.add.pending ? ` · barcode ${displayCode(canonicalCode(ui.add.pending.code, ui.add.pending.format))} will be remembered` : '';
  $('#confirm-stock').textContent = existing ? `${existing.count} in the fridge now${existing.barcodes.length && ui.add.pending ? '' : pending}` : `New to the fridge${pending}`;
  $('#confirm-alts').hidden = true;
  $('#confirm-alts').innerHTML = alts.length
    ? `<p class="alts-title">Or did you mean</p>${alts.map(item => resultRow(item, { attr: `data-alt-cat="${esc(item.id)}"` })).join('')}<button class="text-btn" type="button" id="alts-search"><svg aria-hidden="true"><use href="#i-search"/></svg>Search instead</button>`
    : '<button class="text-btn" type="button" id="alts-search"><svg aria-hidden="true"><use href="#i-search"/></svg>Search for the right drink</button>';
  setQty(ui.add.qty || 1);
}

function setQty(qty) {
  ui.add.qty = Math.max(1, Math.min(999, qty));
  $('#confirm-qty').textContent = ui.add.qty;
  $$('#qty-chips [data-qty]').forEach(button => button.classList.toggle('is-active', Number(button.dataset.qty) === ui.add.qty));
  $('#confirm-add').textContent = `Add ${ui.add.qty} to the fridge`;
}

function dismissConfirm() {
  ui.add.lookupToken += 1;
  ui.add.qty = 1;
  ui.add.candidate = null;
  ui.add.pending = null;
  ui.add.unknown = null;
  $('#confirm').hidden = true;
  $('#sheet-add').classList.remove('has-confirm');
  renderAddResults();
  if (ui.add.mode === 'scan') scanner?.resume();
}

function confirmAdd() {
  const candidate = ui.add.candidate;
  if (!candidate) return;
  const qty = ui.add.qty;
  const result = stockCandidate(candidate, qty, ui.add.pending || {});
  const text = addedText(result, qty);
  const entry = { name: fullName(result.item), qty, itemId: result.item.id, text, undone: false };
  entry.undo = () => {
    entry.undone = true; // an add that was undone is not in the tally, and is not where we land
    result.undo();
    if ($('#sheet-add').open) renderSession();
  };
  ui.add.session.unshift(entry);
  renderSession();
  // A scanning session carries on while "Keep scanning" is on. Anything else is one drink: the
  // sheet closes itself and lands on the shelf, on that drink, with its receipt.
  const keepGoing = ui.add.kind === 'session' && $('#rapid-toggle').checked;
  ui.add.candidate = null;
  ui.add.pending = null;
  ui.add.qty = 1;
  $('#confirm').hidden = true;
  $('#sheet-add').classList.remove('has-confirm');
  if (!keepGoing) {
    closeSheet('sheet-add');
    return;
  }
  toast(text, { undo: entry.undo });
  $('#add-query').value = '';
  renderAddResults();
  if (ui.add.mode === 'scan') {
    scanner?.resume();
    $('#scan-status').textContent = 'Ready for the next one';
  }
}

function renderSession() {
  const session = (ui.add.session || []).filter(entry => !entry.undone);
  const total = session.reduce((sum, entry) => sum + entry.qty, 0);
  $('#session-strip').innerHTML = session.length
    ? `<span class="session-total">+${total} this session</span>${session.slice(0, 3).map(entry => `<span class="session-chip">+${entry.qty} ${esc(entry.name)}</span>`).join('')}`
    : '';
}

function renderAddResults() {
  const query = $('#add-query').value.trim();
  const list = $('#add-results');
  const hint = $('#add-hint');
  const digits = digitsOnly(query);
  const unknown = ui.add.unknown;
  hint.innerHTML = unknown
    ? `<b>Barcode ${esc(unknown.code)} isn’t in the open databases yet.</b> Pick the drink below and it’ll be remembered next time.${unknown.hint ? ` Looks like another <b>${esc(unknown.hint.brand)}</b>.` : ''} <button class="text-btn" type="button" id="scan-again">Scan again</button>`
    : '';
  hint.hidden = !unknown;
  const ctx = catalogSize() ? suggestions().ctx : null;
  const rows = [];
  if (/^\d{8,14}$/.test(query.replace(/\s/g, '')) && digits.length >= 8) {
    rows.push(`<div class="result"><button class="result-main" type="button" data-lookup-code="${digits}"><span class="thumb thumb-icon"><svg aria-hidden="true"><use href="#i-scan"/></svg></span><span class="result-text"><span class="brand-line">${isValidGtin(digits) || digits.length === 8 ? 'Barcode' : 'Check this number'}</span><b>Look up ${esc(digits)}</b><span class="result-meta">Searches your fridge, the catalog and Open Food Facts</span></span></button></div>`);
  } else if (query) {
    const folded = fold(query);
    const owned = store.items.filter(item => fold(`${item.brand} ${item.name}`).includes(folded)).slice(0, 3);
    owned.forEach(item => rows.push(resultRow(item, { tag: `${item.count} in fridge`, attr: `data-pick-item="${item.id}"` })));
    const ownedCatalog = new Set(owned.map(item => item.catalogId));
    const brandHint = unknown?.hint || null;
    searchCatalog(query, { limit: 14, boost: ctx ? searchBoost(ctx, { brandHint }) : null })
      .filter(item => !ownedCatalog.has(item.id))
      .forEach(item => rows.push(resultRow(item, { attr: `data-pick-cat="${esc(item.id)}"` })));
    if (!rows.length) rows.push(`<p class="muted">No matches in the catalog. Add it as a new drink below.</p>`);
  } else {
    // Smart suggestions before typing.
    const seen = new Set();
    const push = (html, key) => { if (!seen.has(key)) { seen.add(key); rows.push(html); } };
    if (unknown?.hint) {
      const fromMaker = unknown.hint.makerId ? itemsForMaker(unknown.hint.makerId) : catalogItems().filter(item => fold(item.brand) === fold(unknown.hint.brand));
      fromMaker.slice(0, 6).forEach(item => push(resultRow(item, { tag: 'Same brewery', attr: `data-pick-cat="${esc(item.id)}"` }), item.id));
    }
    lowStock(store.items, store.activity, store.settings.defaultPar).slice(0, 3).forEach(({ item }) => push(resultRow(item, { tag: 'Restock', attr: `data-pick-item="${item.id}"` }), item.catalogId || item.id));
    const recentIds = [...new Set(store.activity.filter(entry => entry.kind === 'in' && entry.itemId).map(entry => entry.itemId))].slice(0, 4);
    recentIds.map(findItem).filter(Boolean).forEach(item => push(resultRow(item, { tag: 'Recent', attr: `data-pick-item="${item.id}"` }), item.catalogId || item.id));
    if (ctx) suggestions().local.slice(0, 4).forEach(entry => push(resultRow(entry.item, { tag: 'Local', attr: `data-pick-cat="${esc(entry.item.id)}"` }), entry.item.id));
    if (rows.length) rows.unshift('<p class="results-title">Suggested</p>');
  }
  list.innerHTML = rows.join('');
}

function pickForAdd(candidate, source) {
  showConfirm(candidate, { source });
}

// ---------------------------------------------------------------------------
// Details sheet: for a drink that is not on the shelf (it is out of stock, or it is an idea
// from the catalog). A drink on the shelf shows the same things on the back of its can.

function openItem(id, catalogId = null) {
  if (ui.guest) return;
  const owned = id ? findItem(id) : null;
  if (owned && owned.count > 0) {
    showDrink(id);
    ui.back = true;
    ui.backAbout = false;
    renderBack();
    return;
  }
  ui.itemId = owned ? id : null;
  ui.itemCatalog = owned ? null : catalogId;
  if (renderItemSheet()) openSheet('sheet-item');
}

function renderItemSheet() {
  const owned = ui.itemId ? findItem(ui.itemId) : null;
  const idea = !owned && ui.itemCatalog ? getCatalogItem(ui.itemCatalog) : null;
  const item = owned || idea;
  if (!item) {
    closeSheet('sheet-item');
    return false;
  }
  $('#item-art').innerHTML = art(item, `${fullName(item)} artwork`);
  $('#item-brand').textContent = item.brand || typeChip(item.type);
  $('#item-name').textContent = item.name;
  const origin = originText(item);
  $('#item-origin').textContent = origin ? `${item.type === 'Beer' ? 'Brewed in' : 'From'} ${origin}` : '';
  $('#item-tags').innerHTML = [item.style, abvText(item) && `${abvText(item)} ABV`, item.size, item.type !== 'Beer' ? typeChip(item.type) : ''].filter(Boolean).map(tag => `<span class="tag-pill">${esc(tag)}</span>`).join('');
  $('#item-body').innerHTML = detailsHtml(item, { where: owned ? 'sheet' : 'idea' });
  return true;
}

/** Rate a drink where its stars are (back label, Details sheet, the latest round). */
function rateHere(id, stars) {
  const item = findItem(id);
  if (!item || ui.guest) return;
  const result = rateItem(id, stars);
  if (result) toast(`${fullName(item)}: rated ${stars} ★`, { undo: result.undo, tone: 'ok' });
}

function deleteHere(button, id) {
  const item = findItem(id);
  if (!item) return;
  armed(button, 'Tap again to delete', () => {
    flushCount();
    leaveShelf(id);
    ui.back = false;
    const result = deleteItem(id);
    const tell = () => { if (result) toast(`${fullName(result.item)} deleted`, { undo: result.undo }); };
    if ($('#sheet-item').open) closeSheet('sheet-item', { then: tell });
    else tell();
  });
}

// ---------------------------------------------------------------------------
// Fridge lists: a batch of drinks packed into a link (see tools/stock-link.mjs)

const HOUSE_LIST = './data/fridge.json';
const houseEnabled = !/[?&]house=0\b/.test(location.search); // the tests switch it off
let houseReady = Promise.resolve();

/**
 * The house list: the fridge's own drinks, shipped with the app (data/fridge.json) and loaded
 * by itself the first time a device opens the app. There is no server database: the fridge
 * lives on each device, so this is how a phone starts with the real fridge instead of the
 * sample drinks. It adds only what is missing, never raises a count that is already there,
 * clears the sample drinks, and runs once per list id.
 */
async function autoStock(notes = []) {
  const tell = () => {
    endBoot();
    if (notes.length) toast(notes.join(' · '), { tone: 'ok', duration: 6000 });
  };
  if (ui.guest || !houseEnabled || !catalogSize()) { tell(); return; }
  let list;
  try {
    const response = await fetch(HOUSE_LIST, { cache: 'no-cache' });
    if (!response.ok) { tell(); return; }
    list = await response.json();
  } catch {
    tell();
    return; // offline on the first visit: try again next time
  }
  let loaded = null;
  const key = `house:${list?.id || ''}`;
  if (list?.id && Array.isArray(list.lines) && !stockListLoaded(key)) {
    const missing = list.lines
      .map(([id, count]) => {
        const catalogItem = getCatalogItem(id);
        return catalogItem ? { data: fromCatalog(catalogItem), qty: count } : null;
      })
      .filter(line => line && !line.data.itemId);
    const samples = sampleItems().length;
    const result = stockBatch(missing, { dropSamples: true, listKey: key });
    if (result.drinks || samples) loaded = result;
  }
  // One-off corrections: set a drink's count once on each device (a fix has its own id, so it
  // does not run again when the list changes).
  (Array.isArray(list?.fixes) ? list.fixes : []).forEach(fix => {
    if (!fix?.id || stockListLoaded(`fix:${fix.id}`)) return;
    const item = store.items.find(entry => entry.catalogId === fix.drink);
    // A fix can also correct details, such as the package ("16 fl oz can" decides can or bottle art).
    if (item && fix.set && typeof fix.set === 'object') {
      const changes = Object.fromEntries(['size', 'abv', 'style'].filter(field => fix.set[field] != null && item[field] !== fix.set[field]).map(field => [field, fix.set[field]]));
      if (Object.keys(changes).length) saveItem({ id: item.id, ...changes });
    }
    if (item && Number.isInteger(fix.count) && fix.count >= 0 && item.count !== fix.count) {
      const before = item.count;
      adjustCount(item.id, fix.count);
      // One line per drink: a merge that was then corrected reads as a single change.
      const mergedAt = notes.findIndex(note => note.startsWith(`${fullName(item)}: `) && note.includes('merged into one'));
      if (mergedAt >= 0) notes[mergedAt] = notes[mergedAt].replace(/, \d+ on hand$/, `, now ${fix.count} on hand`);
      else notes.push(`${fullName(item)}: set to ${fix.count} on hand (was ${before})`);
    }
    markListLoaded(`fix:${fix.id}`);
  });
  if (loaded) {
    endBoot();
    toast(loaded.drinks ? `Your fridge is loaded: ${plural(loaded.drinks, 'drink')}, ${loaded.units} cans and bottles` : 'Sample drinks cleared. Your beers were already here.', { undo: loaded.undo, tone: 'ok', remember: false });
    return;
  }
  tell();
}

async function openStockList(text) {
  if (ui.guest) return;
  const token = stockToken(text);
  if (!token) { toast('That doesn’t look like a fridge list link'); return; }
  let list;
  try { list = await decodeStock(token); } catch { toast('That list link looks incomplete. Copy the whole link and try again.'); return; }
  await loadCatalog();
  await houseReady; // the house list loads first, so this sheet knows what is already in
  const lines = list.lines.map(line => {
    const catalogItem = line.id ? getCatalogItem(line.id) : null;
    const data = catalogItem ? fromCatalog(catalogItem) : line.item?.name ? { ...line.item } : null;
    return data ? { data, qty: line.count } : null;
  }).filter(Boolean);
  if (!lines.length) { toast('This copy of the app doesn’t know the drinks on that list yet. Close it, reopen it and try again.'); return; }
  ui.stockList = { key: String(hash(token)), title: list.title, lines, missing: list.lines.length - lines.length };
  renderStockList();
  openSheet('sheet-stock');
}

function renderStockList() {
  const list = ui.stockList;
  if (!list) return;
  const units = list.lines.reduce((sum, line) => sum + line.qty, 0);
  $('#stock-title').textContent = list.title;
  $('#stock-summary').textContent = `${plural(list.lines.length, 'drink')}, ${units} cans and bottles in all.${list.missing ? ` ${plural(list.missing, 'drink')} on the list couldn’t be matched and will be skipped.` : ''}`;
  const loaded = stockListLoaded(list.key);
  const allHere = list.lines.every(line => findSame(line.data));
  const again = Boolean(loaded) || allHere;
  $('#stock-again').hidden = !again;
  if (again) {
    $('#stock-again').textContent = `${loaded ? `You already added this list ${relativeTime(loaded.at)}.` : 'Every drink on this list is already in your fridge.'} Adding it again puts the same cans in twice.`;
  }
  $('#stock-apply').textContent = again ? 'Add again' : 'Add to fridge';
  const samples = sampleItems().length;
  $('#stock-drop-row').hidden = !samples;
  $('#stock-drop').checked = Boolean(samples);
  $('#stock-drop-text').textContent = `Remove the ${plural(samples, 'sample drink')} first`;
  $('#stock-rows').innerHTML = list.lines.map(({ data, qty }) => `
    <div class="stock-row">
      <span class="thumb">${art(data)}</span>
      <span class="stock-row-text"><b>${esc(fullName(data))}</b><small>${esc(metaLine(data))}</small></span>
      <span class="stock-qty" aria-label="${qty} to add">×${qty}</span>
    </div>`).join('');
}

function applyStockList() {
  const list = ui.stockList;
  if (!list) return;
  const dropSamples = !$('#stock-drop-row').hidden && $('#stock-drop').checked;
  const result = stockBatch(list.lines, { dropSamples, listKey: list.key });
  ui.stockList = null;
  closeSheet('sheet-stock', {
    then: () => {
      showScreen('screen-home');
      toast(`${plural(result.drinks, 'drink')} added: ${result.units} cans and bottles`, { undo: result.undo, tone: 'ok' });
    },
  });
}

// ---------------------------------------------------------------------------
// Edit / new drink form. Save finishes the job: the form closes and you are on the drink.

function fillTypeOptions(selected) {
  $('#f-type').innerHTML = TYPES.map(type => `<option value="${type}"${type === selected ? ' selected' : ''}>${type}</option>`).join('');
}

function fillStyleOptions(type, selected = '') {
  const groups = stylesForType(type);
  const known = groups.some(group => group.styles.includes(selected));
  $('#f-style').innerHTML = `<option value="">${groups.length ? 'Not sure' : '—'}</option>${groups.map(group => `<optgroup label="${esc(group.family)}">${group.styles.map(style => `<option${style === selected ? ' selected' : ''}>${esc(style)}</option>`).join('')}</optgroup>`).join('')}${selected && !known ? `<option selected>${esc(selected)}</option>` : ''}`;
}

function openForm({ mode = 'new', item = null, candidate = null, qty = 1, returnTo = null, brewery = null, focus = '' } = {}) {
  if (ui.guest) return;
  flushCount();
  const source = item || candidate || {};
  ui.form = { mode, itemId: item?.id || null, returnTo, touchedType: Boolean(source.type), touchedStyle: Boolean(source.style), catalogId: candidate?.catalogId || null, pending: returnTo === 'add' ? ui.add.pending : null, image: candidate?.image || '' };
  $('#form-eyebrow').textContent = mode === 'edit' ? 'Edit drink' : 'New drink';
  $('#form-title').textContent = mode === 'edit' ? fullName(item) : 'Add a drink';
  $('#f-name').value = source.name || '';
  $('#f-name').removeAttribute('aria-invalid');
  $('#f-brand').value = brewery ? shortBrewery(brewery.name) : source.brand || '';
  const type = source.type || 'Beer';
  fillTypeOptions(type);
  fillStyleOptions(type, source.style || '');
  $('#f-abv').value = source.abv ?? '';
  $('#f-size').value = source.size || TYPE_META[type]?.size || '';
  $('#f-city').value = brewery?.city || source.city || '';
  $('#f-state').value = brewery?.state || source.state || '';
  // A new drink says how many are going in; an existing one shows what is on hand, to correct.
  $('#f-qty-label').textContent = mode === 'edit' ? 'On hand' : 'Adding now';
  $('#f-qty').value = mode === 'edit' ? item.count : qty;
  $('#f-par').value = source.par ?? '';
  $('#f-par').placeholder = String(parPlaceholder());
  const pending = ui.form.pending;
  $('#form-note').textContent = pending ? `Barcode ${displayCode(canonicalCode(pending.code, pending.format))} will be linked to this drink.` : brewery ? `From ${brewery.name}, ${brewery.miles < 1 ? 'under a mile' : `${Math.round(brewery.miles)} miles`} away.` : '';
  $('#form-note').hidden = !$('#form-note').textContent;
  $('#form-submit').textContent = mode === 'edit' ? 'Save' : 'Add';
  const brands = new Set([...makersList().map(maker => maker.brand || maker.name), ...ui.breweries.map(entry => shortBrewery(entry.name)), ...store.items.map(entry => entry.brand).filter(Boolean)]);
  $('#brand-options').innerHTML = [...brands].sort().map(brand => `<option value="${esc(brand)}"></option>`).join('');
  $('#size-options').innerHTML = SIZES.map(size => `<option value="${size}"></option>`).join('');
  scanner?.pause();
  openSheet('sheet-form');
  $('.form-body').scrollTop = 0;
  if (focus) $(`#f-${focus}`)?.focus();
  else if (!source.name) $('#f-name').focus();
}

function submitForm(event) {
  event.preventDefault();
  if (!ui.form) return;
  const name = $('#f-name').value.trim();
  if (!name) {
    $('#f-name').focus();
    $('#f-name').setAttribute('aria-invalid', 'true');
    return;
  }
  $('#f-name').removeAttribute('aria-invalid');
  const data = {
    name,
    brand: $('#f-brand').value.trim(),
    type: $('#f-type').value,
    style: $('#f-style').value,
    abv: $('#f-abv').value,
    size: $('#f-size').value.trim(),
    city: $('#f-city').value.trim(),
    state: stateCode($('#f-state').value) || $('#f-state').value.trim().toUpperCase(),
    par: $('#f-par').value,
    image: ui.form.image || '',
  };
  if (ui.form.catalogId) {
    const catalogItem = getCatalogItem(ui.form.catalogId);
    if (catalogItem && fold(catalogItem.name) === fold(name)) Object.assign(data, { catalogId: catalogItem.id, lat: catalogItem.lat, lng: catalogItem.lng, country: catalogItem.country });
  }

  if (ui.form.mode === 'edit') {
    const saved = saveItem({ id: ui.form.itemId, ...data });
    const raw = $('#f-qty').value.trim();
    const count = raw === '' || Number.isNaN(Number(raw)) ? saved.count : Math.max(0, Math.round(Number(raw)));
    const before = saved.count;
    let message = 'Saved';
    let undo = null;
    if (count !== before) {
      flushCount(); // a dial change still waiting to save comes first
      if (count === 0) leaveShelf(saved.id);
      undo = adjustCount(saved.id, count)?.undo || null;
      message = count === 0 ? `Saved. ${fullName(saved)} is out: off the shelf, on the beer run (was ${before})` : `Saved. ${fullName(saved)}: now ${count} on hand (was ${before})`;
    }
    // The form closes onto wherever the drink was being looked at; it never drops back onto
    // another sheet.
    closeSheet('sheet-form', { then: () => toast(message, { undo, tone: 'ok' }) });
    return;
  }

  const qty = Math.max(0, Math.round(Number($('#f-qty').value) || 0));
  const pending = ui.form.pending || {};
  const fromAdd = ui.form.returnTo === 'add' && $('#sheet-add').open;
  let item;
  let text;
  let undo = null;
  if (qty > 0) {
    const result = stockIn({ ...data, country: data.country || (data.state ? 'US' : '') }, qty, pending);
    item = result.item;
    text = addedText(result, qty);
    undo = result.undo;
    if (fromAdd) {
      const entry = { name: fullName(item), qty, itemId: item.id, text, undone: false };
      entry.undo = () => { entry.undone = true; result.undo(); if ($('#sheet-add').open) renderSession(); };
      ui.add.session.unshift(entry);
      renderSession();
      undo = entry.undo;
    }
  } else {
    item = saveItem(data);
    if (pending.code) { attachBarcode(item, pending.code, pending.format); persist('barcode'); }
    text = `${fullName(item)} saved with none on hand: it is on the beer run`;
  }
  if (fromAdd) {
    ui.add.candidate = null;
    ui.add.pending = null;
    ui.add.unknown = null;
    $('#confirm').hidden = true;
    $('#sheet-add').classList.remove('has-confirm');
    const keepGoing = ui.add.kind === 'session' && $('#rapid-toggle').checked;
    closeSheet('sheet-form', {
      then: () => {
        if (keepGoing) {
          toast(text, { undo });
          $('#add-query').value = '';
          renderAddResults();
        } else if (qty > 0) {
          closeSheet('sheet-add'); // lands on the shelf with the receipt
        } else {
          closeSheet('sheet-add', { then: () => toast(text) });
        }
      },
    });
    return;
  }
  closeSheet('sheet-form', {
    then: () => {
      if (qty > 0) landOnShelf(item.id, text, { undo });
      else toast(text, { tone: 'ok', actions: [{ label: 'Beer run', run: () => showScreen('screen-run', { focus: true }) }] });
    },
  });
}

// ---------------------------------------------------------------------------
// Settings and sharing

function openSettings() {
  if (ui.guest) return;
  const settings = store.settings;
  $('#s-name').value = settings.fridgeName;
  $('#s-loc').textContent = settings.location ? settings.location.label : 'Not set';
  $('#s-loc-box').hidden = true;
  $('#s-rapid').checked = settings.rapidScan;
  $('#s-beep').checked = settings.beep;
  $('#s-par').value = settings.defaultPar;
  $('#s-proxy').value = settings.upcProxy;
  const makers = makersList().length;
  $('#s-about').textContent = catalogSize()
    ? `Built-in catalog: ${catalogSize()} drinks from ${makers} breweries and brands (updated ${catalogVersion() || 'recently'}). It works offline and learns every barcode you scan.`
    : 'The built-in catalog hasn’t loaded yet.';
  openSheet('sheet-settings');
}

function openShare() {
  if (ui.guest) return;
  $('#share-qr').setAttribute('aria-busy', 'true');
  $('#share-qr').innerHTML = '';
  openSheet('sheet-share');
  updateShare();
}

async function updateShare() {
  const base = `${location.origin}${location.pathname}#menu`;
  try {
    const { url, included, total } = await snapshotUrl(base, store.settings.fridgeName, store.items.filter(item => item.count > 0));
    ui.shareUrl = url;
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname) || location.protocol !== 'https:';
    $('#share-note').textContent = local
      ? 'Heads up: this link points at this computer. Put the app on an https:// address so guests’ phones can open it.'
      : included < total
        ? `Guests see a snapshot of the top ${included} of ${total} drinks. Share again after restocking.`
        : 'Guests scan this to see what’s cold right now. It’s a snapshot, so share again after restocking.';
    $('#share-qr').innerHTML = await qrSvg(url);
  } catch {
    $('#share-qr').innerHTML = '<p class="qr-fallback">The QR code needs a connection the first time.</p>';
  }
  $('#share-qr').removeAttribute('aria-busy');
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Find: the one search. A drink in the fridge: go to it. A drink that is not: stock it right
// here, or put it on the beer run. It is also the whole fridge as a list, with the grouping and
// the sort, so none of that sits on the shelf itself.

function openFind(intent = 'shelf') {
  if (ui.guest) intent = 'guest';
  ui.find = { intent };
  flushCount();
  const field = $('#inv-search');
  field.value = '';
  field.placeholder = intent === 'list' ? 'Add to the beer run' : intent === 'guest' ? 'Find a drink' : 'Find or add a drink';
  $('#find-tools').hidden = intent !== 'shelf';
  $('.find-close').textContent = intent === 'list' ? 'Done' : 'Cancel';
  renderFind();
  openSheet('sheet-find');
  $('#find-list').scrollTop = 0;
  if (intent !== 'guest') field.focus(); // a guest gets the whole list first
}

function findCatalogRow(item, { tag = 'Catalog', key = `cat:${item.id}`, list = false } = {}) {
  const open = ui.pack?.host === 'find' && ui.pack.key === key;
  const listed = store.beerRun.some(run => run.catalogId === item.catalogId || run.catalogId === item.id);
  const origin = originText(item);
  const catalogId = key.startsWith('cat:') ? item.id : item.catalogId;
  const listButton = catalogId ? `<button class="mini-btn" type="button" data-cat-run="${esc(catalogId)}" aria-pressed="${listed}">${icon(listed ? 'i-check' : 'i-list')}${listed ? 'On the list' : 'Beer run'}</button>` : '';
  return `<div class="result${open ? ' is-open' : ''}">
      <button class="result-main" type="button" ${list ? `data-cat-run="${esc(catalogId)}"` : `data-pack-open="find" data-pack-key="${esc(key)}" aria-expanded="${open}"`}>
        <span class="thumb">${art(item)}</span>
        <span class="result-text"><span class="brand-line">${esc(item.brand || typeChip(item.type))} <em class="tag">${esc(list && listed ? 'On the list' : tag)}</em></span><b>${esc(item.name)}</b><span class="result-meta">${esc([metaLine(item, { size: false }), origin].filter(Boolean).join(' · '))}</span></span>
      </button>
      ${open ? `${packHtml(key)}${listButton}` : ''}
    </div>`;
}

function renderFind() {
  const { intent } = ui.find;
  const guest = Boolean(ui.guest);
  const query = $('#inv-search').value.trim();
  const folded = fold(query);
  const shelf = guest ? ui.guest.items.filter(item => item.count > 0) : store.items.filter(item => item.count > 0);
  const lineup = lineups.find;
  Object.assign(lineup, { type: 'all', group: 'all', query, sort: guest ? 'name' : lineups.inv.sort });
  organize(lineup, intent === 'list' ? [] : shelf, groupingSetting(guest ? 'menuGroup' : 'invGroup'));
  const select = $('#inv-group-by');
  if (select.value !== lineup.grouping) select.value = lineup.grouping;
  if ($('#inv-sort').value !== lineups.inv.sort) $('#inv-sort').value = lineups.inv.sort;
  $('#inventory-list').innerHTML = groupedHtml(lineup, item => {
    const isLow = !guest && item.count <= parOf(item);
    return `<button class="inv-row" type="button" data-show="${item.id}">
        <span class="thumb">${art(item)}</span>
        <span class="inv-text"><span class="brand-line">${esc(item.brand || typeChip(item.type))}</span><b>${esc(item.name)}</b><span class="inv-meta">${esc(metaLine(item, { size: false }))}</span></span>
        <span class="inv-count${isLow ? ' is-low' : ''}"><strong>${item.count}</strong><small>${guest ? 'cold' : isLow ? 'low' : 'on hand'}</small></span>
      </button>`;
  });

  const extra = [];
  if (!guest) {
    const out = store.items.filter(item => item.count === 0);
    const boost = catalogSize() ? searchBoost(suggestions().ctx) : null;
    if (query) {
      const matches = intent === 'shelf' ? out.filter(item => fold(`${item.brand} ${item.name}`).includes(folded)).slice(0, 4) : [];
      const owned = new Set(store.items.map(item => item.catalogId).filter(Boolean));
      const catalog = searchCatalog(query, { limit: 8, boost }).filter(item => !owned.has(item.id)).slice(0, 6);
      if (matches.length) extra.push('<p class="results-title">Out of stock</p>', ...matches.map(item => findCatalogRow(item, { tag: 'Out', key: `item:${item.id}` })));
      if (catalog.length) extra.push(`<p class="results-title">${intent === 'list' ? 'Tap to add to the beer run' : 'From the catalog'}</p>`, ...catalog.map(item => findCatalogRow(item, { list: intent === 'list' })));
      if (!lineup.shown.length && !matches.length && !catalog.length) extra.push('<p class="muted">Nothing by that name in the fridge or the catalog.</p>');
      if (intent === 'shelf') extra.push(`<button class="text-btn find-new" type="button" data-find-new="1">${icon('i-plus')}Add “${esc(query)}” as a new drink</button>`);
    } else if (intent === 'list') {
      const ideas = catalogSize() ? [...suggestions().top, ...suggestions().forYou].map(entry => entry.item).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(0, 6) : [];
      if (ideas.length) extra.push('<p class="results-title">Ideas · tap to add</p>', ...ideas.map(item => findCatalogRow(item, { tag: 'Idea', list: true })));
      else extra.push('<p class="muted">Type a drink to add it to the beer run.</p>');
    } else if (out.length) {
      extra.push(`<button class="text-btn out-link" type="button" data-go-run="1">${icon('i-list')}${plural(out.length, 'drink')} out of stock, on the beer run</button>`);
    }
    if (intent === 'shelf' && !query && !shelf.length) extra.push('<p class="muted">The fridge is empty. Type a drink to add it.</p>');
  } else if (!lineup.shown.length) {
    extra.push('<p class="muted">Nothing by that name on the menu.</p>');
  }
  $('#find-extra').innerHTML = extra.join('');
}

/** A row in Find was chosen: the sheet closes and the shelf is on that drink. */
function pickFound(id) {
  if (ui.guest) {
    closeSheet('sheet-find', {
      then: () => {
        const lineup = lineups.menu;
        const index = lineup.shown.findIndex(item => item.id === id);
        if (index >= 0) lineup.flow?.goTo(index);
      },
    });
    return;
  }
  closeSheet('sheet-find', { then: () => showDrink(id) });
}

// ---------------------------------------------------------------------------
// Events

/** A beer-run row's name was tapped: go to where that drink lives now. */
function openRunRow(key) {
  const at = key.indexOf(':');
  const id = key.slice(at + 1);
  const entry = key.startsWith('run:') ? store.beerRun.find(run => run.id === id) : null;
  const item = entry ? entry.itemId && findItem(entry.itemId) : findItem(id);
  if (item) {
    if (item.count > 0) showDrink(item.id);
    else openItem(item.id);
  } else if (entry?.catalogId) {
    openItem(null, entry.catalogId);
  }
}

function onClick(event) {
  const target = event.target.closest('button, a');
  if (!target) return;
  const data = target.dataset;

  if (data.notice !== undefined) { runNotice(data.notice); return; }
  if (data.close !== undefined) { closeSheet(target.closest('dialog').id); return; }
  if (data.screen) { showScreen(data.screen, { focus: true }); return; }
  if (data.goRun) {
    const go = () => showScreen('screen-run', { focus: true });
    if ($('#sheet-find').open) closeSheet('sheet-find', { then: go });
    else go();
    return;
  }
  if (data.openAdd) { openAdd(data.openAdd); return; }
  if (data.find) { openFind(data.find); return; }
  if (data.show) { pickFound(data.show); return; }

  // The shelf
  if (data.take) { takeOne(data.take); return; }
  if (data.jump) { lineups[data.jump]?.flow?.goTo(Number(data.index)); return; }
  if (data.wheelStep) {
    const ctl = countCtls[target.closest('.count-ctl')?.dataset.ctl];
    if (ctl?.itemId) ctl.wheel.step(Number(data.wheelStep));
    return;
  }
  if (data.packOpen) { openPack(data.packOpen, data.packKey); return; }
  if (data.packQty) { commitPack(data.packKey, Number(data.packQty)); return; }
  if (data.packOther) { packOther(data.packOther); return; }
  if (data.packCancel) { closePack(); return; }
  if (data.roundBy) { nameRound(data.roundBy); return; }
  if (data.roundOther) { if (ui.round) openWho(ui.round.takes.map(take => take.entryId)); return; }
  if (data.roundStar) { rateRound(Number(data.roundStar)); return; }

  // The back of a can, and the Details sheet
  if (data.backAbout) { ui.backAbout = !ui.backAbout; renderBack(); return; }
  if (data.rate) { rateHere(data.rate, Number(data.stars)); return; }
  if (data.parStep) {
    const item = findItem(data.parId);
    if (item) saveItem({ id: item.id, par: Math.max(0, parOf(item) + Number(data.parStep)) });
    return;
  }
  if (data.history) {
    ui.actItem = data.history;
    ui.actFilter = 'all';
    const go = () => showScreen('screen-activity', { focus: true });
    if ($('#sheet-item').open) closeSheet('sheet-item', { then: go });
    else go();
    return;
  }
  if (data.edit) { const item = findItem(data.edit); if (item) openForm({ mode: 'edit', item }); return; }
  if (data.itemRun) {
    const item = findItem(data.itemRun);
    if (item) toast(addToBeerRun({ itemId: item.id, catalogId: item.catalogId, name: item.name, brand: item.brand, style: item.style }) ? `${fullName(item)} is on the beer run` : 'Already on the beer run', { tone: 'ok' });
    return;
  }
  if (data.markOut) { markOut(data.markOut); return; }
  if (data.delete) { deleteHere(target, data.delete); return; }

  // Beer run and Discover
  if (data.runOpen) { openRunRow(data.runOpen); return; }
  if (data.runRemove) {
    const result = removeFromBeerRun(data.runRemove);
    if (result) toast(`${entryName(result.entry)} is off the list`, { undo: result.undo });
    return;
  }
  if (data.catRun) { toggleListed(data.catRun); return; }
  if (data.catOpen) { openItem(null, data.catOpen); return; }
  if (data.catDismiss) {
    const item = getCatalogItem(data.catDismiss);
    const result = dismissSuggestion(data.catDismiss);
    toast(`Hidden${item ? `: ${item.fullName}` : ''}`, { undo: result.undo });
    return;
  }
  if (data.discover) {
    Object.assign(ui, { discover: data.discover, locOpen: false, pack: null });
    renderDiscover();
    return;
  }
  if (data.locChange) {
    Object.assign(ui, { locOpen: true, discover: 'near' });
    renderDiscover();
    $('#discover-panel [data-loc-input]')?.focus();
    return;
  }
  if (data.locDevice) { setLocation(locateDevice(), 'Getting your location…', target.closest('[data-loc-form]')); return; }
  if (data.locCancel) {
    ui.locOpen = false;
    $('#s-loc-box').hidden = true;
    if (ui.screen === 'screen-discover') renderDiscover();
    return;
  }
  if (data.breweryAdd) {
    const brewery = ui.breweries.find(entry => entry.id === data.breweryAdd);
    if (brewery) openForm({ mode: 'new', brewery, candidate: { type: 'Beer' } });
    return;
  }
  if (data.moreBreweries) { ui.breweriesShown += 24; renderDiscover(); return; }

  // Activity
  if (data.actFilter) { ui.actFilter = data.actFilter; renderActivity(); return; }
  if (data.actClear) { ui.actItem = null; renderActivity(); return; }
  if (data.actItem) {
    const item = findItem(data.actItem);
    if (item?.count > 0) showDrink(item.id);
    else if (item) openItem(item.id);
    return;
  }
  if (data.undoLast) { undoLastChange(); return; }
  if (data.entryBy) {
    if (nameCheckout([data.entryBy], data.by)) toast(`Saved: taken by ${data.by}`, { tone: 'ok' });
    return;
  }
  if (data.entryOther) { openWho([data.entryOther]); return; }

  // Find
  if (data.findNew) { openForm({ mode: 'new', candidate: newDrinkGuess($('#inv-search').value.trim()), qty: 1 }); return; }

  // The scanner sheet
  if (data.pickItem) { const item = findItem(data.pickItem); if (item) pickForAdd(fromItem(item), 'In your fridge'); return; }
  if (data.pickCat) { const item = getCatalogItem(data.pickCat); if (item) pickForAdd(fromCatalog(item), ui.add.pending ? 'Your pick' : 'Catalog'); return; }
  if (data.altCat) { const item = getCatalogItem(data.altCat); if (item) showConfirm(fromCatalog(item), { source: 'Your pick' }); return; }
  if (data.lookupCode) { resolveBarcode(data.lookupCode); return; }

  switch (target.id) {
    case 'tab-scan': openAdd('scan'); break;
    case 'open-settings': openSettings(); break;
    case 'open-share': openShare(); break;
    case 'inv-more': toggleBack(); break;
    case 'run-share': shareText('Beer run', beerRunText()); break;
    case 'share-btn': shareMenu().then(() => closeSheet('sheet-share')); break;
    case 'copy-link': copyText(ui.shareUrl, 'Menu link copied').then(() => closeSheet('sheet-share')); break;
    case 'scan-retry': startScanner(); break;
    case 'scan-again': dismissConfirm(); break;
    case 'torch-btn': toggleTorch(target); break;
    case 'add-custom': openForm({ mode: 'new', candidate: newDrinkGuess($('#add-query').value.trim()), returnTo: 'add', qty: 1 }); break;
    case 'confirm-add': confirmAdd(); break;
    case 'confirm-close': dismissConfirm(); break;
    case 'confirm-edit': openForm({ mode: 'new', candidate: ui.add.candidate, qty: ui.add.qty, returnTo: 'add' }); break;
    case 'confirm-other': $('#confirm-alts').hidden = !$('#confirm-alts').hidden; break;
    case 'alts-search': {
      ui.add.candidate = null;
      $('#confirm').hidden = true;
      $('#sheet-add').classList.remove('has-confirm');
      if (ui.add.pending) ui.add.unknown = { code: displayCode(canonicalCode(ui.add.pending.code, ui.add.pending.format)), hint: brandHintFor(ui.add.pending.code, ui.add.pending.format) };
      $('#add-query').focus();
      renderAddResults();
      break;
    }
    case 's-loc-edit': {
      const box = $('#s-loc-box');
      box.hidden = !box.hidden;
      if (!box.hidden) $('[data-loc-input]', box).focus();
      break;
    }
    case 's-export':
      download(`fridge-backup-${new Date().toISOString().slice(0, 10)}.json`, exportData());
      closeSheet('sheet-settings', { then: () => toast('Backup file saved to your downloads', { tone: 'ok' }) });
      break;
    case 's-reset': armed(target, 'Tap again to load the demo', () => { resetDemo(); closeSheet('sheet-settings', { then: () => { showScreen('screen-home'); toast('Demo fridge loaded'); } }); }); break;
    case 's-erase': armed(target, 'Tap again to erase', () => { eraseAll(); ui.lastUndo = null; closeSheet('sheet-settings', { then: () => { showScreen('screen-home'); toast('Everything erased'); } }); }); break;
    case 's-stock-go': openStockList($('#s-stock').value).then(() => { if ($('#sheet-stock').open) $('#s-stock').value = ''; }); break;
    case 'stock-apply': applyStockList(); break;
    default: break;
  }

  if (target.matches('[data-qty]')) setQty(Number(target.dataset.qty));
  if (target.matches('[data-step]')) setQty(ui.add.qty + Number(target.dataset.step));
  if (target.matches('[data-mode]')) setAddMode(target.dataset.mode);
}

function newDrinkGuess(query) {
  const type = inferType(query) || 'Beer';
  return { name: query, type, style: inferStyle(query, type), size: TYPE_META[type]?.size || '' };
}

async function toggleTorch(button) {
  const on = !(scanner?.torchOn);
  const ok = await scanner?.setTorch(on);
  if (ok) button.setAttribute('aria-pressed', String(on));
}

async function shareMenu() {
  if (!ui.shareUrl) return;
  if (navigator.share) {
    try { await navigator.share({ title: `${store.settings.fridgeName} menu`, text: 'Here’s what’s cold in the fridge right now.', url: ui.shareUrl }); } catch { /* cancelled */ }
  } else {
    copyText(ui.shareUrl, 'Menu link copied');
  }
}

async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch { /* cancelled */ }
  }
  copyText(text, 'Copied to the clipboard');
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Couldn’t copy. Long-press to copy instead.');
  }
}

async function handlePhoto(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  $('#scan-status').textContent = 'Reading the photo…';
  try {
    const code = await decodeImageFile(file);
    if (!code) {
      toast('No barcode found in that photo. Get closer, in good light, and try again.');
      $('#scan-status').textContent = 'No barcode found';
      return;
    }
    scanFeedback(store.settings.beep);
    if (ui.add.mode === 'scan' && !scanner?.running) setAddMode('search', { focus: false });
    await resolveBarcode(code.value, code.format);
  } catch (error) {
    toast(cameraErrorMessage(error));
  }
}

function bindEvents() {
  document.addEventListener('click', onClick);

  $$('dialog.sheet').forEach(dialog => {
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeSheet(dialog.id); });
    dialog.addEventListener('click', event => { if (event.target === dialog) closeSheet(dialog.id); });
  });

  // A message waits while a finger is on it, and gives a keyboard longer to reach its buttons.
  ['#slip', '#toast'].forEach(selector => {
    const el = $(selector);
    el.addEventListener('pointerdown', () => { notice.held = true; clearTimeout(notice.timer); });
    const release = () => {
      if (!notice.held) return;
      notice.held = false;
      if (notice.el) armNotice(6000);
    };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => el.addEventListener(type, release));
    el.addEventListener('focusin', () => { if (notice.el) armNotice(10000); });
  });

  // Esc turns the can back round, or puts a "how many?" away.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || openSheets.length) return;
    if (ui.pack) closePack();
    else if (ui.back) closeBack();
  });
  // A finger on a chip rail is choosing: do not scroll the rail from under it.
  document.addEventListener('pointerdown', event => {
    if (event.target.closest?.('.rail-chips')) railTouched = performance.now();
  }, { capture: true, passive: true });

  // Find
  $('#inv-search').addEventListener('input', debounce(() => renderFind(), 120));
  $('#inv-search').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    ($('#inventory-list .inv-row') || $('#find-extra .result-main'))?.click();
  });
  // Dragging the list puts the keyboard away, so the whole list can be seen.
  $('#find-list').addEventListener('touchmove', () => {
    if (document.activeElement === $('#inv-search')) $('#inv-search').blur();
  }, { passive: true });
  $('#inv-sort').addEventListener('change', event => {
    lineups.inv.sort = event.target.value;
    renderFind();
    if (ui.screen === 'screen-home') renderHome();
  });
  $$('[data-group-by]').forEach(select => {
    select.innerHTML = GROUPINGS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    select.addEventListener('change', () => updateSettings({ [`${select.dataset.groupBy}Group`]: select.value }));
  });

  setupCountCtl('inv', 'inv-count-ctl');
  window.addEventListener('pagehide', flushCount);

  // Discover keeps each row of cards where it was left.
  $('#discover-panel').addEventListener('scroll', event => {
    if (ui.discover && event.target.classList?.contains('h-scroll')) ui.discoverScroll[ui.discover] = event.target.scrollLeft;
  }, { capture: true, passive: true });

  // The scanner sheet
  $('#add-query').addEventListener('input', debounce(() => renderAddResults(), 90));
  $('#add-query').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const digits = digitsOnly(event.target.value);
    if (digits.length >= 8 && /^[\d\s-]+$/.test(event.target.value.trim())) resolveBarcode(digits);
    else $('#add-results .result-main')?.click();
  });
  $('#rapid-toggle').addEventListener('change', event => updateSettings({ rapidScan: event.target.checked }));
  ['#photo-input', '#photo-input-2'].forEach(selector => $(selector).addEventListener('change', event => handlePhoto(event.target)));

  // Home base: the same small form in Settings and under Discover's "Near you".
  document.addEventListener('submit', event => {
    const form = event.target.closest?.('[data-loc-form]');
    if (!form) return;
    event.preventDefault();
    setLocation(locateQuery($('[data-loc-input]', form).value), 'Looking that up…', form);
  });

  $('#item-form').addEventListener('submit', submitForm);
  $('#who-form').addEventListener('submit', saveWho);
  $('#f-type').addEventListener('change', event => { ui.form.touchedType = true; fillStyleOptions(event.target.value, $('#f-style').value); if (!$('#f-size').value || SIZES.includes($('#f-size').value)) $('#f-size').value = TYPE_META[event.target.value]?.size || ''; });
  $('#f-style').addEventListener('change', () => { ui.form.touchedStyle = true; });
  $('#f-name').addEventListener('input', debounce(event => {
    if (!ui.form || ui.form.mode === 'edit') return;
    const text = `${event.target.value} ${$('#f-brand').value}`;
    if (!ui.form.touchedType) {
      const type = inferType(text);
      if (type && type !== $('#f-type').value) { fillTypeOptions(type); fillStyleOptions(type, ''); $('#f-size').value = TYPE_META[type]?.size || ''; }
    }
    if (!ui.form.touchedStyle) {
      const style = inferStyle(text, $('#f-type').value);
      if (style) fillStyleOptions($('#f-type').value, style);
    }
  }, 200));

  $('#s-name').addEventListener('input', debounce(event => updateSettings({ fridgeName: event.target.value.trim() || "Uncle Mike's Beer Fridge" }), 300));
  $('#s-rapid').addEventListener('change', event => updateSettings({ rapidScan: event.target.checked }));
  $('#s-beep').addEventListener('change', event => updateSettings({ beep: event.target.checked }));
  $('#s-par').addEventListener('change', event => updateSettings({ defaultPar: Math.max(0, Math.round(Number(event.target.value) || 0)) }));
  $('#s-proxy').addEventListener('change', event => updateSettings({ upcProxy: event.target.value.trim() }));
  $('#s-import').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      importData(await file.text());
      ui.lastUndo = null;
      closeSheet('sheet-settings', { then: () => { showScreen('screen-home'); toast('Backup restored', { tone: 'ok' }); } });
    } catch (error) {
      toast(error.message || 'That file couldn’t be imported');
    }
  });

  window.addEventListener('hashchange', () => {
    const { route, params } = parseHash();
    if (route === 'menu' && params.get('s')) { location.reload(); return; }
    if (ui.guest) return;
    if (route === 'stock' && params.get('l')) { takeStockLink(params.get('l')); return; }
    if (route === 'scan') { // the Home Screen shortcut, while the app is already open
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      openAdd('scan');
      return;
    }
    if (ROUTES[route] && ROUTES[route] !== ui.screen) showScreen(ROUTES[route], { updateUrl: false });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { scanner?.stop(); flushCount(); }
    else if ($('#sheet-add').open && ui.add.mode === 'scan') startScanner();
  });

  subscribe(() => {
    ui.version += 1;
    renderScreen();
    if ($('#sheet-item').open && !$('#sheet-item').dataset.closing) renderItemSheet();
    if ($('#sheet-find').open && !$('#sheet-find').dataset.closing) renderFind();
  });
}

// ---------------------------------------------------------------------------
// Startup

/**
 * Link fridge entries to the catalog, then fold doubles into one.
 *
 * The same drink can be in the fridge twice: once added by hand, often with the brewery spelled
 * the way dictation heard it ("Dewclaw"), and once from the catalog with its real label. A
 * hand-added entry whose name is exactly a catalog drink that is already in the fridge is that
 * drink, even if the brewery spelling scores too low to link on its own.
 * Returns a line for each merge, for the owner to read.
 */
function hydrateCatalogLinks() {
  let changed = false;
  const owned = new Set(store.items.map(item => item.catalogId).filter(Boolean));
  store.items.forEach(item => {
    if (item.catalogId && getCatalogItem(item.catalogId)) return;
    const best = matchCandidates({ name: item.name, brand: item.brand })[0];
    if (!best) return;
    const sameName = [best.item.name, ...best.item.aka].some(name => fold(name) === fold(item.name));
    const isDouble = owned.has(best.item.id) && sameName && best.score >= 0.72;
    if (isDouble || best.score >= (item.brand ? 0.8 : 0.86)) {
      linkCatalog(item, best.item);
      changed = true;
    }
  });

  const groups = new Map();
  store.items.forEach(item => {
    if (item.catalogId) groups.set(item.catalogId, [...(groups.get(item.catalogId) || []), item]);
  });
  const merged = [];
  groups.forEach((entries, catalogId) => {
    if (entries.length < 2) return;
    const catalogItem = getCatalogItem(catalogId);
    // Keep the entry that already reads like the catalog; it carries the right name and brewery.
    const keeper = entries.find(item => catalogItem && fold(item.name) === fold(catalogItem.name) && fold(item.brand) === fold(catalogItem.brand)) || entries[0];
    entries.filter(item => item !== keeper).forEach(item => mergeItems(keeper.id, item.id));
    if (catalogItem) Object.assign(keeper, { name: catalogItem.name, brand: catalogItem.brand });
    merged.push(`${fullName(keeper)}: ${entries.length} entries merged into one, ${keeper.count} on hand`);
    changed = true;
  });
  if (changed) persist('link');
  return merged;
}

/** Open a fridge list that arrived in the link, and take it out of the address bar. */
function takeStockLink(token) {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (ui.screen !== 'screen-home') showScreen('screen-home', { updateUrl: false });
  openStockList(token);
}

/** A guest's menu snapshot carries no catalog ids; match by name so real labels show. */
function hydrateGuestLabels() {
  if (!ui.guest) return;
  ui.guest.items.forEach(item => {
    const best = matchCandidates({ name: item.name, brand: item.brand })[0];
    if (!best || best.score < (item.brand ? 0.8 : 0.9)) return;
    item.catalogId = best.item.id;
    item.size ||= best.item.size;
  });
}

/** The first load is over: show the shelf (the house list, or the samples if it could not load). */
function endBoot() {
  if (!ui.booting) return;
  ui.booting = false;
  renderScreen();
}

async function init() {
  const result = load();
  bindEvents();
  const { route, params } = parseHash();
  const snapshot = route === 'menu' && params.get('s');
  if (snapshot) {
    try {
      ui.guest = await decodeSnapshot(snapshot);
      document.body.classList.add('is-guest');
      document.title = `${ui.guest.name} · Menu`;
    } catch {
      toast('That menu link looks incomplete. Showing this device’s fridge instead.');
    }
  }
  ui.breweries = cachedBreweries(store.settings.location);
  // A brand-new device shows a quiet shelf until its own fridge has loaded, not the sample drinks.
  ui.booting = !ui.guest && houseEnabled && store.items.length > 0 && sampleItems().length === store.items.length
    && !(store.settings.stockLists || []).some(entry => String(entry.key).startsWith('house:'));
  showScreen(ui.guest ? 'screen-menu' : ROUTES[route] || 'screen-home', { updateUrl: !ROUTES[route] && route !== '' });
  if (result === 'migrated') toast('Your fridge was upgraded. Everything carried over.');
  if (route === 'scan' && !ui.guest) openAdd('scan'); // home-screen shortcut
  if (route === 'stock' && params.get('l') && !ui.guest) takeStockLink(params.get('l'));

  houseReady = loadCatalog().then(() => {
    const merged = ui.guest ? [] : hydrateCatalogLinks();
    hydrateGuestLabels();
    ui.breweries = cachedBreweries(store.settings.location);
    ui.version += 1;
    renderScreen();
    if (store.settings.location && breweriesStale(store.settings.location)) refreshBreweries();
    return autoStock(merged);
  }).catch(error => console.warn('House list not loaded', error)).finally(endBoot);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

init();
