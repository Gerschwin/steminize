// The About dialog (version, what uses the network, credits and licences), plus the one piece of
// desktop plumbing links need: a Tauri webview won't open target="_blank" links by itself.
import licenceSteminize from '../../LICENSE?raw';
import licenceBasicPitch from '../analysis/models/BASIC-PITCH-LICENSE?raw';
import noticeBasicPitch from '../analysis/models/BASIC-PITCH-NOTICE?raw';
import { isTauri } from '../platform.ts';
import { isNewer } from '../version.ts';
import { collectDiagnostics } from './diagnostics.ts';
import { $, openDialog, toast } from './dom.ts';

const RELEASES_URL = 'https://github.com/Gerschwin/steminize/releases';
const LATEST_API = 'https://api.github.com/repos/Gerschwin/steminize/releases/latest';

/** Asks GitHub for the newest published release, only when the user presses the button. */
async function checkForUpdates() {
  const btn = $<HTMLButtonElement>('updateBtn');
  const status = $('updateStatus');
  const link = $<HTMLAnchorElement>('updateLink');
  btn.disabled = true;
  link.hidden = true;
  status.textContent = 'Checking…';
  try {
    const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 404) status.textContent = 'No published release found yet.';
    else if (res.status === 403 || res.status === 429) status.textContent = 'GitHub is limiting requests right now. Try again in a while.';
    else if (!res.ok) status.textContent = `GitHub answered ${res.status}. Try again later.`;
    else {
      const rel = (await res.json()) as { tag_name?: string; html_url?: string };
      const tag = String(rel.tag_name ?? '');
      if (isNewer(tag, __APP_VERSION__)) {
        status.textContent = `${tag} is available (you have v${__APP_VERSION__}).`;
        // Only ever link to this project's own releases, whatever the response says.
        link.href = rel.html_url?.startsWith(`${RELEASES_URL}/`) ? rel.html_url : RELEASES_URL;
        link.hidden = false;
      } else {
        status.textContent = `You're up to date (v${__APP_VERSION__}).`;
      }
    }
  } catch {
    status.textContent = "Couldn't reach GitHub. Check your connection.";
  } finally {
    btn.disabled = false;
  }
}

/** Copies text to the clipboard; falls back to the visible textarea for webviews without the async API. */
async function copyText(text: string, area: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

export function initAbout() {
  $('aboutVersion').textContent = `v${__APP_VERSION__}`;
  $('aboutBuild').textContent = `${isTauri ? 'Desktop app' : 'Web app'} · built ${__BUILD_DATE__}`;
  $('licSteminize').textContent = licenceSteminize.trim();
  $('licBasicPitch').textContent = `${noticeBasicPitch.trim()}\n\n${licenceBasicPitch.trim()}`;
  $('aboutBtn').onclick = () => openDialog($<HTMLDialogElement>('aboutDlg'));

  // Updates: the desktop app is installed by hand, so it can't update itself. (The web app updates on reload.)
  if (isTauri) {
    $('aboutUpdate').hidden = false;
    $('updateBtn').onclick = () => void checkForUpdates();
  }

  const diagBtn = $<HTMLButtonElement>('diagBtn');
  const diagText = $<HTMLTextAreaElement>('diagText');
  diagBtn.onclick = async () => {
    diagBtn.disabled = true;
    $('diagStatus').textContent = 'Collecting…';
    try {
      diagText.value = await collectDiagnostics();
      $('diagStatus').textContent = (await copyText(diagText.value, diagText)) ? 'Copied to the clipboard.' : 'Select the text below and copy it.';
      if (!diagText.closest('details')!.open) diagText.closest('details')!.open = $('diagStatus').textContent.startsWith('Select');
    } catch (e) {
      $('diagStatus').textContent = `Couldn't collect it: ${(e as Error).message}`;
    } finally {
      diagBtn.disabled = false;
    }
  };

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
