import fs from "node:fs";
import path from "node:path";
import { deflateRawSync, deflateSync, brotliCompressSync } from "node:zlib";

// Every fixture is synthetic and made at run time.

export const MIT_TEXT = (holder: string) => `MIT License

Copyright (c) 2024 ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
`;

export const BSD3_TEXT = `Copyright (c) 2020, Example Maps

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:
* Redistributions of source code must retain the above copyright notice.
* Neither the name of the copyright holder nor the names of its contributors may
  be used to endorse or promote products derived from this software.
`;

export const GPL3_TEXT = `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
Copyright (C) 2007 Free Software Foundation, Inc.
`;

export function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function writeJson(file: string, value: unknown): void {
  write(file, JSON.stringify(value, null, 2));
}

/** An npm package folder with package.json and, optionally, a LICENSE file. */
export function npmPackage(dir: string, pkg: Record<string, unknown>, license?: string): void {
  writeJson(path.join(dir, "package.json"), pkg);
  if (license !== undefined) write(path.join(dir, "LICENSE"), license);
}

/** A name table with the given records (platform 3, encoding 1, English). */
function nameTableBytes(names: Record<number, string>): Buffer {
  const entries = Object.entries(names).map(([id, value]) => {
    const le = Buffer.from(value, "utf16le");
    le.swap16();
    return { id: Number(id), data: le };
  });
  const header = Buffer.alloc(6 + entries.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(entries.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  entries.forEach((e, i) => {
    const p = 6 + i * 12;
    header.writeUInt16BE(3, p);
    header.writeUInt16BE(1, p + 2);
    header.writeUInt16BE(0x409, p + 4);
    header.writeUInt16BE(e.id, p + 6);
    header.writeUInt16BE(e.data.length, p + 8);
    header.writeUInt16BE(offset, p + 10);
    offset += e.data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

/** A TrueType font that holds only a name table. Enough for the name reader. */
export function ttfWithNames(names: Record<number, string>): Buffer {
  const table = nameTableBytes(names);
  const head = Buffer.alloc(12 + 16);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(1, 4);
  head.write("name", 12, "latin1");
  head.writeUInt32BE(0, 16);
  head.writeUInt32BE(28, 20);
  head.writeUInt32BE(table.length, 24);
  return Buffer.concat([head, table]);
}

/** A WOFF font that holds only a zlib-compressed name table. */
export function woffWithNames(names: Record<number, string>): Buffer {
  const table = nameTableBytes(names);
  const comp = deflateSync(table);
  const header = Buffer.alloc(44 + 20);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(1, 12);
  header.write("name", 44, "latin1");
  header.writeUInt32BE(64, 48);
  header.writeUInt32BE(comp.length, 52);
  header.writeUInt32BE(table.length, 56);
  return Buffer.concat([header, comp]);
}

/** A WOFF2 font with a dummy cmap table and a name table, both untransformed. */
export function woff2WithNames(names: Record<number, string>): Buffer {
  const table = nameTableBytes(names);
  const cmap = Buffer.from([0, 0, 0, 0]);
  const stream = brotliCompressSync(Buffer.concat([cmap, table]));
  const base128 = (n: number) => {
    const bytes: number[] = [];
    do {
      bytes.unshift(n & 0x7f);
      n = Math.floor(n / 128);
    } while (n > 0);
    return bytes.map((b, i) => (i < bytes.length - 1 ? b | 0x80 : b));
  };
  const dir = Buffer.from([0x00, ...base128(cmap.length), 0x05, ...base128(table.length)]);
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(2, 12);
  header.writeUInt32BE(stream.length, 20);
  return Buffer.concat([header, dir, stream]);
}

/** A zip file with the given entries, the first one stored and the others deflated. */
export function zipOf(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(entries).forEach(([name, text], i) => {
    const raw = Buffer.from(text, "utf8");
    const method = i === 0 ? 0 : 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
