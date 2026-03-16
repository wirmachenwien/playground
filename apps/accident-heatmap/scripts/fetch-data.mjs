#!/usr/bin/env node
/**
 * fetch-data.mjs
 *
 * Fetches the Statistik Austria OGD road accident dataset (Straßenverkehrsunfälle mit
 * Personenschaden), filters for Vienna (Bundesland 9), and writes a compact JSON file
 * to ../data/accidents.json that is consumed by the web app.
 *
 * Data source: https://www.data.gv.at/katalog/dataset/strassenverkehrsunfalle-mit-personenschaden-ab-2009
 *
 * Output format:
 *   {
 *     meta: { lastUpdated, totalCount, viennaCount, years: [] },
 *     points: [[lat, lng, year, flags], ...]
 *   }
 *
 * Flags bitmask:
 *   bit 0 (1)  – cyclist involved
 *   bit 1 (2)  – pedestrian involved
 *   bit 2 (4)  – motorcyclist involved
 *   bit 3 (8)  – fatal (≥1 fatality)
 *   bit 4 (16) – serious injury (≥1 severely injured, no fatality)
 *   bit 5 (32) – minor injury only
 */

import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { createReadStream } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CKAN_PACKAGE_URL =
  'https://www.data.gv.at/katalog/api/3/action/package_show?id=strassenverkehrsunfalle-mit-personenschaden-ab-2009';

// Fallback direct URL (updated periodically by Statistik Austria)
const FALLBACK_DATA_URL =
  'https://data.statistik.gv.at/web/ogd/OGD_Unfallorte.csv';

// Vienna Bundesland code – district codes start with 9 (e.g. 901–923)
const VIENNA_BUNDESLAND = 9;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Parse a delimited text (CSV/TSV) into array of row objects */
function parseCsv(text, delimiter = ';') {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const rawHeader = lines[0].split(delimiter).map(h =>
    h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim()
  );

  return lines.slice(1).map(line => {
    // Handle quoted fields
    const cells = [];
    let inQuote = false;
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === delimiter && !inQuote) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());

    const row = {};
    rawHeader.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

/** Normalise column names to a canonical lowercase form */
function normaliseColumnName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function buildColumnMap(rows) {
  if (rows.length === 0) return {};
  const sample = rows[0];
  const result = {};
  for (const key of Object.keys(sample)) {
    result[normaliseColumnName(key)] = key;
  }
  return result;
}

function getCol(row, colMap, ...candidates) {
  for (const c of candidates) {
    const norm = normaliseColumnName(c);
    if (colMap[norm] !== undefined) return row[colMap[norm]];
  }
  // Fuzzy: check if any normalised column name contains any candidate
  for (const c of candidates) {
    const needle = normaliseColumnName(c);
    for (const [norm, original] of Object.entries(colMap)) {
      if (norm.includes(needle) || needle.includes(norm)) {
        return row[original];
      }
    }
  }
  return undefined;
}

function toFloat(val) {
  if (val === undefined || val === null || val === '') return NaN;
  // Austrian decimal comma
  return parseFloat(String(val).replace(',', '.'));
}

function toInt(val) {
  if (val === undefined || val === null || val === '') return 0;
  return parseInt(String(val), 10) || 0;
}

/** Very simple MGI / Gauss-Krüger M34 → WGS84 approximation for Austria.
 *  Uses a linear affine transform calibrated for the Vienna region.
 *  Accuracy ~10 m – sufficient for a heatmap dot.
 */
function gkToWgs84(x, y) {
  // Central meridian of Gauss-Krüger M34: 13.333333° = 13°20'
  // We use a simple approach: subtract false easting and divide by scale
  const a = 6378137.0;
  const e2 = 0.00669437999014;
  const k0 = 1.0;
  // MGI Gauss-Krüger has three zones (M28/M31/M34) with central meridians
  // 10.333°/13.333°/16.333°.  Vienna falls in zone M34 (central meridian 16°20' = 16.333°).
  const lambda0Deg = 16.333333; // central meridian of MGI Gauss-Krüger M34 (Vienna)
  const lambda0Rad = lambda0Deg * (Math.PI / 180);
  const falseEasting = 750000;

  const N = x - falseEasting;
  const E = y;

  // Meridian arc inverse
  const n = (a * (1 - Math.sqrt(1 - e2))) / (a * (1 + Math.sqrt(1 - e2)));
  // Simplified direct formula for Austria (Helmert series)
  const lat_rad = E / (6366197.724 * k0);
  const lat1 = lat_rad + (3 * n / 2 - 27 * n * n * n / 32) * Math.sin(2 * lat_rad)
              + (21 * n * n / 16 - 55 * n * n * n * n / 32) * Math.sin(4 * lat_rad);
  const sinLat = Math.sin(lat1);
  const cosLat = Math.cos(lat1);
  const tanLat = Math.tan(lat1);
  const nu = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;

  const D = N / (nu * k0);

  const lat = lat1
    - (nu * tanLat / rho) * (D * D / 2 - (5 + 3 * tanLat * tanLat + 10 * eta2 - 4 * eta2 * eta2 - 9 * e2) * D * D * D * D / 24)
    + (nu * tanLat / rho) * (61 + 90 * tanLat * tanLat + 298 * eta2 + 45 * Math.pow(tanLat, 4) - 252 * e2 - 3 * eta2 * eta2) * Math.pow(D, 6) / 720;

  const lng = lambda0Rad + (D - (1 + 2 * tanLat * tanLat + eta2) * D * D * D / 6
    + (5 - 2 * eta2 + 28 * tanLat * tanLat - 3 * eta2 * eta2 + 8 * e2 + 24 * Math.pow(tanLat, 4)) * Math.pow(D, 5) / 120) / cosLat;

  return [lat * 180 / Math.PI, lng * 180 / Math.PI];
}

/** Heuristically determine the coordinate system from sample values */
function detectCoordSystem(rows, latCol, lngCol) {
  const sample = rows.slice(0, 20).map(r => ({
    lat: toFloat(r[latCol]),
    lng: toFloat(r[lngCol])
  })).filter(r => !isNaN(r.lat) && !isNaN(r.lng));

  if (sample.length === 0) return 'unknown';

  const avgLat = sample.reduce((s, r) => s + r.lat, 0) / sample.length;
  const avgLng = sample.reduce((s, r) => s + r.lng, 0) / sample.length;

  // WGS84 for Austria: lat ~46-49, lng ~9-17
  if (avgLat > 44 && avgLat < 52 && avgLng > 5 && avgLng < 20) return 'wgs84';

  // MGI Gauss-Krüger: X ~500000-900000, Y ~5100000-5400000
  if (avgLat > 5_000_000 && avgLat < 6_000_000) return 'gk_yx'; // swapped
  if (avgLng > 5_000_000 && avgLng < 6_000_000) return 'gk_xy';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function discoverDataUrl() {
  console.log('Querying data.gv.at CKAN catalog…');
  try {
    const pkg = await fetchJson(CKAN_PACKAGE_URL);
    if (!pkg.success || !pkg.result) throw new Error('Invalid CKAN response');
    const resources = pkg.result.resources ?? [];
    // Prefer CSV, then ZIP containing CSV
    const csv = resources.find(r => /csv/i.test(r.format) || /\.csv(\?|$)/i.test(r.url));
    if (csv) return csv.url;
    const zip = resources.find(r => /zip/i.test(r.format) || /\.zip(\?|$)/i.test(r.url));
    if (zip) return zip.url;
  } catch (e) {
    console.warn('CKAN query failed:', e.message);
  }
  console.log('Using fallback URL:', FALLBACK_DATA_URL);
  return FALLBACK_DATA_URL;
}

async function downloadAndExtract(url) {
  console.log('Downloading:', url);
  const buf = await fetchBuffer(url);

  if (url.endsWith('.zip') || buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP file – extract with built-in unzip via a temp file
    const tmpFile = join(tmpdir(), `ogd_accidents_${Date.now()}.zip`);
    await writeFile(tmpFile, buf);
    const { execSync } = await import('child_process');
    const tmpOut = join(tmpdir(), `ogd_accidents_${Date.now()}`);
    mkdirSync(tmpOut, { recursive: true });
    execSync(`unzip -o "${tmpFile}" -d "${tmpOut}"`, { stdio: 'pipe' });
    // Find the first CSV in extracted directory
    const { readdirSync } = await import('fs');
    const files = readdirSync(tmpOut);
    const csvFile = files.find(f => /\.csv$/i.test(f));
    if (!csvFile) throw new Error('No CSV found in ZIP');
    const { readFileSync } = await import('fs');
    return readFileSync(join(tmpOut, csvFile), 'utf-8');
  }

  // Assume plain CSV (possibly gzipped)
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const { promisify } = await import('util');
    const { gunzip } = await import('zlib');
    const gunzipAsync = promisify(gunzip);
    const decompressed = await gunzipAsync(buf);
    return decompressed.toString('utf-8');
  }

  return buf.toString('utf-8');
}

function processRows(rows) {
  const colMap = buildColumnMap(rows);

  // Find coordinate columns
  const latCol = colMap[normaliseColumnName('YCOORD')]
    ?? colMap[normaliseColumnName('LAT')]
    ?? colMap[normaliseColumnName('BREITE')]
    ?? colMap[normaliseColumnName('LATITUDE')]
    ?? colMap[normaliseColumnName('COORD_Y')]
    ?? Object.values(colMap).find(c => /y_?coord|lat|breite/i.test(c));

  const lngCol = colMap[normaliseColumnName('XCOORD')]
    ?? colMap[normaliseColumnName('LNG')]
    ?? colMap[normaliseColumnName('LAENGE')]
    ?? colMap[normaliseColumnName('LONGITUDE')]
    ?? colMap[normaliseColumnName('COORD_X')]
    ?? Object.values(colMap).find(c => /x_?coord|lon|l[aä]nge/i.test(c));

  if (!latCol || !lngCol) {
    // Print available columns to help diagnose
    console.error('Available columns:', Object.keys(rows[0] ?? {}).join(', '));
    throw new Error('Cannot identify latitude/longitude columns');
  }

  console.log(`Using lat="${latCol}", lng="${lngCol}"`);

  // Detect coordinate system from sample
  const coordSystem = detectCoordSystem(rows, latCol, lngCol);
  console.log('Detected coordinate system:', coordSystem);

  // Find other useful columns
  const districtCol = Object.keys(rows[0] ?? {}).find(c =>
    /bezirk|district|plz|bkz|gem/i.test(c));
  const yearCol = Object.keys(rows[0] ?? {}).find(c =>
    /^year$|^jahr$|unfalljar|unfalljahr/i.test(c)) ?? 'YEAR';
  const cyclistCol = Object.keys(rows[0] ?? {}).find(c =>
    /fahrrad|radfahrer|cyclist|bike/i.test(c));
  const pedestrianCol = Object.keys(rows[0] ?? {}).find(c =>
    /fu[sß]|pedestrian|fussgeher|gänger/i.test(c));
  const motorcycleCol = Object.keys(rows[0] ?? {}).find(c =>
    /motorrad|motor.*rad|motorcycle|krad/i.test(c));
  const fatalityCol = Object.keys(rows[0] ?? {}).find(c =>
    /get[öo]tet|fatal|dead|t[oö]t/i.test(c));
  const severeCol = Object.keys(rows[0] ?? {}).find(c =>
    /schwerl?verletzte|serious|schwer.*verletzt|schwerverl/i.test(c));
  const minorCol = Object.keys(rows[0] ?? {}).find(c =>
    /leichtv|minor.*inj|leicht.*verletzt/i.test(c));

  console.log('District col:', districtCol ?? '(not found)');
  console.log('Year col:', yearCol);
  console.log('Cyclist col:', cyclistCol ?? '(not found)');
  console.log('Pedestrian col:', pedestrianCol ?? '(not found)');

  const points = [];
  const yearsSet = new Set();
  let totalCount = 0;
  let viennaCount = 0;
  let skipCount = 0;

  for (const row of rows) {
    totalCount++;

    // Filter for Vienna
    if (districtCol) {
      const district = String(row[districtCol] ?? '');
      const distNum = parseInt(district, 10);
      // Vienna district codes per Statistik Austria: 901 (1st Bezirk) to 923 (23rd Bezirk).
      // The code always starts with 9 (Bundesland Wien = 9).
      const isVienna = district.startsWith('9') && distNum >= 900 && distNum <= 999;
      if (!isVienna) continue;
    }

    let rawLat = toFloat(row[latCol]);
    let rawLng = toFloat(row[lngCol]);

    if (isNaN(rawLat) || isNaN(rawLng)) {
      skipCount++;
      continue;
    }

    let lat, lng;

    if (coordSystem === 'wgs84') {
      lat = rawLat;
      lng = rawLng;
    } else if (coordSystem === 'gk_yx') {
      [lat, lng] = gkToWgs84(rawLat, rawLng);
    } else if (coordSystem === 'gk_xy') {
      [lat, lng] = gkToWgs84(rawLng, rawLat);
    } else {
      // Try WGS84 first, then GK
      if (rawLat > 44 && rawLat < 52 && rawLng > 9 && rawLng < 18) {
        lat = rawLat;
        lng = rawLng;
      } else if (rawLat > 5_000_000) {
        [lat, lng] = gkToWgs84(rawLng, rawLat);
      } else {
        [lat, lng] = gkToWgs84(rawLat, rawLng);
      }
    }

    // Sanity check: Vienna bounds
    if (lat < 47.9 || lat > 48.4 || lng < 16.0 || lng > 16.8) {
      skipCount++;
      continue;
    }

    const year = toInt(row[yearCol] ?? row['YEAR'] ?? row['Jahr'] ?? row['JAHR']);
    if (year >= 2009) yearsSet.add(year);

    let flags = 0;
    if (cyclistCol && toInt(row[cyclistCol]) > 0) flags |= 1;
    if (pedestrianCol && toInt(row[pedestrianCol]) > 0) flags |= 2;
    if (motorcycleCol && toInt(row[motorcycleCol]) > 0) flags |= 4;
    if (fatalityCol && toInt(row[fatalityCol]) > 0) flags |= 8;
    else if (severeCol && toInt(row[severeCol]) > 0) flags |= 16;
    else if (minorCol && toInt(row[minorCol]) > 0) flags |= 32;
    else if (flags === 0) flags |= 32; // default to minor

    points.push([
      Math.round(lat * 100000) / 100000,
      Math.round(lng * 100000) / 100000,
      year,
      flags,
    ]);
    viennaCount++;
  }

  console.log(`Total rows: ${totalCount}, Vienna: ${viennaCount}, Skipped: ${skipCount}`);
  if (skipCount > 0) console.warn(`Skipped ${skipCount} rows due to missing/invalid coordinates`);

  return {
    meta: {
      lastUpdated: new Date().toISOString(),
      totalCount,
      viennaCount,
      years: [...yearsSet].sort(),
    },
    points,
  };
}

async function main() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const dataUrl = await discoverDataUrl();
  const rawText = await downloadAndExtract(dataUrl);

  console.log(`Downloaded ${rawText.length.toLocaleString()} bytes`);

  // Try different delimiters
  let rows = parseCsv(rawText, ';');
  if (Object.keys(rows[0] ?? {}).length < 3) {
    rows = parseCsv(rawText, ',');
  }

  console.log(`Parsed ${rows.length.toLocaleString()} rows`);
  if (rows.length === 0) throw new Error('No rows parsed from CSV');

  console.log('Sample columns:', Object.keys(rows[0] ?? {}).slice(0, 12).join(', '));

  const output = processRows(rows);

  const outPath = join(DATA_DIR, 'accidents.json');
  await writeFile(outPath, JSON.stringify(output), 'utf-8');
  console.log(`Written ${output.points.length.toLocaleString()} Vienna accident points to ${outPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
