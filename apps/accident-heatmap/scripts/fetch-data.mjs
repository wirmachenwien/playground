#!/usr/bin/env node

import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');

const WMS_BASE_URL = 'https://www.statistik.at/gs-open/ATLAS_UNFALL_OPEN/ows';
const WMS_CAPABILITIES_URL = `${WMS_BASE_URL}?service=WMS&version=1.3.0&request=GetCapabilities`;
const WMS_LAYER = 'unfall_koord';

const VIENNA_BOUNDS = {
  minLat: 48.11,
  minLng: 16.16,
  maxLat: 48.32,
  maxLng: 16.58,
};

const QUERY_COUNT = Number.parseInt(process.env.WMS_QUERY_COUNT ?? '1400', 10);
const CONCURRENCY = Number.parseInt(process.env.WMS_CONCURRENCY ?? '4', 10);
const FEATURE_COUNT = 10; // Server-side maximum

const FLAG_CYCLIST = 1;
const FLAG_PEDESTRIAN = 2;
const FLAG_MOTORCYCLE = 4;
const FLAG_FATAL = 8;
const FLAG_SERIOUS = 16;
const FLAG_MINOR = 32;

function halton(index, base) {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function asInt(value) {
  if (value === null || value === undefined || value === '') return 0;
  return Number.parseInt(String(value), 10) || 0;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(id),
  };
}

async function fetchJsonWithRetry(url, retries = 4) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const timeout = timeoutSignal(25000);
    try {
      const res = await fetch(url, { signal: timeout.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      const jitter = Math.floor(Math.random() * 500);
      const wait = 350 * (2 ** (attempt - 1)) + jitter;
      await new Promise(resolve => setTimeout(resolve, wait));
    } finally {
      timeout.clear();
    }
  }
  throw lastErr;
}

function describeError(err) {
  const code = err?.cause?.code ? ` (${err.cause.code})` : '';
  return `${err?.message ?? 'unknown error'}${code}`;
}

async function discoverAvailableYears() {
  try {
    const timeout = timeoutSignal(15000);
    const res = await fetch(WMS_CAPABILITIES_URL, { signal: timeout.signal });
    timeout.clear();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const xml = await res.text();
    const years = [...xml.matchAll(/unfall_koord_(\d{4})/g)]
      .map(match => Number.parseInt(match[1], 10))
      .filter(year => Number.isFinite(year))
      .sort((a, b) => a - b)
      .filter((value, idx, arr) => idx === 0 || value !== arr[idx - 1]);

    if (years.length > 0) return years;
  } catch (err) {
    console.warn('Could not read WMS capabilities for years:', err.message);
  }

  const currentYear = new Date().getFullYear();
  const fallback = [];
  for (let year = 2013; year <= currentYear; year++) fallback.push(year);
  return fallback;
}

function buildSamplePoints(count) {
  const points = [];
  for (let i = 1; i <= count; i++) {
    const u = halton(i, 2);
    const v = halton(i, 3);
    const lat = VIENNA_BOUNDS.minLat + u * (VIENNA_BOUNDS.maxLat - VIENNA_BOUNDS.minLat);
    const lng = VIENNA_BOUNDS.minLng + v * (VIENNA_BOUNDS.maxLng - VIENNA_BOUNDS.minLng);
    points.push([lat, lng]);
  }

  // Always include city center to avoid edge-case empty samples.
  points.push([48.2082, 16.3738]);
  return points;
}

function buildGetFeatureInfoUrl(lat, lng) {
  const halfLat = 0.006;
  const halfLng = 0.009;

  const minLat = clamp(lat - halfLat, VIENNA_BOUNDS.minLat, VIENNA_BOUNDS.maxLat);
  const maxLat = clamp(lat + halfLat, VIENNA_BOUNDS.minLat, VIENNA_BOUNDS.maxLat);
  const minLng = clamp(lng - halfLng, VIENNA_BOUNDS.minLng, VIENNA_BOUNDS.maxLng);
  const maxLng = clamp(lng + halfLng, VIENNA_BOUNDS.minLng, VIENNA_BOUNDS.maxLng);

  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetFeatureInfo',
    layers: WMS_LAYER,
    query_layers: WMS_LAYER,
    crs: 'EPSG:4326',
    bbox: `${minLat},${minLng},${maxLat},${maxLng}`,
    width: '101',
    height: '101',
    i: '50',
    j: '50',
    info_format: 'application/json',
    feature_count: String(FEATURE_COUNT),
  });

  return `${WMS_BASE_URL}?${params.toString()}`;
}

function featureToPoint(feature) {
  const props = feature?.properties ?? {};
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  if (
    lat < VIENNA_BOUNDS.minLat ||
    lat > VIENNA_BOUNDS.maxLat ||
    lng < VIENNA_BOUNDS.minLng ||
    lng > VIENNA_BOUNDS.maxLng
  ) {
    return null;
  }

  const year = asInt(props.jahr);
  if (year < 2000) return null;

  let flags = 0;
  if (asInt(props.b_verkart_fahrrad) > 0) flags |= FLAG_CYCLIST;
  if (asInt(props.b_verkart_fussgaenger) > 0) flags |= FLAG_PEDESTRIAN;
  if (asInt(props.b_verkart_motorrad) > 0) flags |= FLAG_MOTORCYCLE;

  // This WMS source does not expose injury severity, so mark as minor/unspecified.
  flags |= FLAG_MINOR;

  const lat5 = Math.round(lat * 100000) / 100000;
  const lng5 = Math.round(lng * 100000) / 100000;
  const month = asInt(props.monat);
  const period = asInt(props.periode);
  const weekday = asInt(props.tag_der_woche);
  const key = `${year}|${lat5}|${lng5}|${month}|${period}|${weekday}|${flags}`;

  return {
    key,
    point: [lat5, lng5, year, flags],
  };
}

async function collectViennaPoints() {
  const samplePoints = buildSamplePoints(QUERY_COUNT);
  let nextIndex = 0;
  let requestCount = 0;
  let failedCount = 0;

  const unique = new Map();

  async function worker() {
    while (true) {
      const idx = nextIndex;
      nextIndex++;
      if (idx >= samplePoints.length) return;

      const [lat, lng] = samplePoints[idx];
      const url = buildGetFeatureInfoUrl(lat, lng);

      try {
        const payload = await fetchJsonWithRetry(url, 6);
        requestCount++;
        const features = payload?.features ?? [];

        for (const feature of features) {
          const converted = featureToPoint(feature);
          if (!converted) continue;
          unique.set(converted.key, converted.point);
        }
      } catch (err) {
        failedCount++;
        console.warn(`Query failed at sample #${idx + 1}: ${describeError(err)}`);
      }

      if (idx % 25 === 0) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  const points = [...unique.values()].sort((a, b) => {
    if (a[2] !== b[2]) return a[2] - b[2];
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
  });

  return { points, requestCount, failedCount };
}

async function main() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log('Fetching Vienna accident points from Statistik Austria WMS…');
  console.log(`Sampling ${QUERY_COUNT} map positions with concurrency ${CONCURRENCY}`);

  const years = await discoverAvailableYears();
  const { points, requestCount, failedCount } = await collectViennaPoints();

  if (points.length === 0) {
    throw new Error('No points were collected from WMS source');
  }

  const out = {
    meta: {
      lastUpdated: new Date().toISOString(),
      totalCount: points.length,
      viennaCount: points.length,
      years,
      source: 'https://data.statistik.gv.at/web/meta.jsp?dataset=OGDEXT_UNFALLSRV_1',
      method: 'wms-getfeatureinfo-sampling',
      severityAvailable: false,
      sampleQueries: requestCount,
      failedQueries: failedCount,
    },
    points,
  };

  const outPath = join(DATA_DIR, 'accidents.json');
  await writeFile(outPath, JSON.stringify(out), 'utf-8');

  console.log(`Collected ${points.length.toLocaleString()} unique Vienna points.`);
  console.log(`Successful sample requests: ${requestCount}/${QUERY_COUNT + 1} (failed: ${failedCount})`);
  console.log(`Years in capabilities: ${years[0]}-${years[years.length - 1]}`);
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
