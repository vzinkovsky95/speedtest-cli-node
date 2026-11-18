import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { measure, timedDownload, formatReport, parseUrl } from '../speedtest.js';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../speedtest.js', import.meta.url));
const BODY_SIZE = 256 * 1024;

// Local server instead of the internet: tests must not depend on the network.
let server;
let base;
let inFlight = 0;
let maxInFlight = 0;
let lastHeaders;

before(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url === '/missing') {
      res.writeHead(404).end('not found');
      return;
    }
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // No Content-Length: the body goes chunked in small parts with pauses,
    // so the client has to count bytes itself and requests overlap if run in parallel.
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(BODY_SIZE / 4, 1);
    let sent = 0;
    const timer = setInterval(() => {
      res.write(chunk);
      if (++sent === 4) {
        clearInterval(timer);
        inFlight--;
        res.end();
      }
    }, 5);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('counts every byte of the body without Content-Length', async () => {
  const { bytes, ms } = await timedDownload(`${base}/file`);
  assert.equal(bytes, BODY_SIZE);
  assert.ok(ms > 0);
});

test('asks for an uncompressed body', async () => {
  await timedDownload(`${base}/file`);
  assert.equal(lastHeaders['accept-encoding'], 'identity');
});

test('makes requests sequentially and sums up the results', async () => {
  maxInFlight = 0;
  const r = await measure(`${base}/file`, { count: 3 });
  assert.equal(maxInFlight, 1);
  assert.equal(r.count, 3);
  assert.equal(r.totalBytes, 3 * BODY_SIZE);
  assert.ok(Math.abs(r.avgMs - r.totalMs / 3) < 1e-9);
});

test('fails on a non-2xx response', async () => {
  await assert.rejects(timedDownload(`${base}/missing`), /HTTP 404/);
});

test('speed is all bytes over all time', () => {
  // 1 000 000 bytes in 1 s = 8 Mbit/s = 1 MB/s
  const report = formatReport({
    count: 10, totalBytes: 1_000_000, totalMs: 1000, avgMs: 100, mbitPerSec: 8,
  });
  assert.match(report, /Average time:\s+100\.0 ms/);
  assert.match(report, /Downloaded:\s+1\.00 MB \(1000000 bytes\)/);
  assert.match(report, /Download speed:\s+8\.00 Mbit\/s \(1\.00 MB\/s\)/);
});

test('accepts only http(s) URLs', () => {
  assert.ok(parseUrl('https://example.com/a.jpg'));
  assert.equal(parseUrl('ftp://example.com/a.jpg'), null);
  assert.equal(parseUrl('not a url'), null);
});

test('CLI: prints the report for a working URL', async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, `${base}/file`]);
  assert.match(stdout, /Requests:\s+10/);
  assert.match(stdout, new RegExp(`\\(${10 * BODY_SIZE} bytes\\)`));
  assert.match(stdout, /Download speed:\s+[\d.]+ Mbit\/s/);
});

test('CLI: exit code 2 without a valid URL', async () => {
  await assert.rejects(run(process.execPath, [SCRIPT]), (err) => {
    assert.equal(err.code, 2);
    assert.match(err.stderr, /Usage:/);
    return true;
  });
});

test('CLI: exit code 1 when the server answers with an error', async () => {
  await assert.rejects(run(process.execPath, [SCRIPT, `${base}/missing`]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Request failed: HTTP 404/);
    return true;
  });
});
