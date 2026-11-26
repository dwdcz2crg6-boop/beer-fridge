// Uncle Mike's Beer Fridge: UI controller.
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
  importData, learnedProduct, linkCatalog, load, persist, rateItem, removeFromBeerRun, resetDemo, sampleItems, saveItem, stockBatch, stockIn, stockListLoaded, store, subscribe, updateSettings, attachBarcode,
} from './store.js';

// ---------------------------------------------------------------------------
// UI state

const ui = {
  screen: 'screen-home',
  cart: {},
  guest: null,
  browseType: 'all',
  breweries: [],
  breweriesExpanded: false,
  breweriesLoading: false,
  add: { mode: 'scan', pending: null, candidate: null, qty: 1, alts: [], session: [], unknown: null, lookupToken: 0 },
  itemId: null,
  itemContext: 'owner',
  form: null,
  rateIds: [],
  rated: {},
  shareUrl: '',
  version: 0,
};

// The two browsable lineups (the owner's fridge and the order menu) share the
// type chips, grouping, Cover Flow and group map.
const newLineup = (id, sort) => ({ id, type: 'all', group: 'all', query: '', sort, grouping: 'style', flowId: null, signature: '', mapKey: '', types: [], groups: [], groupOf: new Map(), shown: [], filterable: false, flow: null });
const lineups = { inv: newLineup('inv', 'count'), menu: newLineup('menu', 'name') };

let scanner = null;
let suggestionCache = null;
let suggestionKey = '';

const ROUTES = { '': 'screen-home', menu: 'screen-menu', discover: 'screen-discover', activity: 'screen-activity' };
const parPlaceholder = () => store.settings.defaultPar;

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

function renderLineupControls(lineup, list) {
  const { id } = lineup;
  const fill = (el, html) => {
    const left = el.scrollLeft; // keep a scrolled chip row where the person left it
    el.innerHTML = html;
    el.scrollLeft = left;
  };
  fill($(`#${id}-type-chips`), chipsHtml([{ value: 'all', label: 'All', count: list.length }, ...lineup.types.map(type => ({ value: type, label: typeChip(type), count: list.filter(item => item.type === type).length }))], lineup.type, `${id}-type`));
  $(`#${id}-type-chips`).hidden = !list.length;
  $(`#${id}-group-row`).hidden = !list.length;
  const select = $(`#${id}-group-by`);
  if (select.value !== lineup.grouping) select.value = lineup.grouping;
  const chips = $(`#${id}-group-chips`);
  chips.hidden = !lineup.filterable;
  fill(chips, lineup.filterable
    ? chipsHtml([{ value: 'all', label: 'All' }, ...lineup.groups.map(group => ({ value: group.key, label: group.label, dot: group.dot, count: group.count }))], lineup.group, `${id}-group`)
    : '');
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
// Cover Flow (one per lineup)

const cardKey = item => [item.id, item.count > 0 ? 1 : 0, item.name, item.brand, item.style, item.abv, item.size, item.type, labelFor(item)?.src || ''].join('~');

function flowCard(item) {
  const out = item.count <= 0;
  // .cf-inner carries the 3D tilt. The card itself must stay flat: scroll-snap measures it,
  // and a tilted card snaps off center and gets skipped by a swipe.
  return `<button class="cf-card${out ? ' is-out' : ''}" type="button" role="option" data-id="${item.id}" aria-label="${esc(fullName(item))}${out ? ', out of stock' : ''}"><span class="cf-inner"><span class="cf-art">${art(item)}</span>${out ? '<span class="cf-flag">Out</span>' : ''}</span></button>`;
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

/** Take a drink off the shelf (the flick-up gesture). Confirms with a message that offers Undo. */
function removeFromFridge(lineup, index) {
  const item = lineup.shown[index];
  if (!item || ui.guest) return;
  flushCount(); // a count change still waiting to save belongs to the ledger first
  // Keep the shelf where it is: the next can slides into the gap.
  lineup.flowId = (lineup.shown[index + 1] || lineup.shown[index - 1])?.id || null;
  const onHand = item.count;
  const result = deleteItem(item.id);
  if (!result) return;
  delete ui.cart[item.id];
  toast(`${fullName(item)} removed from the fridge${onHand ? ` (${onHand} on hand)` : ''}`, {
    undo: () => {
      lineup.flowId = item.id;
      result.undo();
    },
    tone: 'ok',
  });
}

function renderFlow(lineup) {
  lineup.flow ||= createCoverflow($(`#${lineup.id}-coverflow`), {
    onChange: index => {
      lineup.flowId = lineup.shown[index]?.id || null;
      renderFlowCaption(lineup);
      markMap(lineup);
    },
    onActivate: index => {
      const item = lineup.shown[index];
      if (item) openItem(item.id, lineup.id === 'inv' ? 'owner' : 'guest');
    },
    // The owner's shelf only: press and hold a can, flick it up, and it leaves the fridge.
    onFlickUp: lineup.id === 'inv' ? index => removeFromFridge(lineup, index) : null,
  });
  preloadLabels(lineup.shown);
  const signature = lineup.shown.map(cardKey).join('|');
  if (signature !== lineup.signature) {
    lineup.signature = signature;
    const index = Math.max(0, lineup.shown.findIndex(item => item.id === lineup.flowId));
    lineup.flow.setCards(lineup.shown.map(flowCard).join(''), { index });
  } else {
    // Hidden screens lose their scroll position; put the active drink back in the middle.
    const index = lineup.shown.findIndex(item => item.id === lineup.flowId);
    if (index >= 0 && lineup.flow.index !== index) lineup.flow.goTo(index, false);
    lineup.flow.refresh();
  }
  renderMap(lineup);
  renderFlowCaption(lineup);
}

/** A strip under the shelf: one segment per group, sized by how many drinks it holds. Tap to jump. */
function renderMap(lineup) {
  const el = $(`#${lineup.id}-map`);
  const show = showsGroups(lineup);
  el.hidden = !show;
  const key = show ? lineup.shown.map(item => lineup.groupOf.get(item.id).key).join('|') : '';
  if (key !== lineup.mapKey) {
    lineup.mapKey = key;
    const segments = [];
    if (show) {
      lineup.shown.forEach((item, index) => {
        const group = lineup.groupOf.get(item.id);
        const last = segments.at(-1);
        if (last && last.group.key === group.key) last.count += 1;
        else segments.push({ group, index, count: 1 });
      });
    }
    el.innerHTML = segments.map(({ group, index, count }) => `<button type="button" class="cf-seg" style="flex:${count};--seg:${group.dot}" data-jump="${lineup.id}" data-index="${index}" data-group="${esc(group.key)}" aria-label="Jump to ${esc(group.label)}, ${plural(count, 'drink')}"><i></i></button>`).join('');
  }
  markMap(lineup);
}

function markMap(lineup) {
  const current = lineup.groupOf.get(lineup.flowId)?.key;
  $$(`#${lineup.id}-map .cf-seg`).forEach(segment => segment.classList.toggle('is-current', segment.dataset.group === current));
}

function flowItem(lineup) {
  return lineup.shown.find(entry => entry.id === lineup.flowId) || lineup.shown[0] || null;
}

function capPosition(lineup, item) {
  const group = lineup.grouping !== 'none' && lineup.groupOf.get(item.id);
  return `<p class="cap-pos">${group ? `<span class="cap-group"><i class="dot" style="background:${group.dot}"></i>${esc(group.label)}</span>` : ''}<span class="cap-count">${lineup.shown.indexOf(item) + 1} of ${lineup.shown.length}</span></p>`;
}

function renderFlowCaption(lineup) {
  if (lineup.id === 'inv') renderInvCaption();
  else renderCaption();
}

// ---------------------------------------------------------------------------
// Count wheel: slide to correct what's on hand. It saves itself a moment after
// the wheel stops, then confirms with a message that offers Undo.

const countCtls = {};
const countEdit = { itemId: null, value: 0, timer: 0 };
const COUNT_HINT = 'Slide the wheel or tap ± to change';
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

/** The wheel is moving: remember where it is, hold off saving. */
function previewCount(itemId, value) {
  if (countEdit.itemId && countEdit.itemId !== itemId) flushCount();
  clearTimeout(countEdit.timer);
  countEdit.itemId = itemId;
  countEdit.value = value;
  renderCountNotes();
}

/** The wheel stopped: save shortly unless it starts moving again. */
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

/** Save a pending wheel change now and confirm it. */
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
  const result = adjustCount(item.id, value);
  if (result) toast(`${fullName(item)}: now ${value} on hand (was ${before})`, { undo: result.undo, tone: 'ok' });
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
// Sheets (native <dialog>) and toast

function openSheet(id) {
  const dialog = $(`#${id}`);
  if (dialog.open) return dialog;
  dialog.classList.remove('is-closing');
  dialog.showModal();
  document.body.classList.add('has-sheet');
  return dialog;
}

function closeSheet(id) {
  const dialog = $(`#${id}`);
  if (!dialog.open || dialog.classList.contains('is-closing')) return;
  dialog.classList.add('is-closing');
  const finish = () => {
    dialog.classList.remove('is-closing');
    if (dialog.open) dialog.close();
    const toastEl = $('#toast');
    if (dialog.contains(toastEl)) ([...document.querySelectorAll('dialog[open]')].at(-1) || document.body).append(toastEl);
    sheetClosed(id);
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('has-sheet');
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
  else setTimeout(finish, 170);
}

function sheetClosed(id) {
  if (id === 'sheet-item') flushCount();
  if (id === 'sheet-add') {
    scanner?.stop();
    ui.add = { ...ui.add, pending: null, candidate: null, unknown: null, alts: [], qty: 1 };
    $('#add-query').value = '';
    $('#confirm').hidden = true;
    $('#sheet-add').classList.remove('has-confirm');
  }
  if (id === 'sheet-form' && ui.form?.returnTo === 'add' && $('#sheet-add').open) {
    if (ui.add.mode === 'scan' && !ui.add.candidate) scanner?.resume();
  }
}

let toastTimer;
function toast(message, { undo = null, duration = 3600, tone = '' } = {}) {
  const el = $('#toast');
  const host = [...document.querySelectorAll('dialog[open]')].at(-1) || document.body;
  if (el.parentElement !== host) host.append(el);
  $('#toast-text').textContent = message;
  el.classList.toggle('is-ok', tone === 'ok');
  const action = $('#toast-action');
  action.hidden = !undo;
  action.onclick = undo ? () => { undo(); hideToast(); setTimeout(() => toast('Undone'), 120); } : null;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 6000 : duration);
}

function hideToast() {
  $('#toast').classList.remove('is-visible');
}

/** Two-tap confirmation for destructive buttons. */
function armed(button, label, action) {
  if (button.dataset.armed === 'true') {
    button.dataset.armed = 'false';
    button.classList.remove('is-armed');
    button.innerHTML = button.dataset.original;
    action();
    return;
  }
  button.dataset.original = button.innerHTML;
  button.dataset.armed = 'true';
  button.classList.add('is-armed');
  button.textContent = label;
  setTimeout(() => {
    if (button.dataset.armed === 'true') {
      button.dataset.armed = 'false';
      button.classList.remove('is-armed');
      button.innerHTML = button.dataset.original;
    }
  }, 3500);
}

// ---------------------------------------------------------------------------
// Routing

function parseHash() {
  let raw = location.hash.slice(1);
  try { raw = decodeURIComponent(raw); } catch { /* keep the raw hash */ }
  const [route = '', query = ''] = raw.split('?');
  return { route, params: new URLSearchParams(query) };
}

function showScreen(id, { updateUrl = true } = {}) {
  flushCount();
  ui.screen = id;
  $$('.screen').forEach(screen => screen.classList.toggle('is-active', screen.id === id));
  $$('.tab[data-screen]').forEach(tab => {
    const active = tab.dataset.screen === id;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  if (updateUrl && !ui.guest) {
    const route = $(`#${id}`).dataset.route;
    history.replaceState(null, '', route ? `#${route}` : location.pathname + location.search);
  }
  window.scrollTo({ top: 0 });
  renderScreen();
}

function renderScreen() {
  if (ui.screen === 'screen-home') renderHome();
  if (ui.screen === 'screen-menu') renderMenu();
  if (ui.screen === 'screen-discover') renderDiscover();
  if (ui.screen === 'screen-activity') renderActivity();
  renderOrderBar();
}

// ---------------------------------------------------------------------------
// Suggestions (cached per data version)

function suggestions() {
  const location = store.settings.location;
  const key = [ui.version, catalogSize(), ui.breweries.length, location?.lat, location?.lng, store.settings.dismissed.length, new Date().toDateString()].join('|');
  if (suggestionCache && key === suggestionKey) return suggestionCache;
  const ctx = buildContext({ items: store.items, activity: store.activity, location, breweries: ui.breweries, dismissed: store.settings.dismissed });
  suggestionCache = { ctx, ...suggest(ctx, { items: store.items }) };
  suggestionKey = key;
  return suggestionCache;
}

function pickCard(entry, { compact = false } = {}) {
  const item = entry.item;
  return `<article class="pick${compact ? ' pick-compact' : ''}">
    <button class="pick-art" type="button" data-cat-stock="${esc(item.id)}" aria-label="Stock ${esc(item.fullName)}">${art(item)}</button>
    <div class="pick-body">
      <p class="pick-reason">${esc(entry.reason || '')}</p>
      <p class="brand-line">${esc(item.brand)}</p>
      <h3>${esc(item.name)}</h3>
      <p class="pick-meta">${esc(metaLine(item, { size: false }))}</p>
    </div>
    <div class="pick-actions">
      <button class="mini-btn" type="button" data-cat-run="${esc(item.id)}" aria-label="Add ${esc(item.fullName)} to the beer run"><svg aria-hidden="true"><use href="#i-list"/></svg>List</button>
      <button class="mini-btn mini-primary" type="button" data-cat-stock="${esc(item.id)}"><svg aria-hidden="true"><use href="#i-plus"/></svg>Stock</button>
    </div>
    <button class="pick-x" type="button" data-cat-dismiss="${esc(item.id)}" aria-label="Hide this suggestion"><svg><use href="#i-x"/></svg></button>
  </article>`;
}

// ---------------------------------------------------------------------------
// Fridge (home)

function renderHome() {
  const name = store.settings.fridgeName;
  $('#fridge-title').textContent = name;
  document.title = name;
  const items = store.items;
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const kinds = items.filter(item => item.count > 0).length;
  const low = lowStock(items, store.activity, store.settings.defaultPar);
  $('#hero-total').textContent = total;
  $('#hero-sub').textContent = `${plural(kinds, 'kind')} · ${low.length ? `${low.length} running low` : 'nothing running low'}`;
  const status = total === 0 ? 'Empty fridge' : low.length >= 3 ? 'Beer run time' : low.length ? 'Mostly stocked' : 'Stocked up';
  $('#hero-status span').textContent = status;
  $('#hero').dataset.state = total === 0 ? 'empty' : low.length >= 3 ? 'low' : 'ok';

  const byType = TYPES.map(type => ({ type, count: items.filter(item => item.type === type).reduce((sum, item) => sum + item.count, 0) })).filter(entry => entry.count);
  $('#hero-bar').innerHTML = byType.map(entry => `<span style="flex:${entry.count};background:${TYPE_META[entry.type].color}"></span>`).join('');
  $('#hero-legend').innerHTML = byType.map(entry => `<li><i style="background:${TYPE_META[entry.type].color}"></i>${esc(typeChip(entry.type))} <b>${entry.count}</b></li>`).join('');

  // Running low
  $('#low-section').hidden = !low.length;
  $('#low-list').innerHTML = low.map(({ item }) => `<article class="low-card">
      <button class="low-art" type="button" data-item="${item.id}" aria-label="Open ${esc(fullName(item))}">${art(item)}</button>
      <div class="low-text"><p class="brand-line">${esc(item.brand)}</p><b>${esc(item.name)}</b><span class="low-left${item.count === 0 ? ' is-out' : ''}">${item.count === 0 ? 'Out' : `${item.count} left`}</span></div>
      <button class="mini-btn mini-primary" type="button" data-restock="${item.id}"><svg aria-hidden="true"><use href="#i-plus"/></svg>Restock</button>
    </article>`).join('');

  // Smart picks
  const picks = catalogSize() ? suggestions().top : [];
  $('#picks-section').hidden = !picks.length;
  $('#home-picks').innerHTML = picks.map(entry => pickCard(entry, { compact: true })).join('');

  // The lineup: Cover Flow or list, grouped the way the owner chose.
  const view = store.settings.invView === 'list' ? 'list' : 'flow';
  lineups.inv.query = view === 'list' ? $('#inv-search').value : ''; // search and sort belong to the list
  const lineup = organize(lineups.inv, items, groupingSetting('invGroup'));
  renderLineupControls(lineup, items);
  $$('#inv-view [data-inv-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.invView === view)));
  const empty = !lineup.shown.length;
  $('.lineup-tools').hidden = !items.length || view !== 'list';
  $('#inv-flow').hidden = empty || view !== 'flow';
  $('#inventory-list').hidden = empty || view !== 'list';
  $('#inv-empty').hidden = !empty;
  if (empty) {
    $('#inv-empty').innerHTML = items.length
      ? emptyHtml('No matches', 'Try a different search or filter.')
      : emptyHtml('The fridge is empty', 'Scan a can or add a drink by name to get started.', '<button class="btn btn-small" type="button" data-open-add="scan">Scan the first drink</button>');
  } else if (view === 'flow') {
    renderFlow(lineup);
  } else {
    $('#inventory-list').innerHTML = groupedHtml(lineup, item => {
      const isLow = item.count <= parOf(item);
      return `<button class="inv-row${item.count === 0 ? ' is-out' : ''}" type="button" data-item="${item.id}">
        <span class="thumb">${art(item)}</span>
        <span class="inv-text"><span class="brand-line">${esc(item.brand || typeChip(item.type))}</span><b>${esc(item.name)}</b><span class="inv-meta">${esc(metaLine(item, { size: false }))}</span></span>
        <span class="inv-count${isLow ? ' is-low' : ''}"><strong>${item.count}</strong><small>${item.count === 0 ? 'out' : isLow ? 'low' : 'on hand'}</small></span>
      </button>`;
    });
  }
}

/** Caption under the fridge Cover Flow: the drink in the middle and its count wheel. */
function renderInvCaption() {
  const lineup = lineups.inv;
  const item = flowItem(lineup);
  if (!item) return;
  const low = item.count <= parOf(item);
  $('#inv-cap-info').innerHTML = `${capPosition(lineup, item)}
    <p class="brand-line">${esc(item.brand || typeChip(item.type))}</p>
    <h3 class="cap-name">${esc(item.name)}</h3>
    <p class="cap-meta">${esc(metaLine(item))}</p>
    <div class="cap-row">${starsHtml(item)}${item.count === 0 ? '<span class="cap-avail is-out">Out</span>' : low ? '<span class="cap-avail is-low">Running low</span>' : ''}</div>`;
  $('#inv-cap-actions').innerHTML = `<button class="btn btn-amber btn-small" type="button" data-restock="${item.id}"><svg aria-hidden="true"><use href="#i-in"/></svg>Stock in</button>
    <button class="btn btn-ghost btn-small" type="button" data-item="${item.id}">Details</button>`;
  syncCount(countCtls.inv, item);
}

// ---------------------------------------------------------------------------
// Menu + cover flow

function menuItems() {
  return ui.guest ? ui.guest.items.filter(item => item.count > 0) : store.items.filter(item => item.count > 0);
}

function renderMenu() {
  const available = menuItems();
  const guest = Boolean(ui.guest);
  $('#guest-banner').hidden = !guest;
  if (guest) {
    $('#guest-name').textContent = ui.guest.name;
    $('#guest-when').textContent = `Menu snapshot · shared ${relativeTime(ui.guest.at).toLowerCase()}`;
    $('#menu-eyebrow').textContent = 'What’s cold';
    $('#menu-title').textContent = 'Fridge Menu';
    $('#menu-subtitle').textContent = 'Swipe through the lineup. Grab what you like; the host keeps count.';
  } else {
    $('#menu-eyebrow').textContent = 'Available now';
    $('#menu-subtitle').textContent = 'Swipe through what’s cold. Tap a drink to add it to an order.';
  }

  const lineup = organize(lineups.menu, available, groupingSetting('menuGroup'));
  renderLineupControls(lineup, available);
  const shown = lineup.shown;
  const view = store.settings.menuView === 'grid' ? 'grid' : 'flow';
  $$('#menu-view [data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  const empty = !shown.length;
  $('#menu-flow').hidden = empty || view !== 'flow';
  $('#menu-grid').hidden = empty || view !== 'grid';
  $('#menu-empty').hidden = !empty;
  if (empty) {
    $('#menu-empty').innerHTML = available.length
      ? emptyHtml('Nothing in this category', 'Try another filter.')
      : emptyHtml('Nothing cold yet', guest ? 'The host hasn’t stocked anything in this snapshot.' : 'Stock the fridge and the menu fills itself.', guest ? '' : '<button class="btn btn-small" type="button" data-open-add="scan">Scan drinks in</button>');
  } else if (view === 'flow') {
    renderFlow(lineup);
  } else {
    renderGrid();
  }
  $('#share-card').hidden = guest;
  if (!guest) updateShare();
}

function orderControls(item, { large = false } = {}) {
  if (ui.guest) return '';
  const qty = ui.cart[item.id] || 0;
  if (!qty) return `<button class="btn btn-amber${large ? '' : ' btn-small'}" type="button" data-cart="${item.id}" data-delta="1"><svg aria-hidden="true"><use href="#i-plus"/></svg>Add to order</button>`;
  return `<div class="stepper${large ? ' stepper-lg' : ''}" role="group" aria-label="Order quantity for ${esc(fullName(item))}"><button type="button" data-cart="${item.id}" data-delta="-1" aria-label="Remove one"><svg><use href="#i-minus"/></svg></button><output>${qty}</output><button type="button" data-cart="${item.id}" data-delta="1" ${qty >= item.count ? 'disabled' : ''} aria-label="Add one"><svg><use href="#i-plus"/></svg></button></div>`;
}

function renderCaption() {
  const lineup = lineups.menu;
  const item = flowItem(lineup);
  if (!item) { $('#menu-caption').innerHTML = ''; return; }
  $('#menu-caption').innerHTML = `
    ${capPosition(lineup, item)}
    <p class="brand-line">${esc(item.brand || typeChip(item.type))}</p>
    <h2 class="cap-name">${esc(item.name)}</h2>
    <p class="cap-meta">${esc(metaLine(item))}</p>
    <div class="cap-row">${starsHtml(item, { count: !ui.guest })}<span class="cap-avail">${item.count} cold</span></div>
    <div class="cap-actions">${orderControls(item, { large: true })}
      ${ui.guest ? '' : `<button class="btn btn-ghost btn-small" type="button" data-rate-item="${item.id}"><svg aria-hidden="true"><use href="#i-star"/></svg>Rate</button>`}
      <button class="btn btn-ghost btn-small" type="button" data-menu-item="${item.id}">Details</button>
    </div>`;
}

function renderGrid() {
  $('#menu-grid').innerHTML = groupedHtml(lineups.menu, item => `<article class="menu-card${ui.cart[item.id] ? ' is-selected' : ''}">
      <button class="menu-card-art" type="button" data-menu-item="${item.id}" aria-label="Details for ${esc(fullName(item))}">${art(item)}</button>
      <p class="brand-line">${esc(item.brand || typeChip(item.type))}</p>
      <h3>${esc(item.name)}</h3>
      <p class="menu-card-meta">${esc(metaLine(item, { size: false }))}</p>
      <div class="menu-card-row">${starsHtml(item, { count: false })}<span class="cap-avail">${item.count}</span></div>
      ${orderControls(item)}
    </article>`);
}

const updateShare = debounce(async () => {
  if (ui.guest || ui.screen !== 'screen-menu') return;
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
}, 350);

function changeCart(id, delta) {
  const item = findItem(id);
  if (!item) return;
  const next = Math.max(0, Math.min(item.count, (ui.cart[id] || 0) + delta));
  if (next) ui.cart[id] = next;
  else delete ui.cart[id];
  if (delta > 0 && next === item.count && delta) toast(`That’s all the ${fullName(item)} in the fridge`);
  refreshCartViews();
}

function refreshCartViews() {
  renderOrderBar();
  if (ui.screen === 'screen-menu') {
    if (store.settings.menuView === 'grid') renderGrid();
    else renderCaption();
  }
  if ($('#sheet-item').open) renderItemSheet();
  if ($('#sheet-order').open) renderOrderSheet();
}

function cartLines() {
  return Object.entries(ui.cart).map(([id, qty]) => ({ item: findItem(id), qty })).filter(line => line.item && line.qty > 0);
}

function renderOrderBar() {
  const lines = cartLines();
  const count = lines.reduce((sum, line) => sum + line.qty, 0);
  const visible = count > 0 && ui.screen === 'screen-menu' && !ui.guest;
  $('#order-bar').hidden = !visible;
  document.body.classList.toggle('has-order', visible);
  $('#order-summary').textContent = `${plural(count, 'drink')} in your order`;
  const menuTab = $('.tab[data-screen="screen-menu"]');
  menuTab.dataset.badge = count ? String(count) : '';
}

// ---------------------------------------------------------------------------
// Discover

function renderDiscover() {
  const location = store.settings.location;
  $('#loc-label').textContent = location ? location.label : 'Set the fridge’s home base';
  $('#loc-change').hidden = !location;
  $('#loc-form').hidden = Boolean(location) && !ui.editingLocation;
  if (location) {
    const count = ui.breweries.length;
    $('#loc-status').textContent = ui.breweriesLoading ? 'Finding breweries nearby…' : count ? `${plural(count, 'brewery', 'breweries')} within 80 miles` : ui.breweriesError ? 'Couldn’t reach Open Brewery DB. Try again later.' : 'No breweries found nearby yet.';
  } else {
    $('#loc-status').textContent = 'See breweries near you and beers brewed in your state.';
  }

  const breweries = ui.breweries;
  $('#breweries-section').hidden = !location || (!breweries.length && !ui.breweriesLoading);
  const visible = ui.breweriesExpanded ? breweries : breweries.slice(0, 6);
  $('#breweries-more').hidden = breweries.length <= 6;
  $('#breweries-more').textContent = ui.breweriesExpanded ? 'Show fewer' : `Show all ${breweries.length}`;
  $('#breweries-list').innerHTML = ui.breweriesLoading && !breweries.length
    ? '<p class="muted">Finding breweries…</p>'
    : visible.map(brewery => `<article class="brewery">
        <div class="brewery-top">
          <div><b>${esc(brewery.name)}</b><span>${esc(brewery.typeLabel)} · ${esc(brewery.city)}${brewery.state ? `, ${esc(brewery.state)}` : ''}</span></div>
          <span class="miles">${brewery.miles < 1 ? '<1' : Math.round(brewery.miles)} mi</span>
        </div>
        ${brewery.beers.length ? `<div class="brewery-beers">${brewery.beers.map(beer => `<button class="beer-chip" type="button" data-cat-stock="${esc(beer.id)}"><i class="dot" style="background:${familyColor(beer.type, beer.family)}"></i>${esc(beer.name)}</button>`).join('')}</div>` : ''}
        <div class="brewery-actions">
          <button class="mini-btn" type="button" data-brewery-add="${esc(brewery.id)}"><svg aria-hidden="true"><use href="#i-plus"/></svg>Add a beer from here</button>
          ${/^https?:\/\//i.test(brewery.url) ? `<a class="mini-btn" href="${esc(brewery.url)}" target="_blank" rel="noopener noreferrer"><svg aria-hidden="true"><use href="#i-globe"/></svg>Website</a>` : ''}
        </div>
      </article>`).join('');

  renderBeerRun();

  // Everything below needs the drink catalog.
  const catalogLoaded = catalogSize() > 0;
  ['#occasion-section', '#local-section', '#seasonal-section', '#browse-section'].forEach(selector => { if (!catalogLoaded) $(selector).hidden = true; });
  $('#foryou-section').hidden = false;
  if (!catalogLoaded) {
    $('#gaps-list').innerHTML = '';
    $('#foryou-list').innerHTML = `<p class="muted">${catalogReady() ? 'The drink catalog couldn’t load. Check your connection and reload.' : 'Loading the drink catalog…'}</p>`;
    return;
  }
  $('#seasonal-section').hidden = false;
  $('#browse-section').hidden = false;
  const data = suggestions();
  const { ctx } = data;

  $('#occasion-section').hidden = !(ctx.occasion && data.occasion.length);
  if (ctx.occasion) {
    $('#occasion-title').textContent = ctx.occasion.label;
    $('#occasion-blurb').textContent = ctx.occasion.blurb;
    $('#occasion-list').innerHTML = data.occasion.map(entry => pickCard(entry)).join('');
  }

  $('#gaps-list').innerHTML = data.gaps.map(gap => `<section class="section gap-card"><div class="section-head"><div><p class="eyebrow warn">Fill a gap</p><h2>${esc(gap.title)}</h2><p class="section-blurb">${esc(gap.blurb)}</p></div></div><div class="h-scroll">${gap.picks.map(entry => pickCard(entry)).join('')}</div></section>`).join('');

  $('#local-section').hidden = !data.local.length;
  $('#local-title').textContent = ctx.userState ? `Brewed near ${location?.city || 'you'}` : 'Brewed near you';
  $('#local-list').innerHTML = data.local.map(entry => pickCard(entry)).join('');

  $('#foryou-reason').textContent = data.favorites.length ? `Because you like ${data.favorites.slice(0, 2).join(' & ')}` : 'Based on ratings, checkouts and the season';
  $('#foryou-list').innerHTML = data.forYou.map(entry => pickCard(entry)).join('') || '<p class="muted">Rate a few drinks to get personal picks.</p>';

  $('#seasonal-title').textContent = `${SEASON_LABEL[currentSeason()]} picks`;
  $('#seasonal-list').innerHTML = data.seasonal.map(entry => pickCard(entry)).join('');

  renderBrowse();
}

function renderBeerRun() {
  const low = lowStock(store.items, store.activity, store.settings.defaultPar);
  const auto = low.filter(({ item }) => !store.beerRun.some(entry => entry.itemId === item.id));
  const rows = [
    ...auto.map(({ item }) => `<div class="run-row run-auto"><span class="run-dot" aria-hidden="true"></span><div><b>${esc(fullName(item))}</b><small>${item.count === 0 ? 'Out of stock' : `Low: ${item.count} left`}</small></div><button class="mini-btn" type="button" data-restock="${item.id}">Got it</button></div>`),
    ...store.beerRun.map(entry => `<div class="run-row"><span class="run-dot run-saved" aria-hidden="true"></span><div><b>${esc(entry.brand && !fold(entry.name).includes(fold(entry.brand).split(' ')[0]) ? `${entry.brand} ${entry.name}` : entry.name)}</b><small>${esc(entry.style || 'On the list')}</small></div><button class="mini-btn" type="button" data-run-got="${entry.id}">Got it</button><button class="icon-btn icon-btn-small" type="button" data-run-remove="${entry.id}" aria-label="Remove ${esc(entry.name)}"><svg><use href="#i-x"/></svg></button></div>`),
  ];
  $('#run-list').innerHTML = rows.join('') || '<p class="muted">Nothing on the list. Tap <b>List</b> on any pick, and low stock shows up here on its own.</p>';
  $('#run-share').hidden = !rows.length;
}

function beerRunText() {
  const low = lowStock(store.items, store.activity, store.settings.defaultPar).filter(({ item }) => !store.beerRun.some(entry => entry.itemId === item.id));
  const lines = [
    ...low.map(({ item }) => `• ${fullName(item)}${item.count === 0 ? ' (out)' : ` (${item.count} left)`}`),
    ...store.beerRun.map(entry => `• ${entry.brand && !fold(entry.name).includes(fold(entry.brand).split(' ')[0]) ? `${entry.brand} ${entry.name}` : entry.name}`),
  ];
  return `Beer run for ${store.settings.fridgeName}:\n${lines.join('\n')}`;
}

function renderBrowse() {
  const all = catalogItems();
  $('#browse-count').textContent = `${all.length} drinks in the catalog`;
  const types = TYPES.filter(type => all.some(item => item.type === type));
  $('#browse-chips').innerHTML = chipsHtml([{ value: 'all', label: 'All' }, ...types.map(type => ({ value: type, label: typeChip(type) }))], ui.browseType, 'browse-type');
  const query = $('#browse-input').value.trim();
  const { ctx } = suggestions();
  const boost = searchBoost(ctx);
  const type = ui.browseType === 'all' ? null : ui.browseType;
  const results = query
    ? searchCatalog(query, { limit: 40, type, boost })
    : all.filter(item => !type || item.type === type).map(item => ({ item, score: item.pop + boost(item) })).sort((a, b) => b.score - a.score).slice(0, 24).map(entry => entry.item);
  $('#browse-list').innerHTML = results.map(item => resultRow(item, { actions: true })).join('') || '<p class="muted">No drinks match that search.</p>';
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

async function setLocation(promise, statusText) {
  const status = $('#loc-status');
  status.textContent = statusText;
  try {
    const location = await promise;
    ui.editingLocation = false;
    updateSettings({ location });
    toast(`Home base set to ${location.label}`);
    await refreshBreweries(true);
  } catch (error) {
    status.textContent = error.message || 'Couldn’t set the location.';
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
  renderScreen();
}

// ---------------------------------------------------------------------------
// Activity

function renderActivity() {
  const week = Date.now() - 7 * 86400000;
  const recent = store.activity.filter(entry => entry.at && new Date(entry.at).getTime() >= week);
  const sum = kind => recent.filter(entry => entry.kind === kind).reduce((total, entry) => total + entry.qty, 0);
  const tally = key => {
    const counts = {};
    recent.filter(entry => entry.kind === 'out' && entry[key]).forEach(entry => { counts[entry[key]] = (counts[entry[key]] || 0) + entry.qty; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  };
  const topDrink = tally('name');
  const topPerson = tally('by');
  $('#act-stats').innerHTML = `
    <div class="stat"><span>In this week</span><b class="stat-in">+${sum('in')}</b></div>
    <div class="stat"><span>Out this week</span><b class="stat-out">−${sum('out')}</b></div>
    <div class="stat stat-wide"><span>Most popular</span><b>${esc(topDrink ? topDrink[0] : '—')}</b>${topPerson ? `<small>Top grabber: ${esc(topPerson[0])} (${topPerson[1]})</small>` : ''}</div>`;

  if (!store.activity.length) {
    $('#activity-list').innerHTML = emptyHtml('No activity yet', 'Stock-ins and checkouts will show up here.');
    return;
  }
  const groups = [];
  store.activity.slice(0, 250).forEach(entry => {
    const label = entry.at ? dayLabel(entry.at) : 'Earlier';
    const group = groups.at(-1);
    if (group?.label === label) group.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  });
  const icon = { in: 'i-in', out: 'i-out', adjust: 'i-edit' };
  $('#activity-list').innerHTML = groups.map(group => `<h3 class="day-label">${esc(group.label)}</h3>
    ${group.entries.map(entry => {
      const verb = entry.kind === 'in' ? `Stocked ${entry.qty}` : entry.kind === 'out' ? `Took ${entry.qty}` : `Count ${entry.qty > 0 ? '+' : '−'}${Math.abs(entry.qty)}`;
      const sub = entry.kind === 'out' ? (entry.by ? `by ${entry.by}` : 'Checked out') : entry.kind === 'in' ? 'Added to the fridge' : 'Count corrected';
      return `<div class="act-row act-${entry.kind}">
        <span class="act-icon"><svg aria-hidden="true"><use href="#${icon[entry.kind] || 'i-edit'}"/></svg></span>
        <div class="act-text"><b>${esc(verb)} · ${esc(entry.name)}</b><small>${esc(sub)}</small></div>
        <time ${entry.at ? `datetime="${entry.at}"` : ''}>${esc(entry.at ? formatTime(entry.at) : entry.whenLabel || '')}</time>
      </div>`;
    }).join('')}`).join('');
}

// ---------------------------------------------------------------------------
// Add drinks: scan, search, confirm

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

const fromItem = item => ({ ...item, itemId: item.id });

function openAdd(mode = 'scan', preset = {}) {
  primeAudio();
  ui.add = { mode, pending: null, candidate: null, qty: 1, alts: [], session: ui.add.session && $('#sheet-add').open ? ui.add.session : [], unknown: null, lookupToken: 0 };
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
  const data = candidate.itemId ? { id: candidate.itemId } : { ...candidate };
  const result = stockIn(data, qty, ui.add.pending || {});
  if (candidate.catalogId && !result.item.catalogId) {
    const catalogItem = getCatalogItem(candidate.catalogId);
    if (catalogItem) { linkCatalog(result.item, catalogItem); persist('link'); }
  }
  ui.add.session.unshift({ name: fullName(result.item), qty });
  renderSession();
  toast(`Added ${qty} × ${fullName(result.item)}${result.checkedOff ? ' · checked off the beer run' : ''}`, { undo: result.undo });
  const keepGoing = $('#rapid-toggle').checked;
  ui.add.candidate = null;
  ui.add.pending = null;
  ui.add.qty = 1;
  $('#confirm').hidden = true;
  $('#sheet-add').classList.remove('has-confirm');
  if (!keepGoing) {
    closeSheet('sheet-add');
    return;
  }
  $('#add-query').value = '';
  renderAddResults();
  if (ui.add.mode === 'scan') {
    scanner?.resume();
    $('#scan-status').textContent = 'Ready for the next one';
  }
}

function renderSession() {
  const session = ui.add.session || [];
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
// Item detail

function currentItem() {
  if (ui.itemContext === 'guest' && ui.guest) return ui.guest.items.find(item => item.id === ui.itemId) || null;
  return findItem(ui.itemId);
}

function openItem(id, context = 'owner') {
  ui.itemId = id;
  ui.itemContext = context;
  renderItemSheet();
  openSheet('sheet-item');
  // The wheel can only be positioned once the sheet is on screen.
  const item = currentItem();
  if (item && context === 'owner' && !ui.guest) syncCount(countCtls.item, item);
}

const MAKER_KIND = { micro: 'Craft brewery', nano: 'Small-batch brewery', brewpub: 'Brewpub', regional: 'Regional brewery', large: 'Large brewery', contract: 'Contract-brewed', taproom: 'Taproom brewery', cidery: 'Cidery', meadery: 'Meadery' };

/** Beer note and the brewery card on the drink sheet; both come from the catalog. */
function renderBrewery(item) {
  const catalogItem = item.catalogId ? getCatalogItem(item.catalogId) : null;
  const desc = $('#item-desc');
  desc.textContent = catalogItem?.desc || '';
  desc.hidden = !catalogItem?.desc;
  const maker = makerOf(item);
  const card = $('#item-brewery');
  const hasInfo = Boolean(maker && (maker.about || maker.founded || maker.url));
  if (card.dataset.maker !== (hasInfo ? maker.id : '')) card.open = false; // a different brewery starts folded
  card.dataset.maker = hasInfo ? maker.id : '';
  card.hidden = !hasInfo;
  if (!hasInfo) return;
  const place = [maker.city, maker.state || (maker.country && maker.country !== 'US' ? maker.country : '')].filter(Boolean).join(', ');
  const home = store.settings.location;
  const miles = home && maker.lat != null && !ui.guest ? haversineMiles(home, maker) : null;
  $('#brewery-name').textContent = maker.name;
  $('#brewery-meta').textContent = [MAKER_KIND[maker.kind] || '', place, maker.founded ? `Since ${maker.founded}` : '', miles != null && miles <= 400 ? `${Math.max(1, Math.round(miles))} mi away` : ''].filter(Boolean).join(' · ');
  $('#brewery-about').textContent = maker.about || '';
  $('#brewery-about').hidden = !maker.about;
  const link = $('#brewery-link');
  const url = /^https:\/\//i.test(maker.url || '') ? maker.url : '';
  link.hidden = !url;
  if (url) {
    link.href = url;
    link.querySelector('span').textContent = new URL(url).hostname.replace(/^www\./, '');
  }
}

function renderItemSheet() {
  const item = currentItem();
  if (!item) { closeSheet('sheet-item'); return; }
  const owner = ui.itemContext === 'owner' && !ui.guest;
  $('#item-art').innerHTML = art(item, `${fullName(item)} artwork`);
  $('#item-brand').textContent = item.brand || typeChip(item.type);
  $('#item-name').textContent = item.name;
  const origin = originText(item);
  $('#item-origin').textContent = origin ? `${item.type === 'Beer' ? 'Brewed in' : 'From'} ${origin}` : '';
  $('#item-tags').innerHTML = [item.style, abvText(item) && `${abvText(item)} ABV`, item.size, item.type !== 'Beer' ? typeChip(item.type) : ''].filter(Boolean).map(tag => `<span class="tag-pill">${esc(tag)}</span>`).join('');
  renderBrewery(item);
  $('#item-rating').innerHTML = `${starsHtml(item, { count: !ui.guest })}${ui.guest ? '' : '<span class="rate-link">Rate</span>'}`;
  $('#item-rating').disabled = Boolean(ui.guest);
  $('#item-guest').hidden = owner;
  $('#item-available').textContent = `${item.count} cold and available`;
  $('#item-order-qty').textContent = ui.cart[item.id] || 0;
  $('#item-guest .stepper').hidden = Boolean(ui.guest);
  $('#item-owner').hidden = !owner;
  if (!owner) return;
  syncCount(countCtls.item, item);
  $('#item-par').textContent = item.par ?? store.settings.defaultPar;
  $('#item-par').classList.toggle('is-default', item.par == null);
  $('#item-codes').textContent = item.barcodes.length ? `Barcode${item.barcodes.length > 1 ? 's' : ''}: ${item.barcodes.map(displayCode).join(', ')}` : 'No barcode linked yet. Scan it once and it will be remembered.';
  const history = store.activity.filter(entry => entry.itemId === item.id).slice(0, 6);
  $('#item-history').innerHTML = history.length
    ? `<p class="results-title">History</p>${history.map(entry => `<div class="hist-row"><span class="hist-${entry.kind}">${entry.kind === 'in' || (entry.kind === 'adjust' && entry.qty > 0) ? '+' : '−'}${Math.abs(entry.qty)}</span><span>${entry.kind === 'in' ? 'Stocked' : entry.kind === 'out' ? `Taken${entry.by ? ` by ${esc(entry.by)}` : ''}` : 'Count corrected'}</span><time>${esc(entry.at ? relativeTime(entry.at) : entry.whenLabel || '')}</time></div>`).join('')}`
    : '';
}

// ---------------------------------------------------------------------------
// Fridge lists: a batch of drinks packed into a link (see tools/stock-link.mjs)

async function openStockList(text) {
  if (ui.guest) return;
  const token = stockToken(text);
  if (!token) { toast('That doesn’t look like a fridge list link'); return; }
  let list;
  try { list = await decodeStock(token); } catch { toast('That list link looks incomplete. Copy the whole link and try again.'); return; }
  await loadCatalog();
  const lines = list.lines.map(line => {
    const catalogItem = line.id ? getCatalogItem(line.id) : null;
    const data = catalogItem ? fromCatalog(catalogItem) : line.item?.name ? { ...line.item } : null;
    return data ? { data, qty: line.count } : null;
  }).filter(Boolean);
  if (!lines.length) { toast('This copy of the app doesn’t know the drinks on that list yet. Close it, reopen it and try again.'); return; }
  ui.stockList = { key: String(hash(token)), title: list.title, lines, missing: list.lines.length - lines.length };
  renderStockList();
  closeSheet('sheet-settings');
  openSheet('sheet-stock');
}

function renderStockList() {
  const list = ui.stockList;
  if (!list) return;
  const units = list.lines.reduce((sum, line) => sum + line.qty, 0);
  $('#stock-title').textContent = list.title;
  $('#stock-summary').textContent = `${plural(list.lines.length, 'drink')}, ${units} cans and bottles in all.${list.missing ? ` ${plural(list.missing, 'drink')} on the list couldn’t be matched and will be skipped.` : ''}`;
  const loaded = stockListLoaded(list.key);
  $('#stock-again').hidden = !loaded;
  if (loaded) $('#stock-again').textContent = `You already added this list ${relativeTime(loaded.at)}. Adding it again puts the same cans in twice.`;
  $('#stock-apply').textContent = loaded ? 'Add again' : 'Add to fridge';
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
  ui.cart = {};
  closeSheet('sheet-stock');
  showScreen('screen-home');
  setTimeout(() => toast(`${plural(result.drinks, 'drink')} added: ${result.units} cans and bottles`, { undo: result.undo, tone: 'ok' }), 220);
}

// ---------------------------------------------------------------------------
// Edit / new drink form

function fillTypeOptions(selected) {
  $('#f-type').innerHTML = TYPES.map(type => `<option value="${type}"${type === selected ? ' selected' : ''}>${type}</option>`).join('');
}

function fillStyleOptions(type, selected = '') {
  const groups = stylesForType(type);
  const known = groups.some(group => group.styles.includes(selected));
  $('#f-style').innerHTML = `<option value="">${groups.length ? 'Not sure' : '—'}</option>${groups.map(group => `<optgroup label="${esc(group.family)}">${group.styles.map(style => `<option${style === selected ? ' selected' : ''}>${esc(style)}</option>`).join('')}</optgroup>`).join('')}${selected && !known ? `<option selected>${esc(selected)}</option>` : ''}`;
}

function openForm({ mode = 'new', item = null, candidate = null, qty = 1, returnTo = null, brewery = null } = {}) {
  const source = item || candidate || {};
  ui.form = { mode, itemId: item?.id || null, returnTo, touchedType: Boolean(source.type), touchedStyle: Boolean(source.style), catalogId: candidate?.catalogId || null, pending: returnTo === 'add' ? ui.add.pending : null, image: candidate?.image || '' };
  $('#form-eyebrow').textContent = mode === 'edit' ? 'Edit drink' : 'New drink';
  $('#form-title').textContent = mode === 'edit' ? fullName(item) : 'Add a drink';
  $('#f-name').value = source.name || '';
  $('#f-brand').value = brewery ? shortBrewery(brewery.name) : source.brand || '';
  const type = source.type || 'Beer';
  fillTypeOptions(type);
  fillStyleOptions(type, source.style || '');
  $('#f-abv').value = source.abv ?? '';
  $('#f-size').value = source.size || TYPE_META[type]?.size || '';
  $('#f-city').value = brewery?.city || source.city || '';
  $('#f-state').value = brewery?.state || source.state || '';
  $('#f-qty-row').querySelector('label').hidden = mode === 'edit';
  $('#f-qty').value = qty;
  $('#f-par').value = source.par ?? '';
  $('#f-par').placeholder = String(parPlaceholder());
  const pending = ui.form.pending;
  $('#form-note').textContent = pending ? `Barcode ${displayCode(canonicalCode(pending.code, pending.format))} will be linked to this drink.` : brewery ? `From ${brewery.name}, ${brewery.miles < 1 ? 'under a mile' : `${Math.round(brewery.miles)} miles`} away.` : '';
  $('#form-note').hidden = !$('#form-note').textContent;
  $('#form-submit').textContent = mode === 'edit' ? 'Save changes' : 'Add to the fridge';
  const brands = new Set([...makersList().map(maker => maker.brand || maker.name), ...ui.breweries.map(entry => shortBrewery(entry.name)), ...store.items.map(entry => entry.brand).filter(Boolean)]);
  $('#brand-options').innerHTML = [...brands].sort().map(brand => `<option value="${esc(brand)}"></option>`).join('');
  $('#size-options').innerHTML = SIZES.map(size => `<option value="${size}"></option>`).join('');
  scanner?.pause();
  openSheet('sheet-form');
  if (!source.name) $('#f-name').focus();
}

function submitForm(event) {
  event.preventDefault();
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
    saveItem({ id: ui.form.itemId, ...data });
    toast('Saved');
    closeSheet('sheet-form');
    if ($('#sheet-item').open) renderItemSheet();
    return;
  }
  const qty = Math.max(0, Math.round(Number($('#f-qty').value) || 0));
  const pending = ui.form.pending || {};
  let item;
  if (qty > 0) {
    const result = stockIn({ ...data, country: data.country || (data.state ? 'US' : '') }, qty, pending);
    item = result.item;
    toast(`Added ${qty} × ${fullName(item)}`, { undo: result.undo });
    if ($('#sheet-add').open) {
      ui.add.session.unshift({ name: fullName(item), qty });
      renderSession();
    }
  } else {
    item = saveItem(data);
    if (pending.code) { attachBarcode(item, pending.code, pending.format); persist('barcode'); }
    toast(`${fullName(item)} saved`);
  }
  const returnTo = ui.form.returnTo;
  closeSheet('sheet-form');
  if (returnTo === 'add' && $('#sheet-add').open) {
    ui.add.candidate = null;
    ui.add.pending = null;
    ui.add.unknown = null;
    $('#confirm').hidden = true;
    $('#sheet-add').classList.remove('has-confirm');
    if (!$('#rapid-toggle').checked) closeSheet('sheet-add');
    else {
      $('#add-query').value = '';
      renderAddResults();
    }
  }
}

// ---------------------------------------------------------------------------
// Order + rating

function renderOrderSheet() {
  const lines = cartLines();
  if (!lines.length) {
    closeSheet('sheet-order');
    return;
  }
  const count = lines.reduce((sum, line) => sum + line.qty, 0);
  $('#order-lines').innerHTML = lines.map(({ item, qty }) => `<div class="order-row">
      <span class="thumb">${art(item)}</span>
      <div class="order-text"><span class="brand-line">${esc(item.brand || typeChip(item.type))}</span><b>${esc(item.name)}</b><small>${item.count} available</small></div>
      <div class="stepper" role="group" aria-label="Quantity for ${esc(fullName(item))}"><button type="button" data-cart="${item.id}" data-delta="-1" aria-label="Remove one"><svg><use href="#i-minus"/></svg></button><output>${qty}</output><button type="button" data-cart="${item.id}" data-delta="1" ${qty >= item.count ? 'disabled' : ''} aria-label="Add one"><svg><use href="#i-plus"/></svg></button></div>
    </div>`).join('');
  $('#order-names').innerHTML = store.settings.recentNames.map(name => `<button type="button" class="chip" data-order-name="${esc(name)}">${esc(name)}</button>`).join('');
  $('#order-confirm').textContent = `Check out ${plural(count, 'drink')}`;
}

function openOrder() {
  $('#order-by').value = store.settings.lastBy || '';
  renderOrderSheet();
  openSheet('sheet-order');
}

function confirmOrder() {
  const lines = cartLines();
  if (!lines.length) return;
  const by = $('#order-by').value.trim();
  const { entries, undo } = checkout(lines.map(({ item, qty }) => ({ id: item.id, qty })), { by });
  ui.cart = {};
  closeSheet('sheet-order');
  const count = entries.reduce((sum, entry) => sum + entry.taken, 0);
  toast(`Enjoy${by ? `, ${by}` : ''}! ${plural(count, 'drink')} checked out`, { undo });
  setTimeout(() => openRate(entries.map(entry => entry.item.id).slice(0, 4)), 260);
}

function openRate(ids) {
  ui.rateIds = ids.filter(id => findItem(id));
  ui.rated = {};
  if (!ui.rateIds.length) return;
  renderRate();
  openSheet('sheet-rate');
}

function renderRate() {
  $('#rate-title').textContent = ui.rateIds.length > 1 ? 'How were they?' : 'How was it?';
  $('#rate-list').innerHTML = ui.rateIds.map(id => {
    const item = findItem(id);
    const rated = ui.rated[id];
    return `<div class="rate-row">
      <span class="thumb">${art(item)}</span>
      <div class="rate-text"><span class="brand-line">${esc(item.brand || typeChip(item.type))}</span><b>${esc(item.name)}</b><small>${rated ? `Thanks! You gave it ${rated} ★` : item.ratingCount ? `${average(item).toFixed(1)} ★ from ${plural(item.ratingCount, 'rating')}` : 'Be the first to rate it'}</small></div>
      <div class="star-picker" role="group" aria-label="Rate ${esc(fullName(item))}">${[1, 2, 3, 4, 5].map(stars => `<button type="button" data-rate="${id}" data-stars="${stars}" class="${rated && stars <= rated ? 'is-on' : ''}" aria-label="${plural(stars, 'star')}" ${rated ? 'disabled' : ''}><svg><use href="#i-star"/></svg></button>`).join('')}</div>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Settings

function openSettings() {
  const settings = store.settings;
  $('#s-name').value = settings.fridgeName;
  $('#s-loc').textContent = settings.location ? settings.location.label : 'Not set';
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

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Events

function onClick(event) {
  const target = event.target.closest('button, a, [data-item]');
  if (!target) return;
  const data = target.dataset;

  if (data.close !== undefined) { closeSheet(target.closest('dialog').id); return; }
  if (data.go) { showScreen(`screen-${data.go}`); return; }
  if (data.openAdd) { openAdd(data.openAdd); if (data.openAdd === 'search') $('#add-query').focus(); return; }
  if (data.screen) { showScreen(data.screen); return; }
  if (data.item) { openItem(data.item, 'owner'); return; }
  if (data.menuItem) { openItem(data.menuItem, 'guest'); return; }
  if (data.restock) { const item = findItem(data.restock); if (item) openAdd('search', { item }); return; }
  if (data.catStock) { const item = getCatalogItem(data.catStock); if (item) openAdd('search', { catalogItem: item }); return; }
  if (data.catRun) {
    const item = getCatalogItem(data.catRun);
    if (item) toast(addToBeerRun({ catalogId: item.id, name: item.name, brand: item.brand, style: item.style }) ? `${item.fullName} added to the beer run` : 'Already on the beer run');
    return;
  }
  if (data.catDismiss) { dismissSuggestion(data.catDismiss); toast('Got it. We’ll suggest something else.'); return; }
  if (data.cart) { changeCart(data.cart, Number(data.delta)); return; }
  if (data.jump) { lineups[data.jump]?.flow?.goTo(Number(data.index)); return; }
  if (data.wheelStep) {
    const ctl = countCtls[target.closest('.count-ctl')?.dataset.ctl];
    if (ctl?.itemId) ctl.wheel.step(Number(data.wheelStep));
    return;
  }
  if (data.rateItem) { openRate([data.rateItem]); return; }
  if (data.rate) {
    const stars = Number(data.stars);
    rateItem(data.rate, stars);
    ui.rated[data.rate] = stars;
    renderRate();
    if (ui.rateIds.every(id => ui.rated[id])) setTimeout(() => closeSheet('sheet-rate'), 700);
    return;
  }
  if (data.runRemove) { removeFromBeerRun(data.runRemove); return; }
  if (data.runGot) {
    const entry = store.beerRun.find(run => run.id === data.runGot);
    if (!entry) return;
    const catalogItem = entry.catalogId && getCatalogItem(entry.catalogId);
    const item = entry.itemId && findItem(entry.itemId);
    if (catalogItem) openAdd('search', { catalogItem });
    else if (item) openAdd('search', { item });
    else openAdd('search', { query: entry.name });
    return;
  }
  if (data.breweryAdd) {
    const brewery = ui.breweries.find(entry => entry.id === data.breweryAdd);
    if (brewery) openForm({ mode: 'new', brewery, candidate: { type: 'Beer' } });
    return;
  }
  if (data.pickItem) { const item = findItem(data.pickItem); if (item) pickForAdd(fromItem(item), 'In your fridge'); return; }
  if (data.pickCat) { const item = getCatalogItem(data.pickCat); if (item) pickForAdd(fromCatalog(item), ui.add.pending ? 'Your pick' : 'Catalog'); return; }
  if (data.altCat) { const item = getCatalogItem(data.altCat); if (item) showConfirm(fromCatalog(item), { source: 'Your pick' }); return; }
  if (data.lookupCode) { resolveBarcode(data.lookupCode); return; }
  if (data.orderName) { $('#order-by').value = data.orderName; return; }

  switch (target.id) {
    case 'tab-scan': openAdd('scan'); break;
    case 'open-settings': openSettings(); break;
    case 'low-to-run': {
      let added = 0;
      lowStock(store.items, store.activity, store.settings.defaultPar).forEach(({ item }) => { if (addToBeerRun({ itemId: item.id, catalogId: item.catalogId, name: item.name, brand: item.brand, style: item.style })) added += 1; });
      toast(added ? `${plural(added, 'drink')} added to the beer run` : 'Already on the beer run');
      break;
    }
    case 'order-review': openOrder(); break;
    case 'order-confirm': confirmOrder(); break;
    case 'order-clear': ui.cart = {}; closeSheet('sheet-order'); refreshCartViews(); break;
    case 'share-btn': shareMenu(); break;
    case 'copy-link': copyText(ui.shareUrl, 'Menu link copied'); break;
    case 'loc-change': ui.editingLocation = true; renderDiscover(); $('#loc-input').focus(); break;
    case 'loc-device': setLocation(locateDevice(), 'Getting your location…'); break;
    case 'breweries-more': ui.breweriesExpanded = !ui.breweriesExpanded; renderDiscover(); break;
    case 'run-share': shareText('Beer run', beerRunText()); break;
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
    case 'item-rating': if (!ui.guest) openRate([ui.itemId]); break;
    case 'item-stock': { const item = findItem(ui.itemId); closeSheet('sheet-item'); if (item) setTimeout(() => openAdd('search', { item }), 180); break; }
    case 'item-run': { const item = findItem(ui.itemId); if (item) toast(addToBeerRun({ itemId: item.id, catalogId: item.catalogId, name: item.name, brand: item.brand, style: item.style }) ? `${fullName(item)} added to the beer run` : 'Already on the beer run'); break; }
    case 'item-edit': { const item = findItem(ui.itemId); if (item) openForm({ mode: 'edit', item }); break; }
    case 'item-delete': armed(target, 'Tap again to delete', () => {
      const result = deleteItem(ui.itemId);
      closeSheet('sheet-item');
      if (result) toast(`${fullName(result.item)} deleted`, { undo: result.undo });
    }); break;
    case 's-loc-edit':
      closeSheet('sheet-settings');
      ui.editingLocation = true;
      showScreen('screen-discover');
      setTimeout(() => $('#loc-input').focus(), 220);
      break;
    case 's-export': download(`fridge-backup-${new Date().toISOString().slice(0, 10)}.json`, exportData()); toast('Backup downloaded'); break;
    case 's-reset': armed(target, 'Tap again to load the demo', () => { resetDemo(); toast('Demo fridge loaded'); }); break;
    case 's-erase': armed(target, 'Tap again to erase', () => { eraseAll(); ui.cart = {}; toast('Everything erased'); }); break;
    case 's-stock-go': openStockList($('#s-stock').value).then(() => { if ($('#sheet-stock').open) $('#s-stock').value = ''; }); break;
    case 'stock-apply': applyStockList(); break;
    default: break;
  }

  if (target.matches('[data-qty]')) setQty(Number(target.dataset.qty));
  if (target.matches('[data-step]')) setQty(ui.add.qty + Number(target.dataset.step));
  if (target.matches('[data-order-step]')) changeCart(ui.itemId, Number(target.dataset.orderStep));
  if (target.matches('[data-par-step]')) {
    const item = findItem(ui.itemId);
    if (item) {
      saveItem({ id: item.id, par: Math.max(0, (item.par ?? store.settings.defaultPar) + Number(target.dataset.parStep)) });
    }
  }
  if (target.matches('[data-inv-type]')) { lineups.inv.type = target.dataset.invType; lineups.inv.group = 'all'; renderHome(); }
  if (target.matches('[data-inv-group]')) { lineups.inv.group = target.dataset.invGroup; renderHome(); }
  if (target.matches('[data-inv-view]')) updateSettings({ invView: target.dataset.invView });
  if (target.matches('[data-menu-type]')) { lineups.menu.type = target.dataset.menuType; lineups.menu.group = 'all'; renderMenu(); }
  if (target.matches('[data-menu-group]')) { lineups.menu.group = target.dataset.menuGroup; renderMenu(); }
  if (target.matches('[data-browse-type]')) { ui.browseType = target.dataset.browseType; renderBrowse(); }
  if (target.matches('[data-view]')) updateSettings({ menuView: target.dataset.view });
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

  $('#inv-search').addEventListener('input', debounce(() => renderHome(), 120));
  $('#inv-sort').addEventListener('change', event => { lineups.inv.sort = event.target.value; renderHome(); });
  $$('[data-group-by]').forEach(select => {
    select.innerHTML = GROUPINGS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    select.addEventListener('change', () => {
      const lineup = lineups[select.dataset.groupBy];
      lineup.group = 'all';
      updateSettings({ [`${lineup.id}Group`]: select.value });
    });
  });
  setupCountCtl('inv', 'inv-count-ctl');
  setupCountCtl('item', 'item-count-ctl');
  window.addEventListener('pagehide', flushCount);
  $('#browse-input').addEventListener('input', debounce(() => renderBrowse(), 140));
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

  $('#loc-form').addEventListener('submit', event => {
    event.preventDefault();
    setLocation(locateQuery($('#loc-input').value), 'Looking that up…');
  });

  $('#item-form').addEventListener('submit', submitForm);
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
      toast('Backup restored');
      closeSheet('sheet-settings');
    } catch (error) {
      toast(error.message || 'That file couldn’t be imported');
    }
  });

  window.addEventListener('hashchange', () => {
    const { route, params } = parseHash();
    if (route === 'menu' && params.get('s')) { location.reload(); return; }
    if (route === 'stock' && params.get('l')) { takeStockLink(params.get('l')); return; }
    if (ROUTES[route] && ROUTES[route] !== ui.screen) showScreen(ROUTES[route], { updateUrl: false });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { scanner?.stop(); flushCount(); }
    else if ($('#sheet-add').open && ui.add.mode === 'scan') startScanner();
  });

  subscribe(() => {
    ui.version += 1;
    renderScreen();
    if ($('#sheet-item').open) renderItemSheet();
  });
}

// ---------------------------------------------------------------------------
// Startup

function hydrateCatalogLinks() {
  let changed = false;
  store.items.forEach(item => {
    if (item.catalogId && getCatalogItem(item.catalogId)) return;
    const best = matchCandidates({ name: item.name, brand: item.brand })[0];
    if (best && best.score >= (item.brand ? 0.8 : 0.86)) {
      linkCatalog(item, best.item);
      changed = true;
    }
  });
  if (changed) persist('link');
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
  showScreen(ROUTES[route] || 'screen-home', { updateUrl: !ROUTES[route] && route !== '' });
  if (result === 'migrated') toast('Your fridge was upgraded. Everything carried over.');
  if (route === 'scan' && !ui.guest) openAdd('scan'); // home-screen shortcut
  if (route === 'stock' && params.get('l') && !ui.guest) takeStockLink(params.get('l'));

  loadCatalog().then(() => {
    hydrateCatalogLinks();
    hydrateGuestLabels();
    ui.breweries = cachedBreweries(store.settings.location);
    $('#qa-catalog-count').textContent = catalogSize() ? `${catalogSize()} drinks built in` : 'Search the catalog';
    ui.version += 1;
    renderScreen();
    if (store.settings.location && breweriesStale(store.settings.location)) refreshBreweries();
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

init();
