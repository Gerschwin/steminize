// The left panel (Songs, Settings) shrinks to a narrow rail while a song is open, which gives the song the width. Click a tab on the
// rail to open the panel over the song for a moment; click anywhere else (or press Escape, or open a song) to put it away. The button
// at the end of the tabs keeps the panel open all the time instead, and is remembered.

import { $, h } from './dom.ts';

const KEY = 'steminize.sideRail';

export function initSideRail() {
  const layout = document.querySelector<HTMLElement>('.layout');
  const tabs = document.querySelector<HTMLElement>('.side-tabs');
  const deck = document.getElementById('deck');
  if (!layout || !tabs || !deck) return;

  let keepOpen = false;
  try {
    keepOpen = localStorage.getItem(KEY) === 'open';
  } catch {
    /* no storage: rail it is */
  }
  let peek = false;

  const pin = h('button', { class: 'side-pin', type: 'button' });
  tabs.append(pin);

  const apply = () => {
    const rail = !deck.hidden && !keepOpen;
    layout.classList.toggle('side-rail', rail);
    layout.classList.toggle('side-peek', rail && peek);
    pin.textContent = rail ? '»' : '«';
    pin.title = rail ? 'Keep the Songs and Settings panel open' : 'Narrow the panel to a rail while a song is open';
    pin.hidden = deck.hidden && !keepOpen; // nothing to collapse on the start screen
  };

  pin.onclick = () => {
    keepOpen = layout.classList.contains('side-rail');
    peek = false;
    try {
      if (keepOpen) localStorage.setItem(KEY, 'open');
      else localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    apply();
  };

  // A tab on the rail opens its panel over the song; the same tab again closes it.
  let lastTab = '';
  for (const t of document.querySelectorAll<HTMLElement>('.stab')) {
    t.addEventListener('click', () => {
      if (!layout.classList.contains('side-rail')) return;
      peek = !(peek && lastTab === t.dataset.side);
      lastTab = t.dataset.side ?? '';
      apply();
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (peek && !(e.target as Element).closest('.side')) {
      peek = false;
      apply();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (peek && e.key === 'Escape') {
      peek = false;
      apply();
    }
  });
  // Opening a song (a new title) puts the panel away.
  new MutationObserver(() => {
    peek = false;
    apply();
  }).observe($('trackTitle'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(apply).observe(deck, { attributes: true, attributeFilter: ['hidden'] });
  apply();
}
