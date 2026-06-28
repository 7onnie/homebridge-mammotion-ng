interface Entry {
  committed: boolean;
  pending: boolean | null;
  pendingSince: number;
}

export class Debouncer {
  private readonly entries = new Map<string, Entry>();

  /** Returns the committed value after applying this observation. */
  push(key: string, value: boolean, dwellMs: number, now: number): boolean {
    const e = this.entries.get(key);
    if (e === undefined) {
      this.entries.set(key, { committed: value, pending: null, pendingSince: now });
      return value;
    }
    if (value === e.committed) {
      e.pending = null; // observation matches committed -> cancel any pending change
      return e.committed;
    }
    // value differs from committed
    if (e.pending !== value) {
      e.pending = value;
      e.pendingSince = now;
    }
    if (now - e.pendingSince >= dwellMs) {
      e.committed = value;
      e.pending = null;
      return value;
    }
    return e.committed;
  }
}
