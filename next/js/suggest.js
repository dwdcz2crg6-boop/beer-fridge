// Smart suggest: location, nearby breweries (Open Brewery DB) and scoring that
// blends taste (ratings + checkouts), locality, season/occasion and popularity.
import { fetchJson, fold, hash, haversineMiles, seededRandom } from './util.js';
import { catalogItems, itemsForMaker, matchMaker } from './catalog.js';
import { STATE_NAMES, familyOf, isNonAlcoholic, occasionFor, regionOf, seasonFit, seasonWeights, stateCode } from './taxonomy.js';

const BREWERY_CACHE_KEY = 'um-fridge-breweries';
const BREWERY_TYPES = { micro: 'Microbrewery', nano: 'Nanobrewery', brewpub: 'Brewpub', regional: 'Regional brewery', large: 'Large brewery', contract: 'Contract brewer', proprietor: 'Shared brewhouse', taproom: 'Taproom', bar: 'Beer bar', cidery: 'Cidery' };

// ---------------------------------------------------------------------------
// Location

export async function locateQuery(query) {
  const value = String(query || '').trim();
  if (!value) throw new Error('Enter a ZIP code or city.');
  if (/^\d{5}$/.test(value)) {
    const data = await fetchJson(`https://api.zippopotam.us/us/${value}`).catch(() => null);
    const place = data?.places?.[0];
    if (!place) throw new Error(`Couldn’t find ZIP ${value}.`);
    return { label: `${place['place name']}, ${place['state abbreviation']}`, city: place['place name'], state: place['state abbreviation'], zip: value, lat: Number(place.latitude), lng: Number(place.longitude), source: 'zip' };
  }
  const [namePart, hintPart = ''] = value.split(',').map(part => part.trim());
  const data = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(namePart)}&count=10&language=en&format=json`).catch(() => null);
  const results = data?.results || [];
  const hint = stateCode(hintPart) || hintPart.toUpperCase();
  const best = results.find(result => result.country_code === 'US' && hint && stateCode(result.admin1) === hint)
    || results.find(result => result.country_code === 'US')
    || results[0];
  if (!best) throw new Error(`Couldn’t find “${value}”.`);
  const state = best.country_code === 'US' ? stateCode(best.admin1) : '';
  return { label: state ? `${best.name}, ${state}` : `${best.name}, ${best.country_code}`, city: best.name, state, country: best.country_code, lat: best.latitude, lng: best.longitude, source: 'search' };
}

export function locateDevice() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location isn’t available in this browser. Enter a ZIP instead.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(async position => {
      // Round to ~1 km: plenty for "breweries near me", kinder to privacy.
      const lat = Math.round(position.coords.latitude * 100) / 100;
      const lng = Math.round(position.coords.longitude * 100) / 100;
      const location = { label: 'Current location', city: '', state: '', lat, lng, source: 'device' };
      try {
        const nearest = (await fetchBreweries(location, { force: true }))[0];
        if (nearest) Object.assign(location, { city: nearest.city, state: nearest.state, label: `Near ${nearest.city}${nearest.state ? `, ${nearest.state}` : ''}` });
      } catch { /* label stays generic */ }
      resolve(location);
    }, error => reject(new Error(error.code === 1 ? 'Location permission was denied. Enter a ZIP instead.' : 'Couldn’t get your location. Enter a ZIP instead.')), { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
  });
}

// ---------------------------------------------------------------------------
// Breweries near the fridge

const cacheKeyFor = location => `${Number(location.lat).toFixed(2)},${Number(location.lng).toFixed(2)}`;

function readBreweryCache() {
  try { return JSON.parse(localStorage.getItem(BREWERY_CACHE_KEY) || 'null'); } catch { return null; }
}

export function cachedBreweries(location) {
  if (!location) return [];
  const cache = readBreweryCache();
  return cache?.key === cacheKeyFor(location) ? annotate(cache.list) : [];
}

export function breweriesStale(location) {
  const cache = readBreweryCache();
  return !location || cache?.key !== cacheKeyFor(location) || Date.now() - cache.at > 7 * 86400000;
}

function annotate(list) {
  return list.map(brewery => {
    const maker = matchMaker(brewery.name, brewery.state);
    return { ...brewery, makerId: maker?.id || null, beers: maker ? itemsForMaker(maker.id).slice(0, 5) : [] };
  });
}

export async function fetchBreweries(location, { force = false } = {}) {
  if (!location) return [];
  const key = cacheKeyFor(location);
  const cache = readBreweryCache();
  if (!force && cache?.key === key && Date.now() - cache.at < 7 * 86400000) return annotate(cache.list);
  const data = await fetchJson(`https://api.openbrewerydb.org/v1/breweries?by_dist=${Number(location.lat).toFixed(4)},${Number(location.lng).toFixed(4)}&per_page=80`, { timeout: 10000 });
  const list = (Array.isArray(data) ? data : [])
    .filter(brewery => !['planning', 'closed'].includes(brewery.brewery_type) && brewery.latitude != null && brewery.longitude != null)
    .map(brewery => {
      const point = { lat: Number(brewery.latitude), lng: Number(brewery.longitude) };
      return {
        id: brewery.id,
        name: brewery.name,
        type: brewery.brewery_type,
        typeLabel: BREWERY_TYPES[brewery.brewery_type] || 'Brewery',
        city: brewery.city || '',
        state: stateCode(brewery.state_province || brewery.state) || brewery.state_province || '',
        url: brewery.website_url || '',
        ...point,
        miles: Math.round(haversineMiles(location, point) * 10) / 10,
      };
    })
    .filter(brewery => brewery.miles <= 80)
    .sort((a, b) => a.miles - b.miles);
  try { localStorage.setItem(BREWERY_CACHE_KEY, JSON.stringify({ key, at: Date.now(), list })); } catch { /* storage full */ }
  return annotate(list);
}

// ---------------------------------------------------------------------------
// Scoring

function tasteProfile(items, activity) {
  const families = {};
  const types = {};
  const outs = {};
  activity.forEach(entry => {
    if (entry.kind !== 'out') return;
    const key = entry.itemId || fold(entry.name);
    outs[key] = (outs[key] || 0) + (entry.qty || 1);
  });
  items.forEach(item => {
    const average = item.ratingCount ? item.ratingTotal / item.ratingCount : null;
    const taken = outs[item.id] || outs[fold(item.name)] || 0;
    let weight = 0.25 + Math.log1p(taken) * 0.7;
    if (average != null) weight += (average - 3) * Math.min(item.ratingCount, 6) * 0.35;
    const familyKey = `${item.type}|${familyOf(item)}`;
    families[familyKey] = (families[familyKey] || 0) + weight;
    types[item.type] = (types[item.type] || 0) + weight;
  });
  const normalize = map => {
    const max = Math.max(0.0001, ...Object.values(map));
    return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, Math.max(-1, value / max)]));
  };
  const ranked = Object.entries(families).filter(([, value]) => value > 0.6).sort((a, b) => b[1] - a[1]);
  return { families: normalize(families), types: normalize(types), favorites: ranked.map(([key]) => key.split('|')[1]) };
}

export function buildContext({ items = [], activity = [], location = null, breweries = [], dismissed = [], listed = [], now = new Date() }) {
  const localMakers = new Map();
  breweries.forEach(brewery => {
    if (brewery.makerId && (!localMakers.has(brewery.makerId) || localMakers.get(brewery.makerId) > brewery.miles)) localMakers.set(brewery.makerId, brewery.miles);
  });
  return {
    now,
    location,
    weights: seasonWeights(now),
    occasion: occasionFor(now),
    userState: location?.state || '',
    userRegion: regionOf(location?.state || ''),
    localMakers,
    taste: tasteProfile(items, activity),
    owned: new Set(items.map(item => item.catalogId).filter(Boolean)),
    ownedNames: new Set(items.map(item => fold(item.name))),
    dismissed: new Set(dismissed),
    listed: new Set(listed),
    // A little daily variety, tied to each drink rather than drawn in order, so hiding one
    // pick or listing another does not reshuffle everything else.
    jitter: id => seededRandom(hash(`${now.toDateString()}|${id}`))(),
  };
}

export function locality(item, ctx) {
  let miles = ctx.localMakers.get(item.makerId);
  if (miles == null && ctx.location && item.lat != null) miles = haversineMiles(ctx.location, item);
  const verb = item.type === 'Beer' ? 'Brewed' : 'Made';
  if (miles != null && miles <= 30) return { score: 1, miles, label: `${verb} ${Math.max(1, Math.round(miles))} mi away` };
  if (miles != null && miles <= 80) return { score: 0.8, miles, label: `${verb} ${Math.round(miles)} mi away` };
  if (ctx.userState && item.state === ctx.userState) return { score: 0.6, miles, label: `From ${STATE_NAMES[item.state] || item.state}` };
  if (ctx.userRegion && item.state && regionOf(item.state) === ctx.userRegion) return { score: 0.35, miles, label: `${ctx.userRegion} pick` };
  return { score: item.country && item.country !== 'US' ? 0.05 : 0.1, miles, label: '' };
}

function score(item, ctx) {
  const local = locality(item, ctx);
  const family = ctx.taste.families[`${item.type}|${item.family}`] ?? 0;
  const type = ctx.taste.types[item.type] ?? (item.type === 'Beer' ? 0.4 : 0);
  const season = seasonFit(item, ctx.weights);
  const occasion = ctx.occasion?.styles.includes(item.style) ? 1 : 0;
  const total = family * 1.1 + type * 0.45 + local.score * 0.9 + season * 0.55 + occasion * 0.45 + (item.pop / 3) * 0.45 + ctx.jitter(item.id) * 0.3;
  let reason = 'Worth a try';
  if (local.score >= 0.6) reason = local.label;
  else if (family >= 0.55) reason = `You like ${item.family === 'Other' ? item.style : item.family}`;
  else if (occasion) reason = ctx.occasion.label;
  else if (season >= 0.6) reason = 'In season';
  else if (item.pop >= 3) reason = 'Crowd favorite';
  return { item, score: total, local, family, season, occasion, reason };
}

function pickDiverse(scored, count, { perFamily = 2, perMaker = 1 } = {}) {
  const families = {};
  const makers = {};
  const picks = [];
  for (const entry of scored) {
    const familyKey = `${entry.item.type}|${entry.item.family}`;
    if ((families[familyKey] || 0) >= perFamily || (makers[entry.item.makerId] || 0) >= perMaker) continue;
    families[familyKey] = (families[familyKey] || 0) + 1;
    makers[entry.item.makerId] = (makers[entry.item.makerId] || 0) + 1;
    picks.push(entry);
    if (picks.length >= count) break;
  }
  return picks;
}

const ALCOHOLIC = ['Beer', 'Cider', 'Wine', 'Ready-to-Drink', 'Spirits'];

function findGaps(items, scored) {
  const stocked = items.filter(item => item.count > 0);
  const beers = stocked.filter(item => item.type === 'Beer' && !isNonAlcoholic(item));
  const gaps = [];
  const pick = (test, reason) => pickDiverse(scored.filter(test), 3).map(entry => ({ ...entry, reason }));
  const hasAlcohol = stocked.some(item => ALCOHOLIC.includes(item.type) && !isNonAlcoholic(item));
  const hasNonAlcoholic = stocked.some(item => isNonAlcoholic(item) || ['Soft Drink', 'Carbonated', 'Water'].includes(item.type));
  if (hasAlcohol && !hasNonAlcoholic) {
    gaps.push({ id: 'na', title: 'No non-alcoholic option', blurb: 'Drivers and kids will thank you.', picks: pick(entry => isNonAlcoholic(entry.item) || entry.item.type === 'Carbonated', 'Fills a gap: no alcohol') });
  }
  if (beers.length >= 2 && !beers.some(item => ['Lager', 'Pilsner', 'Blonde & Golden', 'Kölsch', 'Wheat'].includes(familyOf(item)))) {
    gaps.push({ id: 'easy', title: 'Add an easy-drinking lager', blurb: 'Not everyone wants an IPA.', picks: pick(entry => entry.item.type === 'Beer' && ['Lager', 'Pilsner', 'Kölsch'].includes(entry.item.family), 'Fills a gap: easy drinker') });
  }
  if (beers.length >= 4 && new Set(beers.map(familyOf)).size === 1) {
    const only = familyOf(beers[0]);
    gaps.push({ id: 'variety', title: 'Mix up the styles', blurb: `Everything is ${only}. Add a change of pace.`, picks: pick(entry => entry.item.type === 'Beer' && entry.item.family !== only && !isNonAlcoholic(entry.item), 'Adds variety') });
  }
  if (beers.length >= 3 && !stocked.some(item => ['Ready-to-Drink', 'Wine', 'Cider'].includes(item.type))) {
    gaps.push({ id: 'non-beer', title: 'Something for non-beer drinkers', blurb: 'A seltzer or a cider covers the rest of the party.', picks: pick(entry => ['Ready-to-Drink', 'Cider'].includes(entry.item.type), 'For non-beer drinkers') });
  }
  return gaps.filter(gap => gap.picks.length).slice(0, 2);
}

export function lowStock(items, activity, defaultPar = 3) {
  const since = Date.now() - 30 * 86400000;
  const taken = {};
  activity.forEach(entry => {
    if (entry.kind === 'out' && entry.at && new Date(entry.at).getTime() >= since) taken[entry.itemId] = (taken[entry.itemId] || 0) + (entry.qty || 1);
  });
  return items
    .filter(item => item.count <= (item.par ?? defaultPar) && (item.count > 0 || taken[item.id] || item.ratingCount))
    .map(item => ({ item, taken: taken[item.id] || 0 }))
    .sort((a, b) => a.item.count - b.item.count || b.taken - a.taken);
}

/** Everything the Home and Discover screens show. */
export function suggest(ctx, { items }) {
  const pool = catalogItems().filter(item => !ctx.owned.has(item.id) && !ctx.ownedNames.has(fold(item.name)) && !ctx.dismissed.has(item.id) && !ctx.listed.has(item.id));
  const scored = pool.map(item => score(item, ctx)).sort((a, b) => b.score - a.score);
  const drinks = scored.filter(entry => ['Beer', 'Cider'].includes(entry.item.type) || entry.family > 0.3);
  const forYou = pickDiverse(drinks, 10);
  // "Brewed near you": beer and cider only, craft makers ahead of national brands that
  // happen to be headquartered nearby, and at most two picks per brewery.
  const national = entry => (entry.item.pop >= 3 || entry.item.corporate || entry.item.makerKind === 'large' ? 1 : 0);
  const local = pickDiverse(
    scored
      .filter(entry => entry.local.score >= 0.6 && ['Beer', 'Cider'].includes(entry.item.type))
      .sort((a, b) => b.local.score - a.local.score || national(a) - national(b) || (a.local.miles ?? 999) - (b.local.miles ?? 999) || b.item.pop - a.item.pop),
    16,
    { perFamily: 6, perMaker: 2 },
  ).map(entry => ({ ...entry, reason: entry.local.label }));
  const seasonal = pickDiverse(scored.filter(entry => entry.season >= 0.6 && ['Beer', 'Cider'].includes(entry.item.type)), 10, { perFamily: 3 })
    .map(entry => ({ ...entry, reason: entry.item.season ? 'Seasonal release' : 'In season' }));
  const occasion = ctx.occasion ? pickDiverse(scored.filter(entry => entry.occasion), 8, { perFamily: 2 }).map(entry => ({ ...entry, reason: ctx.occasion.label })) : [];
  const gaps = findGaps(items, scored);
  const top = [];
  const seen = new Set();
  [gaps[0]?.picks[0], occasion[0], local[0], forYou[0], seasonal[0], forYou[1], local[1], occasion[1], forYou[2], local[2], seasonal[1], forYou[3]].forEach(entry => {
    if (entry && !seen.has(entry.item.id) && !seen.has(entry.item.makerId) && top.length < 4) {
      seen.add(entry.item.id);
      seen.add(entry.item.makerId);
      top.push(entry);
    }
  });
  return { forYou, local, seasonal, occasion, gaps, top, favorites: ctx.taste.favorites };
}

/** Extra ranking for typeahead results: locality, history, learned barcode brand. */
export function searchBoost(ctx, { brandHint } = {}) {
  return item => {
    let boost = locality(item, ctx).score * 0.9 + Math.max(0, seasonFit(item, ctx.weights)) * 0.2;
    if (ctx.owned.has(item.id)) boost += 0.8;
    if (brandHint && (item.makerId === brandHint.makerId || fold(item.brand) === fold(brandHint.brand))) boost += 3;
    return boost;
  };
}
