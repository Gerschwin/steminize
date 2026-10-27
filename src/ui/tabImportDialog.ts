// A small window listing the tracks of an imported score, for choosing which one to bring in.

import type { TrackInfo } from '../import/tabImport.ts';
import { h, openDialog } from './dom.ts';

/** Resolves with the chosen track's index, or null if the window is closed without choosing. */
export function pickTrack(fileName: string, tracks: TrackInfo[]): Promise<number | null> {
  return new Promise((resolve) => {
    let chosen: number | null = null;
    const dlg = h('dialog', { 'aria-label': 'Choose a track' });
    const close = h('button', { class: 'btn tiny ghost', type: 'button', 'aria-label': 'Cancel' }, 'Cancel');
    close.onclick = () => dlg.close();
    dlg.append(
      h('div', { class: 'dlg-head' }, h('h2', {}, 'Which track?'), close),
      h('p', { class: 'muted small' }, `${fileName} has more than one track. The tab goes in the part (guitar, bass or drums) that the track you choose is for.`),
      h(
        'div',
        { class: 'track-pick' },
        ...tracks.map((t) => {
          const b = h('button', { class: 'btn', type: 'button' }, h('b', {}, t.name), h('span', { class: 'muted small' }, ` ${t.part === 'drums' ? 'drums' : `${t.part}, ${t.strings} strings`} · ${t.bars} bars`));
          b.onclick = () => {
            chosen = t.index;
            dlg.close();
          };
          return b;
        }),
      ),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(chosen);
    });
    document.body.append(dlg);
    openDialog(dlg);
  });
}
