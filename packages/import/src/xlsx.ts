// A small XLSX reader, from Finance's import: the first worksheet as rows of
// strings. Shared and inline strings, numbers, booleans, and date-formatted
// cells (as ISO dates). No dependencies.
import { inflateRawSync } from 'node:zlib';

/** The most one workbook part may unpack to, so a small file cannot fill the memory. */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

function unzip(data: Buffer): Map<string, () => Buffer> {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i -= 1) {
    if (data.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('The file is not a readable XLSX workbook.');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  if (offset === 0xffffffff) throw new Error('Large ZIP64 workbooks are not supported. Save the sheet as CSV.');
  const entries = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('The workbook archive is damaged.');
    const method = data.readUInt16LE(offset + 10);
    const size = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name.replace(/^\/+/, ''), () => {
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      const body = data.subarray(start, start + size);
      if (method === 0) return body;
      if (method === 8) {
        try {
          return inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError)
            throw new Error(`The workbook part ${name} unpacks to more than 512 MB. Save the sheet as CSV.`);
          throw new Error('The workbook archive is damaged.');
        }
      }
      throw new Error('The workbook uses an unsupported compression method.');
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? '');
}
const textOf = (xml: string | undefined) => unescapeXml([...(xml ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? '').join(''));
const attr = (attrs: string | undefined, name: string) => attrs?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

function dateStyles(styles: string | undefined): Set<number> {
  const result = new Set<number>();
  if (!styles) return result;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b([^>]*)\/?>/g)) custom.set(Number(attr(m[1], 'numFmtId')), unescapeXml(attr(m[1], 'formatCode') ?? ''));
  const builtIn = (id: number) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58);
  const isDate = (id: number) => {
    const code = custom.get(id);
    if (code === undefined) return builtIn(id);
    return /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
  };
  const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  [...xfs.matchAll(/<xf\b([^>]*)/g)].forEach((m, index) => { if (isDate(Number(attr(m[1], 'numFmtId') ?? 0))) result.add(index); });
  return result;
}

function serialToIso(serial: number, date1904: boolean): string {
  const ms = Math.round((serial - (date1904 ? 24107 : 25569)) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return ms % 86_400_000 === 0 ? iso.slice(0, 10) : iso.slice(0, 19);
}

function columnIndex(ref: string): number {
  let index = 0;
  for (const ch of ref.match(/^[A-Z]+/)?.[0] ?? '') index = index * 26 + ch.charCodeAt(0) - 64;
  return index - 1;
}

export function isXlsx(data: Buffer): boolean {
  return data.length > 4 && data.readUInt32LE(0) === 0x04034b50;
}

export function readXlsx(data: Buffer): string[][] {
  const files = unzip(data);
  const read = (name: string) => files.get(name)?.().toString('utf8');
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('The file is not a readable XLSX workbook.');
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);
  const firstSheet = workbook.match(/<sheet\b([^>]*)\/?>/)?.[1] ?? '';
  const relId = attr(firstSheet, 'r:id');
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  const target = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1]).find((r) => attr(r, 'Id') === relId);
  let path = target ? attr(target, 'Target')! : 'worksheets/sheet1.xml';
  path = path.startsWith('/') ? path.slice(1) : `xl/${path}`;
  const sheet = read(path);
  if (!sheet) throw new Error('The workbook has no worksheet.');
  const strings = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const dates = dateStyles(read('xl/styles.xml'));
  const rows: string[][] = [];
  for (const row of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const values: string[] = [];
    const rowNumber = Number(attr(row[1], 'r') ?? rows.length + 1);
    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1], body = cell[2] ?? '';
      const ref = attr(attrs, 'r');
      const index = ref ? columnIndex(ref) : values.length;
      const type = attr(attrs, 't') ?? 'n';
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = raw === undefined ? '' : strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = unescapeXml(raw ?? '');
      else if (raw !== undefined && raw !== '') {
        const number = Number(raw);
        value = dates.has(Number(attr(attrs, 's') ?? 0)) && Number.isFinite(number) ? serialToIso(number, date1904) : String(number);
      }
      while (values.length < index) values.push('');
      values[index] = value;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(values);
  }
  return rows;
}
