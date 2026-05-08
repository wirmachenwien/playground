#!/usr/bin/env node

import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');

const DATASET_SOURCE_URL = 'https://www.data.gv.at/datasets/77e3a534-8234-38bf-aab0-15f262c2318d?locale=de';
const YEAR_FROM = Number.parseInt(process.env.ACCIDENT_YEAR_FROM ?? '2013', 10);
const PAGE_SIZE = Math.max(100, Number.parseInt(process.env.WFS_PAGE_SIZE ?? '10000', 10));
const MAX_RETRIES = Math.max(1, Number.parseInt(process.env.WFS_MAX_RETRIES ?? '5', 10));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.WFS_TIMEOUT_MS ?? '45000', 10));

const WFS_ENDPOINTS = [
  'https://www.statistik.at/gs-open/ATLAS_UNFALL_OPEN/wfs',
  'https://www.statistik.gv.at/gs-open/ATLAS_UNFALL_OPEN/wfs',
  'https://www.statistik.at/gs-open/ATLAS_UNFALL_OPEN/wms',
];

const FLAG_CYCLIST = 1;
const FLAG_PEDESTRIAN = 2;
const FLAG_MOTORCYCLE = 4;
const FLAG_CAR = 64;
const FLAG_OTHER = 128;

function timeoutSignal(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(id),
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function asInt(value) {
  if (value === null || value === undefined || value === '') return 0;
  return Number.parseInt(String(value), 10) || 0;
}

function describeError(err) {
  const code = err?.cause?.code ? ` (${err.cause.code})` : '';
  return `${err?.message ?? 'unknown error'}${code}`;
}

async function fetchTextWithRetry(url, retries = MAX_RETRIES) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: timeout.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = 350 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
        await sleep(delay);
      }
    } finally {
      timeout.clear();
    }
  }
  throw lastErr;
}

async function fetchJsonWithRetry(url, retries = MAX_RETRIES) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: timeout.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = 350 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
        await sleep(delay);
      }
    } finally {
      timeout.clear();
    }
  }
  throw lastErr;
}

function buildCapabilitiesUrl(baseUrl) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetCapabilities',
  });
  return `${baseUrl}?${params.toString()}`;
}

function parseFeatureTypeCandidates(capabilitiesXml) {
  const names = [...capabilitiesXml.matchAll(/<Name>([^<]+)<\/Name>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);

  const unique = [...new Set(names)];
  const unfall = unique.filter(name => /unfall/i.test(name));

  return unfall.length > 0 ? unfall : unique;
}

async function discoverWorkingService() {
  for (const endpoint of WFS_ENDPOINTS) {
    const capabilitiesUrl = buildCapabilitiesUrl(endpoint);
    try {
      const capabilitiesXml = await fetchTextWithRetry(capabilitiesUrl, 2);
      const candidates = parseFeatureTypeCandidates(capabilitiesXml);
      const preferred = candidates.find(name => /(^|[:_])unfall_koord($|_)/i.test(name));
      const fallback = candidates.find(name => /unfall/i.test(name));
      const typeName = preferred ?? fallback;

      if (!typeName) continue;

      return {
        endpoint,
        capabilitiesUrl,
        typeName,
      };
    } catch {
      // Try next endpoint.
    }
  }

  throw new Error('Unable to discover a working WFS endpoint/typeName for ATLAS_UNFALL_OPEN');
}

function buildRequestUrl({ endpoint, typeName, pageSize, offset, version, useTypeNames, filter }) {
  const params = new URLSearchParams({
    service: 'WFS',
    request: 'GetFeature',
    version,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
  });

  params.set(useTypeNames ? 'typeNames' : 'typeName', typeName);

  if (version.startsWith('2.')) {
    params.set('count', String(pageSize));
    params.set('startIndex', String(offset));
  } else {
    params.set('maxFeatures', String(pageSize));
    params.set('startIndex', String(offset));
  }

  if (filter) {
    params.set('cql_filter', filter);
  }

  return `${endpoint}?${params.toString()}`;
}

function getFeatureId(feature, index) {
  return String(feature.id ?? feature.properties?.id ?? `row-${index}`);
}

function normalizeFeature(feature, index) {
  const properties = feature?.properties ?? {};
  const geometry = feature?.geometry ?? null;
  const coords = geometry?.coordinates;

  let lat = null;
  let lng = null;
  if (Array.isArray(coords) && coords.length >= 2) {
    lng = Number(coords[0]);
    lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      lat = null;
      lng = null;
    }
  }

  const year = asInt(properties.jahr);

  let flags = 0;
  if (asInt(properties.b_verkart_fahrrad) > 0) flags |= FLAG_CYCLIST;
  if (asInt(properties.b_verkart_fussgaenger) > 0) flags |= FLAG_PEDESTRIAN;
  if (asInt(properties.b_verkart_motorrad) > 0) flags |= FLAG_MOTORCYCLE;
  if (asInt(properties.b_verkart_pkw) > 0) flags |= FLAG_CAR;
  if (asInt(properties.b_verkart_rest) > 0) flags |= FLAG_OTHER;

  return {
    id: getFeatureId(feature, index),
    year,
    lat,
    lng,
    flags,
    properties,
    geometry,
  };
}

async function fetchAllFeatures({ endpoint, typeName, yearFrom }) {
  const strategies = [
    { version: '2.0.0', useTypeNames: true, filter: `jahr>=${yearFrom}` },
    { version: '2.0.0', useTypeNames: false, filter: `jahr>=${yearFrom}` },
    { version: '1.1.0', useTypeNames: false, filter: `jahr>=${yearFrom}` },
    { version: '1.0.0', useTypeNames: false, filter: `jahr>=${yearFrom}` },
    { version: '2.0.0', useTypeNames: true, filter: null },
    { version: '1.1.0', useTypeNames: false, filter: null },
  ];

  let lastError = null;

  for (const strategy of strategies) {
    const features = [];
    let offset = 0;
    let page = 0;

    try {
      while (true) {
        const url = buildRequestUrl({
          endpoint,
          typeName,
          pageSize: PAGE_SIZE,
          offset,
          version: strategy.version,
          useTypeNames: strategy.useTypeNames,
          filter: strategy.filter,
        });

        const payload = await fetchJsonWithRetry(url);
        const batch = payload?.features ?? [];

        if (batch.length === 0) {
          break;
        }

        features.push(...batch);
        page++;

        const numberMatched = Number.parseInt(payload?.numberMatched, 10);
        const totalKnown = Number.isFinite(numberMatched) && numberMatched >= 0;

        if (batch.length < PAGE_SIZE) {
          break;
        }

        offset += batch.length;

        if (totalKnown && offset >= numberMatched) {
          break;
        }

        if (page % 20 === 0) {
          console.log(`Fetched ${offset.toLocaleString()} features so far (${strategy.version}, ${typeName})…`);
        }
      }

      let filtered = features;
      if (!strategy.filter) {
        filtered = features.filter(feature => asInt(feature?.properties?.jahr) >= yearFrom);
      }

      return {
        rawFeatures: filtered,
        strategy,
      };
    } catch (err) {
      lastError = err;
      console.warn(
        `Strategy failed (version=${strategy.version}, typeNames=${strategy.useTypeNames}, filter=${strategy.filter ?? 'none'}): ${describeError(err)}`,
      );
    }
  }

  throw lastError ?? new Error('All WFS pagination strategies failed');
}

async function main() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log('Discovering Statistik Austria ATLAS_UNFALL_OPEN WFS service…');
  const discovered = await discoverWorkingService();

  console.log(`Using endpoint: ${discovered.endpoint}`);
  console.log(`Using feature type: ${discovered.typeName}`);

  const { rawFeatures, strategy } = await fetchAllFeatures({
    endpoint: discovered.endpoint,
    typeName: discovered.typeName,
    yearFrom: YEAR_FROM,
  });

  const seen = new Set();
  const records = [];
  for (let i = 0; i < rawFeatures.length; i++) {
    const record = normalizeFeature(rawFeatures[i], i);
    if (record.year < YEAR_FROM) continue;

    const dedupeKey = record.id !== `row-${i}`
      ? record.id
      : `${record.year}|${record.lat}|${record.lng}|${JSON.stringify(record.properties)}`;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    records.push(record);
  }

  records.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    if (a.lat !== b.lat) return (a.lat ?? 0) - (b.lat ?? 0);
    return (a.lng ?? 0) - (b.lng ?? 0);
  });

  const points = records
    .filter(record => Number.isFinite(record.lat) && Number.isFinite(record.lng))
    .map(record => [
      Math.round(record.lat * 100000) / 100000,
      Math.round(record.lng * 100000) / 100000,
      record.year,
      record.flags,
    ]);

  const yearCounts = new Map();
  for (const record of records) {
    yearCounts.set(record.year, (yearCounts.get(record.year) ?? 0) + 1);
  }

  const out = {
    meta: {
      lastUpdated: new Date().toISOString(),
      source: DATASET_SOURCE_URL,
      sourceService: discovered.endpoint,
      sourceCapabilities: discovered.capabilitiesUrl,
      featureType: discovered.typeName,
      totalCount: records.length,
      pointCount: points.length,
      yearFrom: YEAR_FROM,
      method: 'wfs-getfeature-full-pagination',
      pageSize: PAGE_SIZE,
      requestStrategy: strategy,
      years: [...yearCounts.keys()].sort((a, b) => a - b),
    },
    points,
    records,
  };

  const outPath = join(DATA_DIR, 'accidents.json');
  await writeFile(outPath, JSON.stringify(out), 'utf-8');

  console.log(`Collected ${records.length.toLocaleString()} accident records (${points.length.toLocaleString()} with coordinates).`);
  console.log('Records by year:');
  for (const year of [...yearCounts.keys()].sort((a, b) => a - b)) {
    console.log(`  ${year}: ${yearCounts.get(year).toLocaleString()}`);
  }
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
