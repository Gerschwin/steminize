// Dark/light: dark is always the default, regardless of the OS preference, unless the button
// here has set an explicit choice, which is remembered and wins from then on either way.
// A small inline script in index.html applies the stored choice before the first paint (so there is no
// flash of the wrong theme); keep its storage key and values in step with this file.
const KEY = 'steminize.theme';
const DARK_BG = '#09090d';
const LIGHT_BG = '#f5f6fa';

type Theme = 'dark' | 'light';

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

function effective(): Theme {
  return stored() ?? 'dark';
}

export function initTheme(btn: HTMLButtonElement, meta: HTMLMetaElement) {
  const sync = () => {
    const on = effective();
    btn.title = on === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    btn.classList.toggle('is-light', on === 'light');
    meta.content = on === 'dark' ? DARK_BG : LIGHT_BG;
  };
  document.documentElement.setAttribute('data-theme', effective());
  sync();
  btn.onclick = () => {
    const next: Theme = effective() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute('data-theme', next);
    sync();
  };
}
