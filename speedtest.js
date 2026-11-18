#!/usr/bin/env node
// Download speed meter: N sequential GET requests to one URL,
// average request time, total downloaded bytes and resulting speed.

import { pathToFileURL } from 'node:url';

export const REQUEST_COUNT = 10;
export const TIMEOUT_MS = 60_000;

// One request: time from sending it until the last byte of the body arrives.
export async function timedDownload(url, timeoutMs = TIMEOUT_MS) {
  const start = performance.now();
  const res = await fetch(url, {
    headers: {
      // Ask for the body as-is: otherwise fetch would transparently unpack gzip/br
      // and we would count unpacked bytes instead of the downloaded ones.
      'accept-encoding': 'identity',
      // Ask intermediate caches to revalidate with the origin.
      'cache-control': 'no-cache',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }

  // Count real bytes instead of trusting Content-Length (it may be absent or wrong).
  let bytes = 0;
  if (res.body) {
    for await (const chunk of res.body) bytes += chunk.byteLength;
  }
  return { bytes, ms: performance.now() - start };
}

// Runs the requests strictly one after another and sums up the results.
export async function measure(url, { count = REQUEST_COUNT, timeoutMs = TIMEOUT_MS } = {}) {
  let totalBytes = 0;
  let totalMs = 0;
  for (let i = 0; i < count; i++) {
    const { bytes, ms } = await timedDownload(url, timeoutMs);
    totalBytes += bytes;
    totalMs += ms;
  }
  return {
    count,
    totalBytes,
    totalMs,
    avgMs: totalMs / count,
    // Speed over the whole run (all bytes / all time), not an average of
    // per-request speeds: one slow request should not distort the result.
    mbitPerSec: (totalBytes * 8) / 1e6 / (totalMs / 1000),
  };
}

export function formatReport(r) {
  return [
    `Requests:        ${r.count}`,
    `Average time:    ${r.avgMs.toFixed(1)} ms`,
    `Downloaded:      ${(r.totalBytes / 1e6).toFixed(2)} MB (${r.totalBytes} bytes)`,
    `Download speed:  ${r.mbitPerSec.toFixed(2)} Mbit/s (${(r.mbitPerSec / 8).toFixed(2)} MB/s)`,
  ].join('\n');
}

export function parseUrl(arg) {
  let url;
  try {
    url = new URL(arg);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

async function main() {
  const url = parseUrl(process.argv[2] ?? '');
  if (!url) {
    console.error('Usage: node speedtest.js <http(s)://url>');
    process.exitCode = 2;
    return;
  }

  console.log(`Measuring ${url.href} with ${REQUEST_COUNT} sequential requests...`);
  try {
    console.log(formatReport(await measure(url)));
  } catch (err) {
    // fetch hides the network reason (DNS, refused, TLS) in err.cause.
    const reason = err.name === 'TimeoutError'
      ? `timed out after ${TIMEOUT_MS / 1000} s`
      : (err.cause?.message ?? err.message);
    console.error(`Request failed: ${reason}`);
    process.exitCode = 1;
  }
}

// Run only when started as a script, not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
