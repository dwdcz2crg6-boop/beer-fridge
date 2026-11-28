// Small shared helpers. No dependencies.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
export function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => HTML_ESCAPES[char]);
}

export function debounce(fn, wait = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function uid(prefix = 'id') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

/** Lowercase, strip accents and punctuation: used for search and fuzzy matching. */
export function fold(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`®™]/g, '')
    .replace(/[^a-z0-9.%]+/g, ' ')
    .trim();
}

export const tokens = value => fold(value).split(/\s+/).filter(Boolean);

export function slug(value = '') {
  return fold(value).replace(/[.%]/g, '').trim().replace(/\s+/g, '-');
}

/** FNV-1a 32-bit hash: stable colors and daily rotation seeds. */
export function hash(value = '') {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function haversineMiles(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const toRad = degrees => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const longDateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function formatTime(iso) {
  return iso ? timeFormat.format(new Date(iso)) : '';
}

/** "Just now", "12 min ago", "3:41 PM", "Yesterday", "Tuesday", "Nov 3" */
export function relativeTime(iso, now = new Date()) {
  if (!iso) return '';
  const date = new Date(iso);
  const minutes = Math.round((now - date) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days === 0) return timeFormat.format(date);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekdayFormat.format(date);
  return dateFormat.format(date);
}

export function dayLabel(iso, now = new Date()) {
  if (!iso) return 'Earlier';
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return longDateFormat.format(new Date(iso));
}

export function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

export async function fetchJson(url, { timeout = 8000, signal, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
