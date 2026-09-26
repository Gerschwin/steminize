// The About dialog (version, what uses the network, credits and licences), plus the one piece of
// desktop plumbing links need: a Tauri webview won't open target="_blank" links by itself.
import licenceSteminize from '../../LICENSE?raw';
import licenceBasicPitch from '../analysis/models/BASIC-PITCH-LICENSE?raw';
import noticeBasicPitch from '../analysis/models/BASIC-PITCH-NOTICE?raw';
import { isTauri } from '../platform.ts';
import { $, openDialog, toast } from './dom.ts';

export function initAbout() {
  $('aboutVersion').textContent = `v${__APP_VERSION__}`;
  $('aboutBuild').textContent = `${isTauri ? 'Desktop app' : 'Web app'} · built ${__BUILD_DATE__}`;
  $('licSteminize').textContent = licenceSteminize.trim();
  $('licBasicPitch').textContent = `${noticeBasicPitch.trim()}\n\n${licenceBasicPitch.trim()}`;
  $('aboutBtn').onclick = () => openDialog($<HTMLDialogElement>('aboutDlg'));

  // Desktop: open external links in the default browser (the backend only honours known https hosts).
  if (isTauri) {
    document.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('open_link', { url: a.href }))
        .catch((err) => toast(`Couldn't open the link: ${err}`, true));
    });
  }
}
