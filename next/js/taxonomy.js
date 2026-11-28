// Drink types, style families, liquid colors, seasons, occasions and US regions.
import { fold } from './util.js';

export const TYPES = ['Beer', 'Cider', 'Wine', 'Ready-to-Drink', 'Soft Drink', 'Carbonated', 'Water', 'Spirits', 'Other'];

export const TYPE_META = {
  Beer: { chip: 'Beer', container: 'can', size: '12 fl oz', color: '#e0a83a' },
  Cider: { chip: 'Cider', container: 'can', size: '12 fl oz', color: '#e9c46a' },
  Wine: { chip: 'Wine', container: 'wine', size: '750 ml', color: '#7a1f2b' },
  'Ready-to-Drink': { chip: 'RTD', container: 'slim', size: '12 fl oz', color: '#f0a875' },
  'Soft Drink': { chip: 'Soft drinks', container: 'can', size: '12 fl oz', color: '#c9473c' },
  Carbonated: { chip: 'Carbonated', container: 'slim', size: '12 fl oz', color: '#7cc4cf' },
  Water: { chip: 'Water', container: 'bottle', size: '16.9 fl oz', color: '#8fc3e6' },
  Spirits: { chip: 'Spirits', container: 'spirit', size: '750 ml', color: '#c0782a' },
  Other: { chip: 'Other', container: 'can', size: '', color: '#9aa59f' },
};

export const SIZES = ['12 fl oz', '16 fl oz', '19.2 fl oz', '12 fl oz bottle', '7 fl oz', '25 fl oz', '750 ml', '375 ml', '16.9 fl oz'];

const S = (type, family, color, seasons = '') => ({ type, family, color, seasons: seasons ? seasons.split(' ') : [] });

export const STYLES = {
  // Beer · lagers
  'American Light Lager': S('Beer', 'Lager', '#f7e7a1', 'summer'),
  'American Lager': S('Beer', 'Lager', '#f3d36b', 'summer'),
  'Mexican Lager': S('Beer', 'Lager', '#f1cd5c', 'summer'),
  'International Lager': S('Beer', 'Lager', '#eec44f'),
  'Japanese Rice Lager': S('Beer', 'Lager', '#f5e29b', 'summer'),
  Helles: S('Beer', 'Lager', '#eec24a', 'spring summer'),
  'Amber Lager': S('Beer', 'Lager', '#c06a24', 'fall'),
  'Vienna Lager': S('Beer', 'Lager', '#b65d22', 'fall'),
  'Märzen': S('Beer', 'Lager', '#bd6420', 'fall'),
  Festbier: S('Beer', 'Lager', '#e1a53b', 'fall'),
  Bock: S('Beer', 'Lager', '#8f4119', 'spring'),
  Doppelbock: S('Beer', 'Lager', '#682b12', 'winter'),
  'Dark Lager': S('Beer', 'Lager', '#3b1d0e', 'winter'),
  Pilsner: S('Beer', 'Pilsner', '#ecbd39', 'spring summer'),
  // Beer · ales
  'Kölsch': S('Beer', 'Kölsch', '#f0cf5b', 'spring summer'),
  'Blonde Ale': S('Beer', 'Blonde & Golden', '#e9b63d', 'summer'),
  'Cream Ale': S('Beer', 'Blonde & Golden', '#f1d47c', 'summer'),
  'American Wheat': S('Beer', 'Wheat', '#ecc562', 'summer'),
  Hefeweizen: S('Beer', 'Wheat', '#e6b54b', 'summer'),
  Witbier: S('Beer', 'Wheat', '#f2dc8f', 'spring summer'),
  'Pale Ale': S('Beer', 'Pale Ale', '#d9952c', 'spring'),
  'English Pale Ale': S('Beer', 'Pale Ale', '#c7802b'),
  IPA: S('Beer', 'IPA', '#d7891f'),
  'Hazy IPA': S('Beer', 'IPA', '#f0b23b', 'spring summer'),
  'Double IPA': S('Beer', 'IPA', '#c8731c'),
  'Session IPA': S('Beer', 'IPA', '#e3a83b', 'summer'),
  'Amber Ale': S('Beer', 'Amber & Brown', '#a9521c', 'fall'),
  'Red Ale': S('Beer', 'Amber & Brown', '#993c1b', 'fall'),
  'Irish Red': S('Beer', 'Amber & Brown', '#8e371b', 'spring fall'),
  'Brown Ale': S('Beer', 'Amber & Brown', '#5f3317', 'fall winter'),
  ESB: S('Beer', 'Amber & Brown', '#a85b21', 'fall'),
  'Scotch Ale': S('Beer', 'Amber & Brown', '#6b2f15', 'winter'),
  Porter: S('Beer', 'Porter', '#2f1b10', 'fall winter'),
  Stout: S('Beer', 'Stout', '#20130b', 'winter'),
  'Irish Stout': S('Beer', 'Stout', '#1b110a', 'spring winter'),
  'Milk Stout': S('Beer', 'Stout', '#26150c', 'winter'),
  'Oatmeal Stout': S('Beer', 'Stout', '#23140b', 'winter'),
  'Imperial Stout': S('Beer', 'Stout', '#130a06', 'winter'),
  Saison: S('Beer', 'Saison', '#e0ae48', 'spring summer'),
  'Belgian Blonde': S('Beer', 'Belgian', '#e3ad3d'),
  'Belgian Pale Ale': S('Beer', 'Belgian', '#c98a34'),
  'Belgian Strong Golden': S('Beer', 'Belgian', '#eac14f'),
  'Belgian Strong Dark': S('Beer', 'Belgian', '#5a2b15', 'winter'),
  Dubbel: S('Beer', 'Belgian', '#6f2f17', 'fall winter'),
  Tripel: S('Beer', 'Belgian', '#e6b43f'),
  Quadrupel: S('Beer', 'Belgian', '#4f2512', 'winter'),
  Sour: S('Beer', 'Sour', '#e7b25e', 'summer'),
  'Fruited Sour': S('Beer', 'Sour', '#d4527a', 'summer'),
  Gose: S('Beer', 'Sour', '#efd78f', 'summer'),
  'Berliner Weisse': S('Beer', 'Sour', '#f2e3a1', 'summer'),
  Lambic: S('Beer', 'Sour', '#b83b4c'),
  'Flanders Red': S('Beer', 'Sour', '#7b2519', 'fall'),
  'Pumpkin Ale': S('Beer', 'Specialty', '#c3621e', 'fall'),
  'Winter Warmer': S('Beer', 'Specialty', '#7a3517', 'winter'),
  Shandy: S('Beer', 'Specialty', '#f3d77b', 'summer'),
  'Fruit Beer': S('Beer', 'Specialty', '#d8665f', 'summer'),
  Barleywine: S('Beer', 'Specialty', '#8a3b17', 'winter'),
  'Non-Alcoholic Lager': S('Beer', 'Non-Alcoholic', '#f1d06a'),
  'Non-Alcoholic IPA': S('Beer', 'Non-Alcoholic', '#e09a2c'),
  'Non-Alcoholic Golden': S('Beer', 'Non-Alcoholic', '#ebbd47'),
  'Non-Alcoholic Stout': S('Beer', 'Non-Alcoholic', '#21130b'),
  'Non-Alcoholic Wheat': S('Beer', 'Non-Alcoholic', '#efcf72'),
  // Cider
  Cider: S('Cider', 'Cider', '#efd27a', 'fall'),
  'Fruit Cider': S('Cider', 'Cider', '#e58a6c', 'fall summer'),
  'Rosé Cider': S('Cider', 'Cider', '#f1a9a5', 'summer'),
  Perry: S('Cider', 'Cider', '#eedc9b', 'fall'),
  // Ready-to-drink
  'Hard Seltzer': S('Ready-to-Drink', 'Hard Seltzer', '#dff1f2', 'summer'),
  'Canned Cocktail': S('Ready-to-Drink', 'Canned Cocktail', '#f1ae79'),
  'Hard Tea': S('Ready-to-Drink', 'Hard Tea', '#b8661f', 'summer'),
  'Hard Lemonade': S('Ready-to-Drink', 'Hard Lemonade', '#f3e27b', 'summer'),
  'Malt Beverage': S('Ready-to-Drink', 'Malt Beverage', '#e6d8a6'),
  // Wine
  'Cabernet Sauvignon': S('Wine', 'Red', '#5b0f1d', 'fall winter'),
  Merlot: S('Wine', 'Red', '#6a1422', 'fall winter'),
  'Pinot Noir': S('Wine', 'Red', '#8a1f2d', 'fall'),
  Malbec: S('Wine', 'Red', '#4f0c1c', 'winter'),
  Zinfandel: S('Wine', 'Red', '#6e1426', 'fall'),
  'Red Blend': S('Wine', 'Red', '#5e1220', 'winter'),
  Chardonnay: S('Wine', 'White', '#e8d27f'),
  'Sauvignon Blanc': S('Wine', 'White', '#eee49b', 'spring summer'),
  'Pinot Grigio': S('Wine', 'White', '#efe6a6', 'summer'),
  Riesling: S('Wine', 'White', '#ecdc8c', 'spring'),
  Moscato: S('Wine', 'White', '#f1df95', 'summer'),
  'White Blend': S('Wine', 'White', '#ebdc93'),
  'Rosé': S('Wine', 'Rosé', '#f2a7a1', 'spring summer'),
  Prosecco: S('Wine', 'Sparkling', '#ece0a1', 'winter summer'),
  Champagne: S('Wine', 'Sparkling', '#e9d993', 'winter'),
  'Sparkling Wine': S('Wine', 'Sparkling', '#ebdd9c', 'winter'),
  // Soft drinks
  Cola: S('Soft Drink', 'Soda', '#3b1b10'),
  'Diet Cola': S('Soft Drink', 'Soda', '#45231a'),
  'Lemon-Lime': S('Soft Drink', 'Soda', '#dcf0c3', 'summer'),
  'Citrus Soda': S('Soft Drink', 'Soda', '#cfe86a'),
  'Pepper Soda': S('Soft Drink', 'Soda', '#4a1a17'),
  'Root Beer': S('Soft Drink', 'Soda', '#3a1a0d'),
  'Ginger Ale': S('Soft Drink', 'Soda', '#efd99a'),
  'Ginger Beer': S('Soft Drink', 'Mixers', '#e9cf86'),
  'Orange Soda': S('Soft Drink', 'Soda', '#f39a2c', 'summer'),
  'Cream Soda': S('Soft Drink', 'Soda', '#e9c27d'),
  'Iced Tea': S('Soft Drink', 'Tea & Lemonade', '#b0601d', 'summer'),
  Lemonade: S('Soft Drink', 'Tea & Lemonade', '#f4e58a', 'summer'),
  Juice: S('Soft Drink', 'Juice & Coffee', '#f2a83a'),
  'Energy Drink': S('Soft Drink', 'Energy & Sports', '#c9e64a'),
  'Sports Drink': S('Soft Drink', 'Energy & Sports', '#5fc6e8', 'summer'),
  'Prebiotic Soda': S('Soft Drink', 'Soda', '#f0a9c4'),
  'Cold Brew Coffee': S('Soft Drink', 'Juice & Coffee', '#3c2414'),
  'Tonic Water': S('Soft Drink', 'Mixers', '#eef5f2'),
  Kombucha: S('Soft Drink', 'Juice & Coffee', '#e2b866'),
  // Carbonated
  'Sparkling Water': S('Carbonated', 'Sparkling Water', '#e3f3f5'),
  'Flavored Seltzer': S('Carbonated', 'Flavored Seltzer', '#e4f2e6', 'summer'),
  'Mineral Water': S('Carbonated', 'Mineral Water', '#e6f1f4'),
  'Club Soda': S('Carbonated', 'Club Soda', '#eef4f4'),
  // Water
  'Spring Water': S('Water', 'Water', '#e8f4fb'),
  'Purified Water': S('Water', 'Water', '#eaf3fa'),
  'Alkaline Water': S('Water', 'Water', '#e4f0fa'),
  // Spirits
  Vodka: S('Spirits', 'Spirits', '#f4f6f6'),
  Tequila: S('Spirits', 'Spirits', '#f1e2a8', 'summer'),
  Whiskey: S('Spirits', 'Spirits', '#c0782a', 'winter'),
  Rum: S('Spirits', 'Spirits', '#b8692a', 'summer'),
  Gin: S('Spirits', 'Spirits', '#eef4f2', 'summer'),
  Liqueur: S('Spirits', 'Spirits', '#e9d35b'),
};

export const FAMILY_ORDER = {
  Beer: ['IPA', 'Pale Ale', 'Lager', 'Pilsner', 'Kölsch', 'Blonde & Golden', 'Wheat', 'Saison', 'Belgian', 'Amber & Brown', 'Porter', 'Stout', 'Sour', 'Specialty', 'Non-Alcoholic', 'Other'],
  Wine: ['Red', 'White', 'Rosé', 'Sparkling', 'Other'],
  'Ready-to-Drink': ['Hard Seltzer', 'Canned Cocktail', 'Hard Tea', 'Hard Lemonade', 'Malt Beverage', 'Other'],
  'Soft Drink': ['Soda', 'Tea & Lemonade', 'Energy & Sports', 'Juice & Coffee', 'Mixers', 'Other'],
  Carbonated: ['Sparkling Water', 'Flavored Seltzer', 'Mineral Water', 'Club Soda', 'Other'],
  Cider: ['Cider'],
  Water: ['Water'],
  Spirits: ['Spirits'],
  Other: ['Other'],
};

// Older saved data used a short style list.
const LEGACY_STYLES = { Lager: 'American Lager', Wheat: 'American Wheat', Other: '' };
export function normalizeStyle(style = '') {
  if (!style) return '';
  if (STYLES[style]) return style;
  if (style in LEGACY_STYLES) return LEGACY_STYLES[style];
  const match = Object.keys(STYLES).find(name => fold(name) === fold(style));
  return match || style;
}

export function styleInfo(style) {
  return STYLES[style] || null;
}

export function isNonAlcoholic(item) {
  return item.type === 'Beer' && ((item.abv != null && item.abv !== '' && Number(item.abv) <= 0.5) || /^Non-Alcoholic/.test(item.style || ''));
}

export function familyOf(item) {
  if (isNonAlcoholic(item)) return 'Non-Alcoholic';
  return STYLES[item.style]?.family || 'Other';
}

export function liquidColor(item) {
  return STYLES[item.style]?.color || TYPE_META[item.type]?.color || '#d8b45a';
}

export function stylesForType(type) {
  const order = FAMILY_ORDER[type] || [];
  const groups = order.map(family => ({
    family,
    styles: Object.entries(STYLES).filter(([, info]) => info.type === type && info.family === family).map(([name]) => name),
  }));
  return groups.filter(group => group.styles.length);
}

// ---------------------------------------------------------------------------
// Inference from free text (product names, Open Food Facts categories)

const NOT_BEER = /\b(root beer|ginger beer|birch beer)\b/;
const TYPE_RULES = [
  ['Soft Drink', NOT_BEER],
  ['Wine', /\b(wines?|cabernet|merlot|pinot|chardonnay|sauvignon|riesling|moscato|prosecco|champagne|malbec|zinfandel|red blend|cava|sangria|rose wine)\b/],
  ['Ready-to-Drink', /\b(hard seltzers?|spiked|vodka soda|vodka seltzer|tequila seltzer|high noon|white claw|truly|cutwater|canned cocktails?|cocktails?|margarita|mojito|mule|paloma|hard teas?|twisted tea|hard lemonade|mikes hard|smirnoff ice|ready to drink|rtd|nutrl)\b/],
  ['Cider', /\b(ciders?|perry)\b/],
  ['Beer', /\b(beers?|ales?|lagers?|ipas?|stouts?|porters?|pils|pilsners?|kolsch|saisons?|witbier|hefeweizen|bocks?|gose|sours?|lambics?|dubbel|tripel|brewing|brewery|brewers|cerveza|bieres?|bier|radler|shandy)\b/],
  ['Carbonated', /\b(seltzers?|sparkling waters?|mineral waters?|club soda|carbonated waters?|soda water|topo chico|lacroix|bubly|perrier|pellegrino|spindrift|polar)\b/],
  ['Spirits', /\b(vodka|tequila|whiskey|whisky|bourbon|rum|gin|liqueur|limoncello|mezcal)\b/],
  ['Water', /\b(spring waters?|purified waters?|alkaline waters?|drinking waters?|waters?)\b/],
  ['Soft Drink', /\b(sodas?|colas?|coke|pepsi|sprite|ginger ale|iced teas?|teas?|lemonade|juices?|energy|sports drinks?|gatorade|kombucha|tonic|cold brew|coffee|soft drinks?|soft-drinks)\b/],
];

export function inferType(text = '') {
  const value = fold(text);
  return TYPE_RULES.find(([, pattern]) => pattern.test(value))?.[0] || '';
}

const BEER_RULES = [
  [/\b(double|triple|imperial|dipa|2x)\b.*\bipa\b|\bdipa\b/, 'Double IPA'],
  [text => /\b(hazy|juicy|new england|neipa)\b/.test(text) && !(/\bpale\b/.test(text) && !/\bipa\b/.test(text)), 'Hazy IPA'],
  [/\bsession\b.*\bipa\b/, 'Session IPA'],
  [/\bipa\b|india pale/, 'IPA'],
  [/\bpale ale\b|\bapa\b|\bxpa\b/, 'Pale Ale'],
  [/\bpumpkin|pumking/, 'Pumpkin Ale'],
  [/\b(oktoberfest|octoberfest|marzen)\b/, 'Märzen'],
  [/\bfestbier\b/, 'Festbier'],
  [/\bdoppelbock\b/, 'Doppelbock'],
  [/\b(maibock|bock)\b/, 'Bock'],
  [/\b(shandy|radler)\b/, 'Shandy'],
  [/\bgose\b/, 'Gose'],
  [/\bberliner\b/, 'Berliner Weisse'],
  [/\b(lambic|kriek|framboise|gueuze|geuze)\b/, 'Lambic'],
  [/\bflanders\b/, 'Flanders Red'],
  [/\bsour\b/, 'Sour'],
  [/\b(saison|farmhouse)\b/, 'Saison'],
  [/\bdubbel\b/, 'Dubbel'],
  [/\b(tripel|trippel)\b/, 'Tripel'],
  [/\b(quad|quadrupel)\b/, 'Quadrupel'],
  [/\b(wit|witbier|white ale|belgian white|blanche)\b/, 'Witbier'],
  [/\b(hefeweizen|hefe|weiss|weissbier|weizen)\b/, 'Hefeweizen'],
  [/\bwheat\b/, 'American Wheat'],
  [/\b(kolsch)\b/, 'Kölsch'],
  [/\b(pils|pilsner|pilsener)\b/, 'Pilsner'],
  [/\bhelles\b/, 'Helles'],
  [/\bvienna\b/, 'Vienna Lager'],
  [/\bamber lager\b/, 'Amber Lager'],
  [/\b(schwarzbier|dunkel|dark lager|black lager)\b/, 'Dark Lager'],
  [/\b(imperial|russian imperial|barrel aged)\b.*\bstout\b/, 'Imperial Stout'],
  [/\bmilk stout|sweet stout\b/, 'Milk Stout'],
  [/\boatmeal stout\b/, 'Oatmeal Stout'],
  [/\b(irish stout|dry stout|draught stout)\b/, 'Irish Stout'],
  [/\bstout\b/, 'Stout'],
  [/\bporter\b/, 'Porter'],
  [/\birish red\b/, 'Irish Red'],
  [/\bred ale\b/, 'Red Ale'],
  [/\bamber\b/, 'Amber Ale'],
  [/\bbrown ale\b|\bbrown\b/, 'Brown Ale'],
  [/\b(esb|extra special bitter)\b/, 'ESB'],
  [/\b(scotch ale|wee heavy)\b/, 'Scotch Ale'],
  [/\bbarley ?wine\b/, 'Barleywine'],
  [/\bwinter warmer\b/, 'Winter Warmer'],
  [/\bcream ale\b/, 'Cream Ale'],
  [/\b(blonde|golden ale|blond)\b/, 'Blonde Ale'],
  [/\b(especial|cerveza|mexican)\b/, 'Mexican Lager'],
  [/\b(light|lite)\b/, 'American Light Lager'],
  [/\blager\b/, 'American Lager'],
];

const RTD_RULES = [
  [/\b(seltzer|vodka soda)\b/, 'Hard Seltzer'],
  [/\b(hard tea|twisted tea|iced tea)\b/, 'Hard Tea'],
  [/\blemonade\b/, 'Hard Lemonade'],
  [/\b(cocktail|margarita|mojito|mule|paloma|daiquiri|spritz|old fashioned|cutwater)\b/, 'Canned Cocktail'],
  [/\b(smirnoff ice|malt)\b/, 'Malt Beverage'],
];

export function inferStyle(text = '', type = 'Beer') {
  const value = fold(text);
  if (type === 'Beer') {
    if (/\b(non alcoholic|non alc|alcohol free|0\.0|na beer|athletic brewing)\b/.test(value) || /\bnon\b.*\balcoholic\b/.test(value)) {
      if (/\bipa\b/.test(value)) return 'Non-Alcoholic IPA';
      if (/\b(stout|porter)\b/.test(value)) return 'Non-Alcoholic Stout';
      if (/\b(wheat|wit|hefe|weiss)\b/.test(value)) return 'Non-Alcoholic Wheat';
      if (/\b(golden|blonde|pale)\b/.test(value)) return 'Non-Alcoholic Golden';
      return 'Non-Alcoholic Lager';
    }
    return BEER_RULES.find(([test]) => (typeof test === 'function' ? test(value) : test.test(value)))?.[1] || '';
  }
  if (type === 'Ready-to-Drink') return RTD_RULES.find(([pattern]) => pattern.test(value))?.[1] || '';
  if (type === 'Cider') return /\brose\b/.test(value) ? 'Rosé Cider' : /\bperry|pear\b/.test(value) ? 'Perry' : /\b(berry|peach|mango|pineapple|cherry|cranberry|fruit)\b/.test(value) ? 'Fruit Cider' : 'Cider';
  const candidates = Object.entries(STYLES).filter(([, info]) => info.type === type).map(([name]) => name);
  return candidates.find(name => value.includes(fold(name))) || '';
}

// ---------------------------------------------------------------------------
// Seasons and occasions

export function currentSeason(date = new Date()) {
  const month = date.getMonth();
  if (month === 11 || month <= 1) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'fall';
}

const NEXT_SEASON = { winter: 'spring', spring: 'summer', summer: 'fall', fall: 'winter' };
export const SEASON_LABEL = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' };

/** Current season weighs 1; in the last month of a season, the next one starts to count. */
export function seasonWeights(date = new Date()) {
  const season = currentSeason(date);
  const weights = { [season]: 1 };
  if ([1, 4, 7, 10].includes(date.getMonth())) weights[NEXT_SEASON[season]] = 0.6;
  return weights;
}

export function seasonFit(item, weights) {
  const seasons = new Set([...(STYLES[item.style]?.seasons || []), ...(item.season ? [item.season] : [])]);
  let best = 0;
  seasons.forEach(season => { best = Math.max(best, weights[season] || 0); });
  // Seasonal releases out of season are a poor suggestion.
  if (item.season && !weights[item.season]) return -0.6;
  return best;
}

function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = new Date(year, month + 1, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - offset);
}

const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

export function occasionFor(date = new Date()) {
  const year = date.getFullYear();
  const day = new Date(year, date.getMonth(), date.getDate());
  const superBowl = nthWeekday(year, 1, 0, 2);
  const thanksgiving = nthWeekday(year, 10, 4, 4);
  const memorial = lastWeekday(year, 4, 1);
  const labor = nthWeekday(year, 8, 1, 1);
  const cookout = ['American Light Lager', 'Mexican Lager', 'Hard Seltzer', 'Shandy', 'Session IPA', 'Hard Tea', 'Pilsner'];
  const occasions = [
    { id: 'new-year', label: 'New Year’s', blurb: 'Bubbly for midnight and an NA option for the drive home.', start: new Date(year, 0, 1), end: new Date(year, 0, 1), styles: ['Champagne', 'Prosecco', 'Sparkling Wine', 'Non-Alcoholic Lager', 'Non-Alcoholic IPA'] },
    { id: 'game-day', label: 'Game day', blurb: 'Crushable lagers and seltzers for the big game.', start: addDays(superBowl, -6), end: superBowl, styles: ['American Light Lager', 'American Lager', 'Mexican Lager', 'Hard Seltzer', 'IPA'] },
    { id: 'st-patricks', label: 'St. Patrick’s Day', blurb: 'Irish stouts, a red ale and a cider.', start: new Date(year, 2, 10), end: new Date(year, 2, 17), styles: ['Irish Stout', 'Irish Red', 'Stout', 'Cider'] },
    { id: 'cinco', label: 'Cinco de Mayo', blurb: 'Mexican lagers with lime, and margaritas in a can.', start: new Date(year, 3, 28), end: new Date(year, 4, 5), styles: ['Mexican Lager', 'Canned Cocktail', 'Hard Seltzer'] },
    { id: 'memorial', label: 'Memorial Day cookout', blurb: 'Light, cold and easy for the first cookout of summer.', start: addDays(memorial, -4), end: memorial, styles: cookout },
    { id: 'july-4', label: 'Fourth of July', blurb: 'Cookout classics: light lagers, seltzers, shandies.', start: new Date(year, 5, 28), end: new Date(year, 6, 4), styles: cookout },
    { id: 'labor', label: 'Labor Day weekend', blurb: 'Last call for summer beers.', start: addDays(labor, -4), end: labor, styles: cookout },
    { id: 'oktoberfest', label: 'Oktoberfest', blurb: 'Märzen and Festbier season. Prost.', start: new Date(year, 8, 16), end: new Date(year, 9, 6), styles: ['Märzen', 'Festbier', 'Hefeweizen', 'Helles'] },
    { id: 'halloween', label: 'Halloween', blurb: 'Pumpkin ales and something dark.', start: new Date(year, 9, 24), end: new Date(year, 9, 31), styles: ['Pumpkin Ale', 'Porter', 'Stout', 'Cider'] },
    { id: 'thanksgiving', label: 'Thanksgiving week', blurb: 'Crisp lagers and cider for the table, a porter or stout with the pie.', start: addDays(thanksgiving, -6), end: addDays(thanksgiving, 1), styles: ['Pilsner', 'Amber Lager', 'Vienna Lager', 'Märzen', 'Cider', 'Brown Ale', 'Porter', 'Milk Stout', 'Pinot Noir'] },
    { id: 'holidays', label: 'Holiday season', blurb: 'Winter warmers, big stouts and something sparkling.', start: new Date(year, 11, 10), end: new Date(year, 11, 26), styles: ['Winter Warmer', 'Imperial Stout', 'Belgian Strong Dark', 'Doppelbock', 'Champagne', 'Prosecco'] },
    { id: 'new-year-eve', label: 'New Year’s Eve', blurb: 'Bubbly for midnight and an NA option for the drive home.', start: new Date(year, 11, 27), end: new Date(year, 11, 31), styles: ['Champagne', 'Prosecco', 'Sparkling Wine', 'Non-Alcoholic Lager', 'Non-Alcoholic IPA'] },
  ];
  return occasions.find(occasion => day >= occasion.start && day <= occasion.end) || null;
}

// ---------------------------------------------------------------------------
// Regions

export const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const REGIONS = {
  'New England': ['ME', 'NH', 'VT', 'MA', 'RI', 'CT'],
  'Mid-Atlantic': ['NY', 'NJ', 'PA', 'DE', 'MD', 'DC'],
  Southeast: ['VA', 'WV', 'NC', 'SC', 'GA', 'FL', 'AL', 'MS', 'TN', 'KY'],
  Midwest: ['OH', 'MI', 'IN', 'IL', 'WI', 'MN', 'IA', 'MO', 'KS', 'NE', 'SD', 'ND'],
  'South Central': ['TX', 'OK', 'AR', 'LA'],
  Mountain: ['MT', 'ID', 'WY', 'CO', 'UT', 'NV', 'AZ', 'NM'],
  Pacific: ['WA', 'OR', 'CA', 'AK', 'HI'],
};

export function stateCode(value = '') {
  if (!value) return '';
  const upper = String(value).trim().toUpperCase();
  if (STATE_NAMES[upper]) return upper;
  const folded = fold(value);
  return Object.entries(STATE_NAMES).find(([, name]) => fold(name) === folded)?.[0] || '';
}

export function regionOf(code = '') {
  return Object.entries(REGIONS).find(([, states]) => states.includes(code))?.[0] || '';
}
