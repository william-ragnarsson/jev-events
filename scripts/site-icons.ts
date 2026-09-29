/**
 * Draws the site's icons from the mark in apps/web/lib/brand.ts:
 *   apps/web/app/icon.svg        the tab icon
 *   apps/web/app/favicon.ico     16, 32 and 48 px, for browsers and tools that only ask for /favicon.ico
 *   apps/web/app/apple-icon.png  180 px, since iOS rounds the corners itself
 *
 * Run `npm run site:icons` after changing the mark; a test fails when icon.svg is stale. It draws
 * with sharp, which Next.js installs.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { BRAND, markSvg } from "../apps/web/lib/brand.js";

const APP = fileURLToPath(new URL("../apps/web/app/", import.meta.url));

/** Rasterizes the 32-unit SVG straight at `size`, so the line keeps to the pixel grid. */
function png(svg: string, size: number) {
  return sharp(Buffer.from(svg), { density: (72 * size) / 32 }).resize(size, size);
}

/** An .ico of PNG images, which every current browser and Windows reads. */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    directory.writeUInt8(size, entry);
    directory.writeUInt8(size, entry + 1);
    directory.writeUInt16LE(1, entry + 4); // color planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...images.map((image) => image.data)]);
}

const svg = markSvg();
writeFileSync(`${APP}icon.svg`, svg);

const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(async (size) => ({ size, data: await png(svg, size).png().toBuffer() })));
writeFileSync(`${APP}favicon.ico`, ico(images));

// Without an alpha channel, which iOS would fill with black.
await png(svg, 180).flatten({ background: BRAND.field }).png().toFile(`${APP}apple-icon.png`);

process.stdout.write("wrote apps/web/app/icon.svg, favicon.ico and apple-icon.png\n");
