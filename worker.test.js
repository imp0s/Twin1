import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import fs from 'node:fs/promises';

class MockKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.get(key); }
  async put(key, value) { this.store.set(key, value); }
}

class MockAssets {
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    const file = path || 'index.html';
    const text = await fs.readFile(file, 'utf8');
    let type = 'text/plain';
    if (file.endsWith('.html')) type = 'text/html; charset=UTF-8';
    else if (file.endsWith('.js')) type = 'application/javascript; charset=UTF-8';
    else if (file.endsWith('.webmanifest')) type = 'application/manifest+json; charset=UTF-8';
    else if (file.endsWith('.svg')) type = 'image/svg+xml; charset=UTF-8';
    return new Response(text, { headers: { 'Content-Type': type } });
  }
}

test('endpoints require valid UUID authorization', async () => {
  const kv = new MockKV();
  const req1 = new Request('http://example.com/api/chat', { method: 'POST' });
  let res = await worker.fetch(req1, { KV: kv });
  assert.equal(res.status, 401);
  const req2 = new Request('http://example.com/api/chat', { method: 'POST', headers: { Authorization: 'Bearer not-uuid' } });
  res = await worker.fetch(req2, { KV: kv });
  assert.equal(res.status, 400);
});

test('POST /api/init stores single record', async () => {
  const kv = new MockKV();
  await kv.put('groq-api-key', 'test');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === 'https://api.groq.com/openai/v1/chat/completions') {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Alex' } }] }), { status: 200 });
    }
    throw new Error('unexpected fetch to ' + url);
  };
  try {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const req = new Request('http://example.com/api/init', { method: 'POST', headers: { Authorization: 'Bearer ' + id } });
    const res = await worker.fetch(req, { KV: kv });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, id);
    const stored = JSON.parse(await kv.get(id));
    assert.equal(stored.name, 'Alex');
    assert.ok(stored.persona);
    assert.ok(stored.lastUsed);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET / returns index.html', async () => {
  const req = new Request('http://example.com/');
  const res = await worker.fetch(req, { KV: new MockKV(), ASSETS: new MockAssets() });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('<title>Persona Trainer PWA</title>'));
});

test('GET /admin requires credentials and reads env vars', async () => {
  const kv = new MockKV();
  const env = { KV: kv, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret' };

  const reqMissing = new Request('http://example.com/admin');
  let res = await worker.fetch(reqMissing, env);
  assert.equal(res.status, 401);

  const badAuth = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
  res = await worker.fetch(new Request('http://example.com/admin', { headers: { Authorization: badAuth } }), env);
  assert.equal(res.status, 403);

  const goodAuth = 'Basic ' + Buffer.from('admin:secret').toString('base64');
  res = await worker.fetch(new Request('http://example.com/admin', { headers: { Authorization: goodAuth } }), env);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, 'Admin OK');
});

test('GET /admin reports missing env vars', async () => {
  const env = { KV: new MockKV() };
  const req = new Request('http://example.com/admin');
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(text, 'Admin credentials not configured');
});
