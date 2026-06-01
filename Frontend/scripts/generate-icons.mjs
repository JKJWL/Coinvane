// SPDX-License-Identifier: AGPL-3.0-or-later
// Generate the PNG icons iOS / Android / Chrome need from the single
// favicon.svg source. Runs automatically before `vite build` via the
// `prebuild` npm script, so the icons in Frontend/public/ are always
// in sync with the SVG. No external tooling required at deploy time —
// `sharp` is a devDependency.
//
// Why this exists:
//   iOS Safari requires PNG for home-screen icons; an SVG-only icon
//   setup makes "Add to Home Screen" fall back to a generated initial-
//   letter avatar (the green "L"). Same story for the manifest's
//   icon-192 / icon-512 references that Android / desktop Chrome PWA
//   install uses. By generating these from the SVG at build time we
//   keep a single source of truth.
//
// Output:
//   public/apple-touch-icon.png       (180×180) — iOS home screen
//   public/icon-192.png               (192×192) — manifest "any"
//   public/icon-512.png               (512×512) — manifest "any"
//   public/icon-512-maskable.png      (512×512, 80% inset) — manifest
//                                       "maskable" so Android can apply
//                                       any adaptive-icon mask without
//                                       cropping the glyph.
//
// The generated PNGs are gitignored — they're build artifacts, not
// source. The SVG is the source of truth.

import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");
const SVG_PATH  = resolve(PUBLIC_DIR, "favicon.svg");

async function renderPng(svgBuffer, size, outPath, { inset = 0 } = {}) {
  if (inset === 0) {
    await sharp(svgBuffer, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    return;
  }
  // Maskable: render the glyph at (1 - 2*inset) of the canvas, on the
  // background color from the SVG's gradient (we sample the emerald
  // mid-tone so the safe area looks coherent if Android crops to a
  // circle). Per W3C maskable spec, the inner 80% must contain the
  // logo; outer 20% is safe-area padding the platform may clip.
  const inner = Math.round(size * (1 - inset * 2));
  const inset_px = Math.round(size * inset);
  const glyph = await sharp(svgBuffer, { density: 384 })
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size, height: size, channels: 4,
      background: { r: 0x10, g: 0xb9, b: 0x81, alpha: 1 }, // emerald-500
    },
  })
    .composite([{ input: glyph, top: inset_px, left: inset_px }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function main() {
  const svgBuffer = await readFile(SVG_PATH);
  await mkdir(PUBLIC_DIR, { recursive: true });

  const tasks = [
    { size: 180, file: "apple-touch-icon.png" },
    { size: 192, file: "icon-192.png"        },
    { size: 512, file: "icon-512.png"        },
    { size: 512, file: "icon-512-maskable.png", inset: 0.1 },
  ];

  for (const t of tasks) {
    const out = resolve(PUBLIC_DIR, t.file);
    await renderPng(svgBuffer, t.size, out, { inset: t.inset || 0 });
    console.log(`  ✓ ${t.file} (${t.size}×${t.size})`);
  }
  console.log("Icons generated.");
}

main().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
