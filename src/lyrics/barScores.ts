// Per-bar accuracy for the playing trainer: how well each bar of the tab was played the last time it came round, shown as a
// heat colour behind the bar's number so the bars that need work stand out. The deck feeds in each judged note group as it ends;
// this holds the logic that has no need of a browser.

/** Bar index (counting through the whole tab from 0) -> [notes hit, notes judged] the last time that bar was played. */
export type BarScores = Record<string, [number, number]>;

/** A bar's worth of consecutive judged note groups: one "visit" to the bar. */
export interface BarVisit {
  bar: number;
  hit: number;
  total: number;
}

/**
 * Collects judged note groups into per-bar visits. A visit ends when playing moves on to a different bar, and the finished visit
 * replaces that bar's earlier result, so the colours show the latest attempt and improve as you do.
 */
export class BarTally {
  private visit: BarVisit | null = null;

  /** A note group in `bar` has been judged. Returns the previous bar's finished visit if this one starts a new bar. */
  group(bar: number, hit: boolean): BarVisit | null {
    let done: BarVisit | null = null;
    if (this.visit && this.visit.bar !== bar) {
      done = this.visit;
      this.visit = null;
    }
    this.visit ??= { bar, hit: 0, total: 0 };
    this.visit.total++;
    if (hit) this.visit.hit++;
    return done;
  }

  /** Playing stopped, looped round or jumped: whatever bar was in progress is finished. */
  flush(): BarVisit | null {
    const v = this.visit;
    this.visit = null;
    return v;
  }
}

export function barPercent(hit: number, total: number): number {
  return total > 0 ? Math.round((100 * hit) / total) : 0;
}

/** Red for none right, through amber to green for all right. */
export function barColour(hit: number, total: number): string {
  const pct = total > 0 ? hit / total : 0;
  return `hsl(${Math.round(pct * 120)} 70% 52%)`;
}

export function barTip(bar: number, s: [number, number] | undefined): string {
  const base = `Bar ${bar + 1}: click to loop it · Shift-click to extend the loop to here`;
  return s && s[1] > 0 ? `${base}\nLast time: ${s[0]} of ${s[1]} notes (${barPercent(s[0], s[1])}%)` : base;
}
