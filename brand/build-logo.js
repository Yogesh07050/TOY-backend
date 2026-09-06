'use strict';

/**
 * Generates every OffersOffer brand asset from one source of truth.
 *
 * Two SVGs come out of here:
 *
 *   logo-mark.svg    flat, for the UI and the favicon. A drop shadow and a
 *                    gloss sheen turn to mush below about 48px, so the places
 *                    that render small get a version without them.
 *   logo-mark-3d.svg the reference artwork's glossy treatment, for the app
 *                    icon, the splash screen and the email header - all of
 *                    which are seen large.
 *
 * Everything downstream (PNGs for web, email, iOS and Android) is rasterised
 * from those two, so the mark can never drift between platforms.
 */

const fs = require('node:fs');
const path = require('node:path');
/**
 * This script runs from two places: the repo root, which has no node_modules,
 * and its own copy inside TOY-backend, where sharp is a declared dependency.
 * Resolve it normally first and fall back to the API's tree, so neither copy
 * needs a path pinned to one machine.
 */
const sharp = (() => {
  try {
    return require('sharp');
  } catch {
    return require(path.join(__dirname, '..', 'TOY-backend', 'node_modules', 'sharp'));
  }
})();

const { STROKE, VIEW, inkPath, goldPath } = require('./geometry');

const OUT = __dirname;

// ---------------------------------------------------------------------------
// Palette, sampled from the reference artwork
// ---------------------------------------------------------------------------

const GOLD = ['#FFD64F', '#F9B417', '#EF8F00'];
const INK = ['#3B3B3E', '#232326', '#151517'];
/** The warm cream the mark sits on - app icon, splash and email header. */
const CREAM = '#FBEDC8';

// The rings cross twice on the vertical line midway between their centres.
// Re-drawing the ink ring clipped to the upper crossing is what makes the two
// interlock rather than one simply sitting on top of the other.
const CROSS = { x: 225, y: 0, width: 110, height: 123 };

const gradients = `
    <linearGradient id="oo-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${GOLD[0]}"/>
      <stop offset="0.5" stop-color="${GOLD[1]}"/>
      <stop offset="1" stop-color="${GOLD[2]}"/>
    </linearGradient>
    <linearGradient id="oo-ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${INK[0]}"/>
      <stop offset="0.55" stop-color="${INK[1]}"/>
      <stop offset="1" stop-color="${INK[2]}"/>
    </linearGradient>`;

/** The interlocking rings. `extra` is stamped over each ring for the gloss. */
const rings = (extra = '') => `
  <g fill="none" stroke-width="${STROKE}" stroke-linecap="butt">
    <path d="${inkPath}" stroke="url(#oo-ink)"/>${extra ? extra.replace(/%PATH%/g, inkPath) : ''}
    <path d="${goldPath}" stroke="url(#oo-gold)"/>${extra ? extra.replace(/%PATH%/g, goldPath) : ''}
    <g clip-path="url(#oo-cross)">
      <path d="${inkPath}" stroke="url(#oo-ink)"/>${extra ? extra.replace(/%PATH%/g, inkPath) : ''}
    </g>
  </g>`;

const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW.width} ${VIEW.height}" role="img" aria-label="OffersOffer">
  <title>OffersOffer</title>`;

const clip = `
    <clipPath id="oo-cross">
      <rect x="${CROSS.x}" y="${CROSS.y}" width="${CROSS.width}" height="${CROSS.height}"/>
    </clipPath>`;

// ---------------------------------------------------------------------------
// Flat mark
// ---------------------------------------------------------------------------

const flat = `${svgOpen}
  <defs>${gradients}${clip}
  </defs>
${rings()}
</svg>
`;

// ---------------------------------------------------------------------------
// Glossy mark
//
// The sheen is a second, narrower stroke laid over the band with a gradient
// that runs white at the top-left to transparent by the middle - the same
// direction the colour gradients run, so the two agree about where the light
// is. A soft drop shadow lifts the whole mark off the cream.
// ---------------------------------------------------------------------------

const gloss = `${svgOpen}
  <defs>${gradients}${clip}
    <linearGradient id="oo-sheen" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.30"/>
      <stop offset="0.35" stop-color="#FFFFFF" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="oo-shadow" x="-15%" y="-15%" width="130%" height="140%">
      <feDropShadow dx="0" dy="7" stdDeviation="9" flood-color="#8A6A1F" flood-opacity="0.35"/>
    </filter>
  </defs>
  <g filter="url(#oo-shadow)">
${rings(`
    <path d="%PATH%" stroke="url(#oo-sheen)" stroke-width="${Math.round(STROKE * 0.5)}"/>`)}
  </g>
</svg>
`;

fs.writeFileSync(path.join(OUT, 'logo-mark.svg'), flat);
fs.writeFileSync(path.join(OUT, 'logo-mark-3d.svg'), gloss);

// A flat single-colour silhouette. Android's themed icons and notification
// icons both discard colour and keep only the alpha channel, so anything with
// a gradient in it arrives as a solid blob.
const silhouette = (colour) => `${svgOpen}
  <defs>${clip}
  </defs>
  <g fill="none" stroke="${colour}" stroke-width="${STROKE}" stroke-linecap="butt">
    <path d="${inkPath}"/>
    <path d="${goldPath}"/>
  </g>
</svg>
`;

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

const REPO = path.resolve(OUT, '..');
const WEB = path.join(REPO, 'TOY-frontend/public');
const API = path.join(REPO, 'TOY-backend');
const APP = path.join(REPO, 'TOY-mobile-frontend/TOY-mobile-frontend/assets');

/**
 * Renders `svg` onto a square canvas.
 *
 * `pad` is the fraction of the side left as margin. Android's adaptive icons
 * need a generous one: only the middle ~66% of the foreground layer survives
 * the mask on a round launcher, so anything closer to the edge gets cropped.
 */
async function square(svg, size, { background, pad = 0.12, out }) {
  const inner = Math.round(size * (1 - pad * 2));
  const mark = await sharp(Buffer.from(svg), { density: 600 })
    .resize({ width: inner, height: inner, fit: 'inside' })
    .png()
    .toBuffer();

  let canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  return canvas
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toFile(out);
}

/** Renders `svg` at a fixed width, keeping its own aspect ratio. */
const wide = (svg, width, { background, out }) => {
  const pipeline = sharp(Buffer.from(svg), { density: 600 }).resize({ width });
  return (background ? pipeline.flatten({ background }) : pipeline).png().toFile(out);
};

async function build() {
  // ---- Web -----------------------------------------------------------------
  fs.writeFileSync(path.join(WEB, 'logo.svg'), flat);

  // Browser tabs and the iOS home screen composite the icon onto their own
  // chrome, so these carry the cream with them rather than going transparent.
  await square(flat, 32, { background: CREAM, pad: 0.05, out: path.join(WEB, 'icon-32.png') });
  await square(flat, 180, { background: CREAM, pad: 0.09, out: path.join(WEB, 'icon-180.png') });
  await square(gloss, 512, { background: CREAM, pad: 0.09, out: path.join(WEB, 'icon-512.png') });

  // ---- Email ---------------------------------------------------------------
  // Flattened onto the cream: a transparent PNG turns invisible in a client
  // that renders the message on a dark background.
  await wide(gloss, 480, { background: CREAM, out: path.join(API, 'assets/logo-email.png') });
  await wide(gloss, 960, { background: CREAM, out: path.join(OUT, 'logo-email@2x.png') });

  // ---- Mobile --------------------------------------------------------------
  await square(gloss, 1024, { background: CREAM, pad: 0.09, out: path.join(APP, 'icon.png') });
  await square(flat, 48, { background: CREAM, pad: 0.05, out: path.join(APP, 'favicon.png') });

  // The splash mark sits on the cream the plugin paints, so it stays
  // transparent and is centred by expo-splash-screen itself.
  await wide(gloss, 900, { out: path.join(APP, 'splash-icon.png') });

  // In-app header mark. Transparent, because it sits on whatever the screen
  // behind it is painted - cream in light mode, near-black in dark - and a
  // baked-in background would show as a pale rectangle on one of them.
  //
  // `wide` rather than `square`: the mark is 146x94, so a square canvas would
  // letterbox it and leave the header's leading edge padded with nothing.
  // 192px carries a ~28pt header on a 3x screen with room to spare.
  await wide(gloss, 192, { out: path.join(APP, 'logo-header.png') });

  // Android adaptive icon: a solid cream plate plus a foreground kept well
  // inside the mask's safe zone. The blue plate this replaces was the one
  // Expo ships in its template.
  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: CREAM },
  })
    .png()
    .toFile(path.join(APP, 'android-icon-background.png'));
  await square(gloss, 1024, { pad: 0.18, out: path.join(APP, 'android-icon-foreground.png') });
  await square(silhouette('#000000'), 1024, {
    pad: 0.18,
    out: path.join(APP, 'android-icon-monochrome.png'),
  });

  // Android strips colour from notification icons and keeps the alpha, so this
  // is drawn white-on-transparent to survive that.
  await square(silhouette('#FFFFFF'), 512, {
    pad: 0.2,
    out: path.join(APP, 'notification-icon.png'),
  });

  // ---- Keep the API's copy of the source in step -----------------------------
  fs.writeFileSync(path.join(API, 'brand/logo-mark.svg'), flat);
  fs.copyFileSync(path.join(OUT, 'geometry.js'), path.join(API, 'brand/geometry.js'));
  fs.copyFileSync(path.join(OUT, 'build-logo.js'), path.join(API, 'brand/build-logo.js'));

  await square(gloss, 512, { background: CREAM, pad: 0.14, out: path.join(OUT, 'icon-512.png') });
  await square(flat, 192, { background: CREAM, pad: 0.12, out: path.join(OUT, 'logo-mark-192.png') });
  await square(gloss, 512, { background: CREAM, pad: 0.14, out: path.join(OUT, 'logo-mark-512.png') });

  console.log('brand assets rebuilt');
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { CREAM, flat, gloss, silhouette };
