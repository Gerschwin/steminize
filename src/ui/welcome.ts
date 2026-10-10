// The panel a new user sees when no song is open: what the app is for, three ways to start, and what the first split will download.
// It stays up to date with the chosen model (size, and whether it is already on this computer).

import { MODELS, modelNote } from '../models.ts';
import { hasModel } from '../modelstore.ts';
import type { Settings } from '../settings.ts';
import { $ } from './dom.ts';

export function initWelcome(settings: () => Settings) {
  const choose = (id: string) => () => $<HTMLInputElement>(id).click();
  $('welcomeChoose').onclick = choose('fileInput');
  $('welcomeTracks').onclick = choose('multiFiles');
  const render = async () => {
    const s = settings();
    const m = MODELS[s.model];
    const files = m.files[s.precision];
    const bytes = files.reduce((a, f) => a + f.bytes, 0);
    const have = await Promise.all(files.map(hasModel));
    $('welcomeModel').textContent = modelNote(m.label, bytes, have.every(Boolean) ? true : have.some(Boolean) ? 'partly' : false);
  };
  void render();
  return render;
}
