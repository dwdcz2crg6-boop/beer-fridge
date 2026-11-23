// Barcode helpers and the online UPC lookup chain.
import { fetchJson } from './util.js';
import { inferStyle, inferType } from './taxonomy.js';

const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,generic_name_en,brands,quantity,categories_tags,image_front_small_url,nutriments';

export const digitsOnly = value => String(value || '').replace(/\D/g, '');

export function checkDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, position = 0; i >= 0; i -= 1, position += 1) {
    sum += Number(body[i]) * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(code) {
  const digits = digitsOnly(code);
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  return checkDigit(digits.slice(0, -1)) === Number(digits.at(-1));
}

/** Expand an 8-digit UPC-E to its 12-digit UPC-A form. */
export function upcEtoA(code) {
  const digits = digitsOnly(code);
  if (digits.length !== 8 || !['0', '1'].includes(digits[0])) return null;
  const [ns, d1, d2, d3, d4, d5, d6, check] = digits;
  let body;
  if ('012'.includes(d6)) body = `${ns}${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === '3') body = `${ns}${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === '4') body = `${ns}${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${ns}${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return body + check;
}

function looksLikeUpcE(digits, format) {
  if (format === 'upc_e') return true;
  if (format === 'ean_8') return false;
  const expanded = upcEtoA(digits);
  return Boolean(expanded && isValidGtin(expanded));
}

/** 14-digit GTIN used as the storage key, so 12/13-digit and UPC-E forms of one product agree. */
export function canonicalCode(code, format) {
  const digits = digitsOnly(code);
  if (digits.length === 8 && looksLikeUpcE(digits, format)) return upcEtoA(digits).padStart(14, '0');
  if ([8, 12, 13, 14].includes(digits.length)) return digits.padStart(14, '0');
  return digits;
}

export function displayCode(code) {
  const digits = digitsOnly(code);
  if (digits.length === 14 && digits.startsWith('00')) return digits.slice(2);
  if (digits.length === 14 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/** Codes to try against Open Food Facts (it keeps UPC-E separately from UPC-A). */
function queryVariants(code, format) {
  const digits = digitsOnly(code);
  const variants = [];
  if (digits.length === 8 && looksLikeUpcE(digits, format)) variants.push(digits, upcEtoA(digits));
  else if (digits.length === 14) variants.push(digits.slice(1));
  else variants.push(digits);
  return [...new Set(variants.filter(Boolean))];
}

/** GTIN-13 prefixes (7-10 digits) used to learn which company a barcode belongs to. */
export function companyPrefixes(canonical) {
  const gtin13 = digitsOnly(canonical).padStart(14, '0').slice(1);
  return [10, 9, 8, 7].map(length => gtin13.slice(0, length));
}

export function normalizeSize(quantity = '') {
  const text = String(quantity).toLowerCase().replace(/\(.*?\)/g, ' ').trim();
  let match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:fl\.?\s*oz\.?|fluid ounces?|oz\b)/);
  if (match) return `${parseFloat(match[1].replace(',', '.'))} fl oz`;
  match = text.match(/(\d+(?:[.,]\d+)?)\s*(ml|cl|l)\b/);
  if (match) {
    const unit = { ml: 1, cl: 10, l: 1000 }[match[2]];
    const ml = Math.round(parseFloat(match[1].replace(',', '.')) * unit);
    return { 355: '12 fl oz', 354: '12 fl oz', 473: '16 fl oz', 568: '19.2 fl oz', 710: '24 fl oz', 750: '750 ml', 375: '375 ml' }[ml] || `${ml} ml`;
  }
  return '';
}

function parseAbv(value, text = '') {
  const number = Number(value);
  if (value != null && value !== '' && Number.isFinite(number) && number >= 0 && number <= 70) return Math.round(number * 10) / 10;
  const match = String(text).match(/(\d{1,2}(?:\.\d)?)\s*%\s*(?:abv|alc|alcohol|vol)/i);
  return match ? Number(match[1]) : null;
}

/** "Michelob ULTRA® Light Beer, 12 fl. oz. Can" → "Michelob ULTRA Light Beer" */
export function cleanTitle(title = '') {
  return String(title)
    .replace(/[®™]/g, '')
    .replace(/,?\s*\d+(?:\.\d+)?\s*(?:fl\.?\s*oz\.?|oz|ml|cl|l)\b\.?.*$/i, '')
    .replace(/,?\s*\d+\s*(?:pk|pack|ct|count)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,.-]+$/, '')
    .trim();
}

function fromOpenFoodFacts(product, code) {
  const name = cleanTitle(product.product_name_en || product.product_name || product.generic_name_en || product.generic_name || '');
  const brand = String(product.brands || '').split(',')[0].trim();
  const categories = (product.categories_tags || []).map(tag => tag.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ')).join(' ');
  const type = inferType(`${name} ${categories}`) || inferType(brand);
  const nutriments = product.nutriments || {};
  return {
    source: 'Open Food Facts',
    code,
    name,
    brand,
    size: normalizeSize(product.quantity),
    type,
    style: type ? inferStyle(`${name} ${categories}`, type) : '',
    abv: type === 'Beer' || type === 'Cider' || type === 'Wine' || type === 'Ready-to-Drink' ? parseAbv(nutriments.alcohol_value ?? nutriments.alcohol ?? nutriments.alcohol_100g, name) : null,
    image: product.image_front_small_url || '',
  };
}

function fromProxyPayload(payload, code) {
  const record = payload?.items?.[0] || payload?.product || payload?.item || payload;
  const title = record?.title || record?.name || record?.product_name || '';
  if (!title) return null;
  const brand = record.brand || record.brands || '';
  const extra = `${record.category || ''} ${record.description || ''}`;
  const name = cleanTitle(title);
  const type = inferType(`${title} ${record.category || ''}`) || inferType(extra);
  return {
    source: 'UPC lookup',
    code,
    name,
    brand: String(brand).split(',')[0].trim(),
    size: normalizeSize(record.size || title),
    type,
    style: type ? inferStyle(`${title} ${record.category || ''}`, type) : '',
    abv: parseAbv(record.abv, `${title} ${extra}`),
    image: Array.isArray(record.images) ? record.images[0] || '' : record.image || '',
  };
}

/**
 * Look up a barcode online. Open Food Facts first (free, open data, CORS),
 * then the optional user-configured proxy (e.g. the UPCitemdb worker in tools/).
 * Resolves to a product guess or null.
 */
export async function lookupBarcode(code, { format, proxy } = {}) {
  for (const variant of queryVariants(code, format)) {
    try {
      const data = await fetchJson(`https://world.openfoodfacts.org/api/v2/product/${variant}.json?fields=${OFF_FIELDS}`, { timeout: 6500 });
      if (data?.status === 1 && data.product) {
        const product = fromOpenFoodFacts(data.product, variant);
        if (product.name || product.brand) return product;
      }
    } catch { /* try the next source */ }
  }
  if (proxy) {
    const digits = digitsOnly(code);
    const upc = digits.length === 8 && looksLikeUpcE(digits, format) ? upcEtoA(digits) : displayCode(canonicalCode(digits, format));
    const url = proxy.includes('{code}') ? proxy.replace('{code}', encodeURIComponent(upc)) : `${proxy}${proxy.includes('?') ? '&' : '?'}upc=${encodeURIComponent(upc)}`;
    try {
      const product = fromProxyPayload(await fetchJson(url, { timeout: 7000 }), upc);
      if (product) return product;
    } catch { /* fall through to manual pick */ }
  }
  return null;
}
