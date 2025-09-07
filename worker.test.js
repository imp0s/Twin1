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
