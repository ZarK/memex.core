/** The icon sizes an app ships: PNGs for Linux, icon.ico for Windows, icon.icns for macOS. */
export const ICON_SIZES = [16, 32, 48, 64, 128, 256, 512] as const;
export const ICO_SIZES = [16, 32, 48, 256] as const;

function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG.");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** An .ico file with PNG images (Windows Vista and later read PNG entries). */
export function buildIco(pngs: Buffer[]): Buffer {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const parts: Buffer[] = [header];
  let offset = header.length;
  pngs.forEach((png, index) => {
    const { width, height } = pngSize(png);
    const entry = 6 + index * 16;
    header.writeUInt8(width >= 256 ? 0 : width, entry);
    header.writeUInt8(height >= 256 ? 0 : height, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    parts.push(png);
    offset += png.length;
  });
  return Buffer.concat(parts);
}

/** An .icns file with PNG images: ic07 (128), ic08 (256), ic09 (512). */
export function buildIcns(icons: Record<"ic07" | "ic08" | "ic09", Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const [type, png] of Object.entries(icons)) {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(8 + png.length, 4);
    chunks.push(header, png);
  }
  const body = Buffer.concat(chunks);
  const file = Buffer.alloc(8 + body.length);
  file.write("icns", 0, 4, "ascii");
  file.writeUInt32BE(file.length, 4);
  body.copy(file, 8);
  return file;
}
