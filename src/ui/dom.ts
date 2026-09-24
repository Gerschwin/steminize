export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { class?: string; style?: string; [k: `data-${string}`]: string } = {},
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

export const fmtMB = (b: number) => (b >= 1e9 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

export const pressed = (el: Element, on: boolean) => el.setAttribute('aria-pressed', String(on));

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
