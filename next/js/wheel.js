// A number thumbwheel: a dial you slide sideways (or roll with a mouse wheel) to
// pick a count. Built on native scrolling and scroll-snap, so flicks and momentum
// feel right on a phone. Only movement the person started changes the value;
// layout-driven scrolling (hidden screens, resizes) never does.
import { clamp } from './util.js';

const TICK = 44; // keep in sync with --tick in styles.css
const WHEEL_STEP = 36; // mouse-wheel pixels per number

// A page scroll that happens to pass over a dial must not change it.
let lastPageWheel = -1e9;
if (typeof window !== 'undefined') {
  window.addEventListener('wheel', event => {
    if (!event.target.closest?.('.wheel')) lastPageWheel = event.timeStamp;
  }, { passive: true, capture: true });
}

export function createWheel(root, { min = 0, max = 150, value = 0, onInput, onSettle } = {}) {
  const track = root.querySelector('.wheel-track');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let nums = [];
  let limit = max;
  let current = clamp(Math.round(value), min, limit);
  let target = null; // where a tap on ± is heading while it animates
  let interacting = false;
  let touching = false;
  let drag = null;
  let suppressClick = false;
  let settleTimer = 0;
  let resyncTimer = 0;
  let frame = 0;
  let painted = new Set();
  let wheelAccum = 0;
  let lastOwnWheel = -1e9;

  function build() {
    let html = '';
    for (let n = min; n <= limit; n += 1) html += `<span class="wheel-num">${n}</span>`;
    track.innerHTML = html;
    nums = [...track.children];
    painted = new Set();
  }

  const tick = () => nums[0]?.offsetWidth || TICK;
  const leftFor = number => (number - min) * tick();
  const valueAt = () => clamp(min + Math.round(track.scrollLeft / tick()), min, limit);

  function paint() {
    frame = 0;
    const position = track.scrollLeft / tick();
    const center = clamp(Math.round(position), 0, nums.length - 1);
    const next = new Set();
    for (let index = Math.max(0, center - 4); index <= Math.min(nums.length - 1, center + 4); index += 1) {
      const distance = Math.abs(index - position);
      const node = nums[index];
      node.style.transform = `scale(${(1.36 - Math.min(distance, 2.2) * 0.26).toFixed(3)})`;
      node.style.opacity = (1 - Math.min(distance, 3.6) * 0.22).toFixed(2);
      node.classList.toggle('is-on', index === center);
      next.add(node);
    }
    painted.forEach(node => {
      if (next.has(node)) return;
      node.style.transform = '';
      node.style.opacity = '';
      node.classList.remove('is-on');
    });
    painted = next;
  }

  const schedulePaint = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  function announce() {
    root.setAttribute('aria-valuemin', String(min));
    root.setAttribute('aria-valuemax', String(limit));
    root.setAttribute('aria-valuenow', String(current));
  }

  /** Put the dial where the value says it should be (no callbacks). */
  function sync() {
    const left = leftFor(current);
    if (Math.abs(track.scrollLeft - left) > 0.5) track.scrollLeft = left;
    schedulePaint();
  }

  function armSettle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 170);
  }

  function settle() {
    if (touching || drag) { armSettle(); return; } // finger still down
    interacting = false;
    target = null;
    sync();
    onSettle?.(current);
  }

  function begin() {
    interacting = true;
    clearTimeout(resyncTimer);
  }

  /** Move to a number. The value changes right away; the dial just animates to it. */
  function goTo(number) {
    const next = clamp(Math.round(number), min, limit);
    target = next;
    begin();
    if (next !== current) {
      current = next;
      announce();
      onInput?.(current);
    }
    track.scrollTo({ left: leftFor(next), behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    armSettle();
  }

  const step = delta => goTo((target ?? current) + delta);

  track.addEventListener('scroll', () => {
    schedulePaint();
    if (!interacting) {
      // Not ours (layout, a cancelled fling): quietly return to the real value.
      clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => { if (!interacting) sync(); }, 220);
      return;
    }
    // While a tap on ± animates, the value is already decided; only a finger,
    // drag or sideways swipe makes it follow the dial.
    const next = target ?? valueAt();
    if (next !== current) {
      current = next;
      announce();
      onInput?.(current);
    }
    armSettle();
  }, { passive: true });

  // Touch: native scrolling does the work; we only need to know a finger is down.
  track.addEventListener('touchstart', () => { touching = true; target = null; begin(); }, { passive: true });
  const touchEnd = () => { touching = false; if (interacting) armSettle(); };
  track.addEventListener('touchend', touchEnd, { passive: true });
  track.addEventListener('touchcancel', touchEnd, { passive: true });

  // Mouse: drag the dial.
  track.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    drag = { x: event.clientX, left: track.scrollLeft, moved: false };
    target = null;
    begin();
    track.style.scrollSnapType = 'none';
    track.setPointerCapture(event.pointerId);
  });
  track.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    track.scrollLeft = drag.left - dx;
  });
  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    suppressClick = moved;
    drag = null;
    track.style.scrollSnapType = '';
    if (moved) goTo(valueAt());
    else armSettle();
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  // Tap a number to jump straight to it.
  track.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return; }
    const node = event.target.closest('.wheel-num');
    if (node) goTo(min + nums.indexOf(node));
  });

  // Mouse wheel / trackpad.
  root.addEventListener('wheel', event => {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) { // sideways swipe: native scrolling
      target = null;
      begin();
      armSettle();
      return;
    }
    const continuingPageScroll = event.timeStamp - lastPageWheel < 400 && event.timeStamp - lastOwnWheel > 400;
    if (continuingPageScroll) { lastPageWheel = event.timeStamp; return; }
    event.preventDefault();
    lastOwnWheel = event.timeStamp;
    wheelAccum -= event.deltaY * (event.deltaMode === 1 ? 32 : 1); // roll up = more
    const steps = Math.trunc(wheelAccum / WHEEL_STEP);
    if (steps) {
      wheelAccum -= steps * WHEEL_STEP;
      step(steps);
    }
  }, { passive: false });

  root.addEventListener('keydown', event => {
    const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[event.key];
    if (!delta) return;
    event.preventDefault();
    step(delta);
  });

  new ResizeObserver(() => { if (!interacting) sync(); }).observe(track);

  build();
  announce();
  sync();

  return {
    /** Show `number` without telling anyone. Ignored mid-gesture unless `force`. */
    setValue(number, { force = false } = {}) {
      if (interacting && !force) return false;
      if (force) {
        interacting = false;
        touching = false;
        drag = null;
        target = null;
        clearTimeout(settleTimer);
      }
      const next = Math.max(min, Math.round(Number(number) || 0));
      if (next > limit) {
        limit = next + 60;
        build();
      }
      current = next;
      announce();
      sync();
      return true;
    },
    step,
    get value() {
      return current;
    },
    get busy() {
      return interacting;
    },
  };
}
