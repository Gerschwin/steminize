import { downloadYoutube, searchYoutube, type YtResult } from '../ytdlp.ts';
import { $, fmtTime, h } from './dom.ts';

/** Wires up the "From YouTube" dialog; `onDownloaded` hands the finished file to the import queue. */
export function initYoutubeDialog(onDownloaded: (file: File) => void) {
  const dlg = $<HTMLDialogElement>('ytDlg');
  const form = $<HTMLFormElement>('ytSearchForm');
  const song = $<HTMLInputElement>('ytSong');
  const artist = $<HTMLInputElement>('ytArtist');
  const status = $('ytStatus');
  const list = $('ytResults');
  let busy = false;

  function resultItem(r: YtResult) {
    const bar = h('div', { class: 'bar' }, h('i'));
    const fill = bar.firstElementChild as HTMLElement;
    const btn = h(
      'button',
      { class: 'yt-result', type: 'button', title: r.title },
      r.thumbnail ? h('img', { src: r.thumbnail, alt: '', loading: 'lazy' }) : h('span', { class: 'yt-thumb-blank' }),
      h(
        'div',
        { class: 'yt-meta' },
        h('div', { class: 'yt-title' }, r.title),
        h('div', { class: 'muted small' }, [r.uploader, r.duration != null ? fmtTime(r.duration) : ''].filter(Boolean).join(' · ')),
      ),
      bar,
    );
    btn.onclick = () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      status.textContent = `Downloading "${r.title}"…`;
      downloadYoutube(r.id, r.title, (frac) => (fill.style.width = `${Math.round(frac * 100)}%`))
        .then((file) => {
          onDownloaded(file);
          dlg.close();
        })
        .catch((e) => {
          status.textContent = `Download failed: ${(e as Error).message ?? e}`;
          btn.disabled = false;
        })
        .finally(() => (busy = false));
    };
    return btn;
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    if (busy) return;
    const query = [artist.value, song.value]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ');
    if (!query) return;
    busy = true;
    list.replaceChildren();
    status.textContent = 'Searching…';
    searchYoutube(query)
      .then((results) => {
        status.textContent = results.length ? '' : 'No results.';
        list.replaceChildren(...results.map(resultItem));
      })
      .catch((e) => (status.textContent = `Search failed: ${(e as Error).message ?? e}`))
      .finally(() => (busy = false));
  };

  return {
    open() {
      list.replaceChildren();
      status.textContent = '';
      song.value = '';
      artist.value = '';
      dlg.showModal();
      song.focus();
    },
  };
}
