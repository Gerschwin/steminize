export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { class?: string; style?: string; [k: `data-${string}` | `aria-${string}`]: string } = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v as string;
    else if (k === 'style') el.setAttribute('style', v as string);
    else if (k.startsWith('data-') || k.startsWith('aria-')) el.setAttribute(k, String(v));
    else (el as any)[k] = v;
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export function toast(msg: string, bad = false, ms = 4000) {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}` }, msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), bad ? ms * 2 : ms);
  return t;
}

export function fmtTime(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtEta(sec: number) {
  if (!isFinite(sec)) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s left`;
  return `${Math.round(sec / 60)} min left`;
}

/** 45s, 3m 12s, 1h 04m */
export function fmtDuration(sec: number) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}

export const fmtMB = (b: number) => (b >= 1e9 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

export const pressed = (el: Element, on: boolean) => el.setAttribute('aria-pressed', String(on));

/** Keeps a wheel/trackpad scroll over `el` from reaching whatever scrolls behind it — not just once
 * el's own content is scrolled to an edge (overscroll-behavior already covers that), but also when
 * el has nothing to scroll at all (too few items to overflow its own box), where there's no scroll
 * position for overscroll-behavior to "contain": the browser just hands the gesture straight to the
 * next scrollable ancestor. Swallows the tick instead, so scrolling over el never moves its parent;
 * only scrolling outside el's own bounds does. */
export function containScroll(el: HTMLElement) {
  el.addEventListener(
    'wheel',
    (e) => {
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
    },
    { passive: false },
  );
}

/**
 * showModal() traps focus and clicks on the backdrop, but not the mouse wheel: the page behind
 * a dialog can still scroll unless something locks it. Use this instead of calling showModal()
 * directly, and it stays locked correctly even if dialogs are ever opened over one another.
 */
export function openDialog(dlg: HTMLDialogElement) {
  document.body.classList.add('modal-open');
  dlg.showModal();
}
// 'close' doesn't bubble, so this needs capture phase to catch it via delegation on document.
document.addEventListener(
  'close',
  (e) => {
    if (e.target instanceof HTMLDialogElement && !document.querySelector('dialog[open]')) document.body.classList.remove('modal-open');
  },
  true,
);

/** Size a canvas to its CSS box at device resolution; returns the 2D context. */
export function fitCanvas(c: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const hgt = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== hgt) {
    c.width = w;
    c.height = hgt;
  }
  return c.getContext('2d')!;
}
