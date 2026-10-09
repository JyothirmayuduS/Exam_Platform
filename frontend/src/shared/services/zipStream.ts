// Streaming ZIP writer for evidence exports.
//
// Entries are stored (JPEG, WebM and PDF are already compressed) and written
// as they arrive, with sizes in a trailing data descriptor, so a file never
// has to be fully in memory. ZIP64 records are added when the archive passes
// 4 GB or 65,535 entries, which a full class of two-hour recordings does.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc: number, data: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX32 = 0xffffffff;

class Bytes {
  private a: number[] = [];
  u16(v: number) { this.a.push(v & 0xff, (v >>> 8) & 0xff); return this; }
  u32(v: number) { this.a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  u64(v: number) { this.u32(v % 2 ** 32); this.u32(Math.floor(v / 2 ** 32)); return this; }
  raw(b: Uint8Array) { for (const x of b) this.a.push(x); return this; }
  done() { return new Uint8Array(this.a); }
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

type Entry = { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number };

export type ZipEntryWriter = {
  write: (chunk: Uint8Array) => Promise<void>;
  end: () => Promise<void>;
};

export class ZipWriter {
  private offset = 0;
  private entries: Entry[] = [];
  private open = false;
  private readonly sink: (chunk: Uint8Array) => Promise<void>;
  private readonly opts: { forceZip64?: boolean };

  constructor(sink: (chunk: Uint8Array) => Promise<void>, opts: { forceZip64?: boolean } = {}) {
    this.sink = sink;
    this.opts = opts;
  }

  private async out(chunk: Uint8Array) {
    if (chunk.length === 0) return;
    this.offset += chunk.length;
    await this.sink(chunk);
  }

  /** Start an entry; write its bytes in any number of chunks, then end(). */
  async begin(path: string, when = new Date()): Promise<ZipEntryWriter> {
    if (this.open) throw new Error("Previous zip entry is still open");
    this.open = true;
    const name = new TextEncoder().encode(path);
    const { time, date } = dosTime(when);
    const entry: Entry = { name, crc: 0, size: 0, offset: this.offset, time, date };
    await this.out(new Bytes()
      .u32(0x04034b50).u16(20).u16(0x0808).u16(0).u16(time).u16(date)
      .u32(0).u32(0).u32(0).u16(name.length).u16(0).raw(name).done());
    return {
      write: async (chunk) => {
        entry.crc = crc32(entry.crc, chunk);
        entry.size += chunk.length;
        await this.out(chunk);
      },
      end: async () => {
        if (entry.size >= MAX32) throw new Error(`${path} is larger than 4 GB`);
        await this.out(new Bytes().u32(0x08074b50).u32(entry.crc).u32(entry.size).u32(entry.size).done());
        this.entries.push(entry);
        this.open = false;
      },
    };
  }

  async add(path: string, data: Uint8Array, when?: Date): Promise<void> {
    const e = await this.begin(path, when);
    await e.write(data);
    await e.end();
  }

  get entryCount(): number { return this.entries.length; }

  /** Write the central directory. */
  async finish(): Promise<void> {
    if (this.open) throw new Error("A zip entry is still open");
    const force = !!this.opts.forceZip64;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const big = force || e.offset >= MAX32;
      const extra = big ? new Bytes().u16(0x0001).u16(8).u64(e.offset).done() : new Uint8Array(0);
      await this.out(new Bytes()
        .u32(0x02014b50).u16(big ? 45 : 20).u16(big ? 45 : 20).u16(0x0808).u16(0).u16(e.time).u16(e.date)
        .u32(e.crc).u32(e.size).u32(e.size).u16(e.name.length).u16(extra.length).u16(0)
        .u16(0).u16(0).u32(0).u32(big ? MAX32 : e.offset).raw(e.name).raw(extra).done());
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const zip64 = force || count >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const recordAt = this.offset;
      await this.out(new Bytes()
        .u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
        .u64(count).u64(count).u64(cdSize).u64(cdStart).done());
      await this.out(new Bytes().u32(0x07064b50).u32(0).u64(recordAt).u32(1).done());
    }
    await this.out(new Bytes()
      .u32(0x06054b50).u16(0).u16(0)
      .u16(zip64 ? 0xffff : count).u16(zip64 ? 0xffff : count)
      .u32(zip64 ? MAX32 : cdSize).u32(zip64 ? MAX32 : cdStart).u16(0).done());
  }
}

export type ByteSink = {
  write: (chunk: Uint8Array) => Promise<void>;
  /** Finish; the Blob sink returns the whole file. */
  close: () => Promise<Blob | void>;
  abort?: () => Promise<void>;
};

/**
 * Collect output as a Blob, moving bytes out of the JS heap every
 * `foldBytes`: the browser keeps Blob data outside the page's memory (on disk
 * when large), so the tab holds at most one fold of bytes at a time.
 */
export function createBlobSink(type: string, foldBytes = 8 * 1024 * 1024): ByteSink & { heldBytes: () => number } {
  const blobs: Blob[] = [];
  let pending: Uint8Array[] = [];
  let held = 0;
  const fold = () => {
    if (pending.length === 0) return;
    blobs.push(new Blob(pending as BlobPart[]));
    pending = [];
    held = 0;
  };
  return {
    write: async (chunk) => {
      pending.push(chunk);
      held += chunk.length;
      if (held >= foldBytes) fold();
    },
    close: async () => {
      fold();
      return new Blob(blobs, { type });
    },
    heldBytes: () => held,
  };
}
