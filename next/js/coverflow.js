// A Cover Flow-style 3D carousel built on native horizontal scrolling and
// scroll-snap, so touch swipes, momentum and accessibility come for free.
import { clamp } from './util.js';

const HOLD_MS = 380;        // press this long, without moving, to pick a card up
const HOLD_SLOP = 9;        // px of movement that turns a press into a swipe instead
const FLICK_DISTANCE = 84;  // px a picked-up card has to travel upward to be let go of...
const FLICK_SPEED = 0.55;   // ...or px/ms it has to be moving up when released (after 28 px)
const UP_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

/**
 * onFlickUp(index): optional. Press and hold a card, then flick it upward. The card lifts,
 * follows the finger, and `flickText` ({ idle, armed }) labels the hint above it.
 * onHoldRelease(index): optional. The card was picked up and put straight back down, without
 * being dragged anywhere: a long press.
 */
export function createCoverflow(root, { onChange, onActivate, onSettle, onFlickUp, onHoldRelease, canLift = () => true, flickText = { idle: 'Flick up to remove', armed: 'Let go to remove' } } = {}) {
  const track = root.querySelector('.cf-track');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let cards = [];
  let active = -1;
  let frame = 0;
  let drag = null;
  let suppressClick = false;
  let touching = false;
  let lastScroll = -1e9;
  let settleTimer = 0;
  let fitted = '';
  let seen = false;

  // The shelf fills whatever height the screen gives it, and the cans are sized to fit that
  // height (a can is 1.8 times as tall as it is wide), never wider than leaves its neighbours
  // in view. CSS reads the result as --card-w.
  function fit() {
    const height = root.clientHeight;
    const width = root.clientWidth;
    if (!height || !width) return false;
    const style = getComputedStyle(root);
    const top = parseFloat(style.getPropertyValue('--cf-top')) || 12;
    const floor = parseFloat(style.getPropertyValue('--cf-floor')) || 0.14; // reflection strip, in card widths
    const size = clamp(Math.min((height - top) / (1.8 + floor), width * 0.44), 64, 214);
    // Height the cans do not need (a tall screen): CSS shares it out above and below them.
    const rest = Math.max(0, height - top - size * (1.8 + floor));
    const next = `${size.toFixed(1)}px|${rest.toFixed(1)}px`;
    if (fitted === next) return false;
    fitted = next;
    root.style.setProperty('--card-w', `${size.toFixed(1)}px`);
    root.style.setProperty('--cf-rest', `${rest.toFixed(1)}px`);
    return true;
  }

  function layout() {
    frame = 0;
    // A hidden shelf has no width: every card would measure as the first one, and reporting
    // that would move the shelf's remembered place to the first can.
    if (!cards.length || !track.clientWidth) return;
    const center = track.scrollLeft + track.clientWidth / 2;
    let nearest = 0;
    let nearestDistance = Infinity;
    cards.forEach((card, index) => {
      // Tilt the inner wrapper, not the card. Scroll-snap lines up on the card's own box, and a
      // transform on it moves the snap point: cards then rest off center and a swipe skips some.
      const body = card.firstElementChild || card;
      const width = card.offsetWidth || 1;
      const offset = (card.offsetLeft + width / 2 - center) / width;
      const distance = Math.min(Math.abs(offset), 4);
      if (Math.abs(offset) < nearestDistance) {
        nearestDistance = Math.abs(offset);
        nearest = index;
      }
      const sign = Math.sign(offset);
      if (reduceMotion.matches) {
        body.style.transform = `scale(${(1 - Math.min(distance, 1) * 0.12).toFixed(3)})`;
        body.style.opacity = String(1 - Math.min(distance, 2) * 0.3);
      } else {
        const rotate = -sign * Math.min(distance * 58, 62);
        const shift = -sign * width * (distance <= 1 ? distance * 0.3 : 0.3 + (distance - 1) * 0.6);
        const depth = -Math.min(distance, 1) * 150 - Math.max(distance - 1, 0) * 34;
        body.style.transform = `perspective(900px) translate3d(${shift.toFixed(1)}px,0,${depth.toFixed(1)}px) rotateY(${rotate.toFixed(1)}deg)`;
        body.style.opacity = String(distance > 3 ? Math.max(0, 1 - (distance - 3)) : 1);
      }
      card.style.zIndex = String(100 - Math.round(distance * 10));
      // Paint only what can be on screen. A phone keeps a separate picture of every card it
      // has to draw, and with a full fridge it can run out and leave some of them blank.
      card.classList.toggle('is-shown', distance < 3.6);
      card.classList.toggle('is-near', distance < 2.6);
      const isActive = distance < 0.5;
      card.classList.toggle('is-active', isActive);
      card.setAttribute('aria-selected', String(isActive));
      card.tabIndex = isActive ? 0 : -1;
    });
    if (nearest !== active) {
      active = nearest;
      onChange?.(active);
    }
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(layout);
  };

  function goTo(index, smooth = true) {
    const card = cards[clamp(index, 0, cards.length - 1)];
    if (!card) return;
    const left = card.offsetLeft + card.offsetWidth / 2 - track.clientWidth / 2;
    track.scrollTo({ left, behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto' });
  }

  // ---- Press and hold a card, then flick it up -------------------------------------------
  let hold = null;
  let hint = null;
  if (onFlickUp) {
    hint = document.createElement('div');
    hint.className = 'cf-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.innerHTML = `${UP_ARROW}<span></span>`;
    root.append(hint);
  }
  const setHint = armed => {
    root.classList.toggle('is-letgo', armed); // not "is-armed": that class paints the app's two-tap delete buttons red
    hint.lastElementChild.textContent = armed ? flickText.armed : flickText.idle;
  };
  const resetArt = art => {
    art.style.transition = '';
    art.style.transform = '';
    art.style.opacity = '';
  };

  function holdCancel() {
    if (!hold) return;
    clearTimeout(hold.timer);
    const current = hold;
    hold = null;
    if (!current.lifted) return;
    root.classList.remove('is-lifting', 'is-letgo');
    current.card.classList.remove('is-lifted');
    resetArt(current.art);
  }

  function holdStart(card, x, y) {
    holdCancel();
    if (!onFlickUp || !card || !canLift(cards.indexOf(card))) return;
    hold = { card, art: card.querySelector('.cf-art'), x, y, dy: 0, travel: 0, lifted: false, scroll: track.scrollLeft, samples: [], timer: setTimeout(holdLift, HOLD_MS) };
  }

  function holdLift() {
    if (!hold) return;
    hold.lifted = true;
    if (drag) { // a mouse press was also a scroll-drag in waiting
      drag = null;
      track.style.scrollSnapType = '';
    }
    hold.card.classList.add('is-lifted');
    root.classList.add('is-lifting');
    setHint(false);
    try { navigator.vibrate?.(10); } catch { /* not supported */ }
  }

  function holdMove(x, y) {
    if (!hold) return;
    if (!hold.lifted) {
      if (Math.hypot(x - hold.x, y - hold.y) > HOLD_SLOP) holdCancel(); // it's a swipe
      return;
    }
    const raw = y - hold.y;
    hold.travel = Math.max(hold.travel, Math.hypot(x - hold.x, raw)); // how far it was ever carried
    hold.dy = raw < 0 ? raw : raw * 0.25; // follows the finger up, resists being pulled down
    hold.samples.push([performance.now(), y]);
    if (hold.samples.length > 5) hold.samples.shift();
    const up = Math.max(0, -hold.dy);
    hold.art.style.transition = 'none';
    hold.art.style.transform = `translate3d(0,${hold.dy.toFixed(1)}px,0) scale(1.05)`;
    hold.art.style.opacity = String(Math.max(0.35, 1 - up / 320));
    setHint(up >= FLICK_DISTANCE);
  }

  function holdEnd() {
    if (!hold) return;
    clearTimeout(hold.timer);
    const current = hold;
    hold = null;
    if (!current.lifted) return;
    // The press was a pick-up, not a tap: swallow the click that may follow it.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    const first = current.samples[0];
    const last = current.samples.at(-1);
    const speed = first && last && last[0] > first[0] ? (last[1] - first[1]) / (last[0] - first[0]) : 0; // px/ms, negative = upward
    const up = -current.dy;
    const flicked = up >= FLICK_DISTANCE || (up >= 28 && speed <= -FLICK_SPEED);
    root.classList.remove('is-lifting', 'is-letgo');
    current.card.classList.remove('is-lifted');
    const { art, card } = current;
    if (!flicked) {
      art.style.transition = 'transform .22s ease-out, opacity .22s ease-out';
      art.style.transform = '';
      art.style.opacity = '';
      setTimeout(() => { if (!hold || hold.art !== art) art.style.transition = ''; }, 260);
      // Picked up and set straight back down: a long press. A card that was carried off and
      // brought back was a flick the owner thought better of, so that does nothing.
      if (onHoldRelease && current.travel < HOLD_SLOP) onHoldRelease(cards.indexOf(card));
      return;
    }
    art.style.transition = 'transform .2s ease-in, opacity .2s ease-in';
    art.style.transform = `translate3d(0,${Math.min(current.dy - 220, -320)}px,0) scale(.92)`;
    art.style.opacity = '0';
    setTimeout(() => {
      onFlickUp(cards.indexOf(card));
      if (card.isConnected) resetArt(art); // the app kept the card after all
    }, reduceMotion.matches ? 0 : 190);
  }

  if (onFlickUp) {
    track.addEventListener('touchstart', event => {
      if (event.touches.length !== 1) { holdCancel(); return; }
      const touch = event.touches[0];
      holdStart(event.target.closest?.('.cf-card'), touch.clientX, touch.clientY);
    }, { passive: true });
    // Not passive: once a card is picked up, the page and the flow must hold still under the finger.
    track.addEventListener('touchmove', event => {
      if (!hold) return;
      if (hold.lifted && event.cancelable) event.preventDefault();
      const touch = event.touches[0];
      if (touch) holdMove(touch.clientX, touch.clientY);
    }, { passive: false });
    track.addEventListener('touchend', holdEnd);
    track.addEventListener('touchcancel', holdCancel);
    track.addEventListener('contextmenu', event => { if (hold) event.preventDefault(); });
  }

  // The shelf has come to rest (no scrolling for a moment and no finger on it).
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (touching || drag) { settle(); return; }
      if (active >= 0) onSettle?.(active);
    }, 160);
  };
  track.addEventListener('scroll', () => {
    // The flow started to move under a resting finger: it's a swipe, not a press.
    if (hold && !hold.lifted && Math.abs(track.scrollLeft - hold.scroll) > 3) holdCancel();
    lastScroll = performance.now();
    schedule();
    if (onSettle) settle();
  }, { passive: true });
  track.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  const touchDone = () => { touching = false; if (onSettle) settle(); };
  track.addEventListener('touchend', touchDone, { passive: true });
  track.addEventListener('touchcancel', touchDone, { passive: true });
  // When the shelf changes size (the details panel opening, the phone turning) the cans are
  // resized to fit and the can in the middle is kept in the middle.
  new ResizeObserver(() => {
    const resized = fit();
    // A shelf that was hidden (another tab was showing) comes back with its scroll position
    // gone: put the can that was in the middle back there before anything is measured.
    const visible = track.clientWidth > 0;
    const revealed = visible && !seen;
    seen = visible;
    const idle = !touching && !drag && performance.now() - lastScroll > 200;
    if (visible && (revealed || (resized && idle)) && active >= 0) {
      goTo(active, false);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      layout();
    } else {
      schedule();
    }
  }).observe(root);

  track.addEventListener('click', event => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const card = event.target.closest('.cf-card');
    if (!card) return;
    const index = cards.indexOf(card);
    if (index === active) onActivate?.(index);
    else goTo(index);
  });

  root.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      goTo(active + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goTo(active - 1);
    }
  });

  root.querySelector('.cf-prev')?.addEventListener('click', () => goTo(active - 1));
  root.querySelector('.cf-next')?.addEventListener('click', () => goTo(active + 1));

  // Mouse drag for desktop (touch already scrolls natively).
  track.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    drag = { x: event.clientX, left: track.scrollLeft, moved: false };
    track.style.scrollSnapType = 'none';
    track.setPointerCapture(event.pointerId);
    holdStart(event.target.closest?.('.cf-card'), event.clientX, event.clientY);
  });
  track.addEventListener('pointermove', event => {
    if (hold && event.pointerType === 'mouse') {
      holdMove(event.clientX, event.clientY);
      if (hold?.lifted) return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    track.scrollLeft = drag.left - dx;
  });
  const endDrag = () => {
    if (!drag) return;
    suppressClick = drag.moved;
    drag = null;
    track.style.scrollSnapType = '';
    goTo(active);
  };
  track.addEventListener('pointerup', event => {
    if (event.pointerType === 'mouse') holdEnd();
    endDrag();
  });
  track.addEventListener('pointercancel', event => {
    if (event.pointerType === 'mouse') holdCancel();
    endDrag();
  });

  return {
    setCards(html, { index = 0 } = {}) {
      holdCancel();
      fit();
      track.innerHTML = html;
      cards = [...track.querySelectorAll('.cf-card')];
      active = -1;
      // Place the cards right away (no one-frame jump back to the first card), then
      // once more after layout in case the stage was hidden or just resized.
      const place = () => {
        goTo(index, false);
        if (frame) cancelAnimationFrame(frame);
        layout();
      };
      if (track.clientWidth) place();
      requestAnimationFrame(place);
    },
    goTo,
    refresh() { fit(); schedule(); },
    /** Set the label on the lift hint (it differs by what the centred card is). */
    setFlickText(text) { Object.assign(flickText, text); },
    get index() {
      return active;
    },
    get count() {
      return cards.length;
    },
  };
}
