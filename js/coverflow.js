// A Cover Flow-style 3D carousel built on native horizontal scrolling and
// scroll-snap, so touch swipes, momentum and accessibility come for free.
import { clamp } from './util.js';

export function createCoverflow(root, { onChange, onActivate } = {}) {
  const track = root.querySelector('.cf-track');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let cards = [];
  let active = -1;
  let frame = 0;
  let drag = null;
  let suppressClick = false;

  function layout() {
    frame = 0;
    if (!cards.length) return;
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

  track.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(track);

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
  });
  track.addEventListener('pointermove', event => {
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
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  return {
    setCards(html, { index = 0 } = {}) {
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
    refresh: schedule,
    get index() {
      return active;
    },
    get count() {
      return cards.length;
    },
  };
}
