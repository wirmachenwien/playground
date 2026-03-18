#!/usr/bin/env node

import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');

const BASE_URL = 'https://www.statistik.at/gs-atlas/ATLAS_UNFALL_WFS/ows';
const TYPE_NAME = 'ATLAS_UNFALL_WFS:unfall_data_at';
const START_YEAR = Number.parseInt(process.env.START_YEAR ?? '2013', 10);
const END_YEAR = Number.parseInt(process.env.END_YEAR ?? String(new Date().getFullYear()), 10);
const PAGE_SIZE = Number.parseInt(process.env.PAGE_SIZE ?? '5000', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS ?? '45000', 10);
const RETRIES = Number.parseInt(process.env.RETRIES ?? '5', 10);

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0',
  Accept: '*/*',
  'Accept-Language': 'de-AT,de-DE;q=0.9,en-US;q=0.8,en;q=0.7',
  'X-Requested-With': 'XMLHttpRequest',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-GPC': '1',
  Referer: 'https://www.statistik.at/atlas/verkehrsunfall/',
};

function timeoutSignal(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(id),
  };
}

async function fetchJsonWithRetry(url, retries = RETRIES) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: REQUEST_HEADERS,
        credentials: 'include',
        mode: 'cors',
        signal: timeout.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      const jitter = Math.floor(Math.random() * 400);
      const wait = 400 * (2 ** (attempt - 1)) + jitter;
      await new Promise(resolve => setTimeout(resolve, wait));
    } finally {
      timeout.clear();
    }
  }

  throw lastError;
}

function buildFeatureUrl({ year, maxFeatures, startIndex }) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: TYPE_NAME,
    outputFormat: 'application/json',
    maxFeatures: String(maxFeatures),
    viewparams: `YEAR:${year}`,
  });

  if (startIndex > 0) params.set('startIndex', String(startIndex));

  return `${BASE_URL}?${params.toString()}`;
}

function featureId(feature, year, idx) {
  return feature?.id
    ?? feature?.properties?.OBJECTID
    ?? feature?.properties?.objectid
    ?? `${year}:${idx}:${JSON.stringify(feature?.geometry ?? null)}:${JSON.stringify(feature?.properties ?? null)}`;
}

async function fetchYear(year) {
  let startIndex = 0;
  let page = 0;
  const allFeatures = [];

  while (true) {
    const url = buildFeatureUrl({
      year,
      maxFeatures: PAGE_SIZE,
      startIndex,
    });

    const payload = await fetchJsonWithRetry(url);
    const features = Array.isArray(payload?.features) ? payload.features : [];

    if (features.length === 0) break;

    allFeatures.push(...features);
    page++;
    startIndex += features.length;

    if (features.length < PAGE_SIZE) break;
  }

  const metadataSamples = allFeatures.slice(0, Math.min(1000, allFeatures.length)).map(f => f?.properties ?? {});
  const allPropertyKeys = new Set();
  for (const props of metadataSamples) {
    for (const k of Object.keys(props)) allPropertyKeys.add(k);
  }

  return {
    year,
    totalFeatures: allFeatures.length,
    pageCount: page,
    propertyKeys: [...allPropertyKeys].sort(),
    featureCollection: {
      type: 'FeatureCollection',
      metadata: {
        sourceEndpoint: BASE_URL,
        typeName: TYPE_NAME,
        year,
        fetchedAt: new Date().toISOString(),
        pageSize: PAGE_SIZE,
        pagesFetched: page,
        totalFeatures: allFeatures.length,
        includesAllMetadata: true,
      },
      features: allFeatures,
    },
  };
}

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const years = [];
  for (let y = START_YEAR; y <= END_YEAR; y++) years.push(y);

  const summary = {
    generatedAt: new Date().toISOString(),
    sourceEndpoint: BASE_URL,
    typeName: TYPE_NAME,
    yearsRequested: years,
    settings: {
      pageSize: PAGE_SIZE,
      retries: RETRIES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
    perYear: {},
    totalFeatures: 0,
  };

  for (const year of years) {
    console.log(`Fetching year ${year}...`);
    const result = await fetchYear(year);

    const outPath = join(DATA_DIR, `accidents-atlas-unfall-${year}.geojson`);
    await writeFile(outPath, JSON.stringify(result.featureCollection), 'utf-8');

    summary.perYear[year] = {
      file: outPath,
      totalFeatures: result.totalFeatures,
      pageCount: result.pageCount,
      propertyKeys: result.propertyKeys,
    };
    summary.totalFeatures += result.totalFeatures;

    console.log(`  -> ${result.totalFeatures.toLocaleString()} features (${result.pageCount} pages)`);
  }

  const summaryPath = join(DATA_DIR, 'accidents-atlas-unfall-summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

  console.log(`Done. Total features: ${summary.totalFeatures.toLocaleString()}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
