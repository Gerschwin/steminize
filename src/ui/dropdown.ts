// A `<select>`-alike that actually takes the app's theme, including its open list: browsers render
// a native <select>'s open popup with the OS's own widget, which mostly ignores page CSS (confirmed
// in both Chromium and WebKitGTK — plain white, regardless of theme). This draws the list itself.
//
// Deliberately narrow: no <optgroup>, no multi-select, no typeahead search. It's meant as a drop-in
// for the handful of plain single-choice selects that need to look right, not a replacement for
// native <select> everywhere.
import { h } from './dom.ts';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface Dropdown {
  el: HTMLElement;
  value: string;
  disabled: boolean;
  setOptions(options: DropdownOption[]): void;
  onChange: (value: string) => void;
}

/** The currently open dropdown, if any — only one open at a time, like a native select. */
let openDropdown: { close: () => void } | null = null;

export function createDropdown(initial: DropdownOption[] = []): Dropdown {
  let options = initial;
  let value = initial[0]?.value ?? '';
  let disabled = false;
  let onChange: (value: string) => void = () => {};
  let highlighted = 0;

  // The chevron is static markup (no user data in it), so it's simplest as innerHTML: h() builds
  // elements via document.createElement, which can't produce SVG (it needs the SVG namespace).
  const btn = h('button', { type: 'button', class: 'dd-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }) as HTMLButtonElement;
  btn.innerHTML = '<span class="dd-label"></span><svg class="dd-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const list = h('ul', { class: 'dd-list', role: 'listbox', hidden: true, tabIndex: -1 }) as HTMLUListElement;
  const root = h('div', { class: 'dd' }, btn, list);

  const label = () => btn.querySelector('.dd-label') as HTMLSpanElement;

  function close() {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (openDropdown?.close === close) openDropdown = null;
  }

  function renderList() {
    list.replaceChildren(
      ...options.map((o, i) => {
        const li = h('li', { role: 'option', 'aria-selected': String(o.value === value), 'aria-disabled': String(!!o.disabled), class: `dd-opt${o.disabled ? ' disabled' : ''}${i === highlighted ? ' hl' : ''}` }, o.label);
        li.onmousedown = (e) => e.preventDefault(); // keep focus on the button; a click shouldn't blur it before 'click' fires
        li.onclick = () => {
          if (o.disabled) return;
          select(o.value, true);
          close();
        };
        li.onmouseenter = () => {
          highlighted = i;
          for (const c of list.children) c.classList.remove('hl');
          li.classList.add('hl');
        };
        return li;
      }),
    );
  }

  function select(v: string, fromUser: boolean) {
    if (value === v) return;
    value = v;
    label().textContent = options.find((o) => o.value === v)?.label ?? '';
    if (fromUser) onChange(v);
  }

  function open() {
    if (disabled || !options.length) return;
    openDropdown?.close();
    highlighted = Math.max(0, options.findIndex((o) => o.value === value));
    renderList();
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openDropdown = { close };
    // Flip above the button if there's not enough room below (the setlist card can be near the
    // bottom of a short window), same as a native select would.
    const r = btn.getBoundingClientRect();
    const below = innerHeight - r.bottom;
    list.classList.toggle('dd-up', below < 200 && r.top > below);
  }

  btn.onclick = () => (list.hidden ? open() : close());
  btn.onblur = (e) => {
    // Losing focus to one of our own options doesn't count as leaving.
    if (!(e.relatedTarget instanceof Node) || !list.contains(e.relatedTarget)) close();
  };
  btn.onkeydown = (e) => {
    if (disabled) return;
    if (list.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      for (let i = 0; i < options.length; i++) {
        highlighted = (highlighted + dir + options.length) % options.length;
        if (!options[highlighted].disabled) break;
      }
      renderList();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[highlighted];
      if (o && !o.disabled) {
        select(o.value, true);
        close();
      }
    }
  };
  document.addEventListener('pointerdown', (e) => {
    if (!list.hidden && !root.contains(e.target as Node)) close();
  });

  return {
    el: root,
    get value() {
      return value;
    },
    set value(v: string) {
      select(v, false);
    },
    get disabled() {
      return disabled;
    },
    set disabled(v: boolean) {
      disabled = v;
      btn.disabled = v;
      if (v) close();
    },
    setOptions(next: DropdownOption[]) {
      options = next;
      if (!options.some((o) => o.value === value)) value = options[0]?.value ?? '';
      label().textContent = options.find((o) => o.value === value)?.label ?? '';
      if (!list.hidden) renderList();
    },
    set onChange(fn: (value: string) => void) {
      onChange = fn;
    },
  };
}
