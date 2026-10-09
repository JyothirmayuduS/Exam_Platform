// In-memory stand-in for the supabase-js query builder, for tests. Like
// PostgREST it returns at most `maxRows` rows per request, so a read that
// doesn't page loses rows here exactly as it would in production. Paging
// without an order is refused: page boundaries would be unstable.
// deno-lint-ignore-file no-explicit-any
export type Row = Record<string, any>;

type Filter = (r: Row) => boolean;

const valueOf = (r: Row, col: string) => {
  const [base, key] = col.split("->>");
  const v = r[base.trim()];
  if (key === undefined) return v;
  const inner = v && typeof v === "object" ? v[key.trim()] : undefined;
  return inner === undefined || inner === null ? null : String(inner);
};

function likeToRegex(pattern: string, flags: string): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) src += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "%") src += ".*";
    else if (c === "_") src += ".";
    else src += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, flags);
}

export function fakeSupabase(tables: Record<string, Row[]>, opts: { maxRows?: number; rpc?: Record<string, (args: any) => any> } = {}) {
  const maxRows = opts.maxRows ?? 1000;
  const requests: { table: string; op: string; rows: number }[] = [];

  class Query {
    private filters: Filter[] = [];
    private orders: { col: string; asc: boolean; nullsFirst: boolean }[] = [];
    private from_: number | null = null;
    private to_: number | null = null;
    private limit_: number | null = null;
    private op: "select" | "insert" | "update" | "delete" = "select";
    private payload: any = null;
    private returning = false;
    private head = false;
    private count: string | null = null;
    private single: "maybe" | "one" | null = null;

    constructor(private table: string) {}

    select(_cols?: string, o?: { count?: string; head?: boolean }) {
      if (this.op !== "select") this.returning = true;
      if (o?.head) this.head = true;
      if (o?.count) this.count = o.count;
      return this;
    }
    insert(rows: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows: Row | Row[]) { return this.insert(rows); }
    update(values: Row, o?: { count?: string }) { this.op = "update"; this.payload = values; if (o?.count) this.count = o.count; return this; }
    delete() { this.op = "delete"; return this; }

    eq(c: string, v: unknown) { this.filters.push((r) => valueOf(r, c) === v); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => valueOf(r, c) !== v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(valueOf(r, c))); return this; }
    gte(c: string, v: any) { this.filters.push((r) => valueOf(r, c) !== null && valueOf(r, c) >= v); return this; }
    gt(c: string, v: any) { this.filters.push((r) => valueOf(r, c) !== null && valueOf(r, c) > v); return this; }
    lte(c: string, v: any) { this.filters.push((r) => valueOf(r, c) !== null && valueOf(r, c) <= v); return this; }
    lt(c: string, v: any) { this.filters.push((r) => valueOf(r, c) !== null && valueOf(r, c) < v); return this; }
    is(c: string, v: null) { this.filters.push((r) => (valueOf(r, c) ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) {
      if (op !== "is") throw new Error(`fake: not.${op} unsupported`);
      this.filters.push((r) => (valueOf(r, c) ?? null) !== v);
      return this;
    }
    like(c: string, p: string) { const re = likeToRegex(p, ""); this.filters.push((r) => re.test(String(valueOf(r, c) ?? ""))); return this; }
    ilike(c: string, p: string) { const re = likeToRegex(p, "i"); this.filters.push((r) => re.test(String(valueOf(r, c) ?? ""))); return this; }
    or(_expr: string) { return this; }
    order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
      const asc = o?.ascending ?? true;
      this.orders.push({ col, asc, nullsFirst: o?.nullsFirst ?? !asc });
      return this;
    }
    range(from: number, to: number) { this.from_ = from; this.to_ = to; return this; }
    limit(n: number) { this.limit_ = n; return this; }
    maybeSingle() { this.single = "maybe"; return this; }

    private matching(): Row[] {
      return (tables[this.table] ??= []).filter((r) => this.filters.every((f) => f(r)));
    }

    private run(): { data: any; error: { message: string } | null; count?: number | null } {
      if (this.op === "insert") {
        (tables[this.table] ??= []).push(...this.payload.map((r: Row) => ({ ...r })));
        return { data: this.returning ? this.payload : null, error: null };
      }
      if (this.op === "update") {
        const hit = this.matching();
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: this.returning ? hit.slice(0, maxRows) : null, error: null, count: this.count ? hit.length : null };
      }
      if (this.op === "delete") {
        const hit = new Set(this.matching());
        tables[this.table] = tables[this.table].filter((r) => !hit.has(r));
        return { data: this.returning ? [...hit].slice(0, maxRows) : null, error: null };
      }
      if (this.from_ !== null && this.orders.length === 0) return { data: null, error: { message: `fake: ${this.table} paged without an order` } };
      const rows = this.matching().slice().sort((a, b) => {
        for (const o of this.orders) {
          const x = valueOf(a, o.col), y = valueOf(b, o.col);
          if (x === y) continue;
          if (x === null || x === undefined) return o.nullsFirst ? -1 : 1;
          if (y === null || y === undefined) return o.nullsFirst ? 1 : -1;
          return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
        }
        return 0;
      });
      if (this.head) return { data: null, error: null, count: rows.length };
      const start = this.from_ ?? 0;
      let end = this.to_ !== null ? this.to_ + 1 : this.limit_ !== null ? start + this.limit_ : rows.length;
      end = Math.min(end, start + maxRows);
      const page = rows.slice(start, end);
      requests.push({ table: this.table, op: "select", rows: page.length });
      if (this.single) return { data: page[0] ?? null, error: null };
      return { data: page, error: null, count: this.count ? rows.length : null };
    }

    then<T>(resolve: (v: any) => T, reject?: (e: unknown) => T) {
      try { return Promise.resolve(this.run()).then(resolve, reject); } catch (e) { return reject ? Promise.resolve(reject(e)) : Promise.reject(e); }
    }
  }

  return {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: any) => {
      const fn = opts.rpc?.[name];
      return fn ? { data: await fn(args), error: null } : { data: null, error: { message: `fake: no rpc ${name}` } };
    },
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }), remove: async () => ({ data: null, error: null }) }) },
    requests,
    tables,
  };
}
