import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

class MockKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.get(key); }
  async put(key, value) { this.store.set(key, value); }
}

test('unauthorized request returns 401', async () => {
  const req = new Request('http://example.com/api/profile');
  const res = await worker.fetch(req, { KV: new MockKV() });
  assert.equal(res.status, 401);
});

test('init assigns name and persona', async () => {
  const kv = new MockKV();
  await kv.put('groq-api-key', 'key');
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'Alex' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  try {
    const req = new Request('http://example.com/api/init', {
      method: 'POST',
      headers: { Authorization: 'Bearer user1' }
    });
    const res = await worker.fetch(req, { KV: kv });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Alex');
    assert.equal(await kv.get('user1-name'), 'Alex');
    assert.ok(await kv.get('user1-persona'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('profile returns stored data', async () => {
  const kv = new MockKV();
  await kv.put('user1-name', 'Jamie');
  await kv.put('user1-persona', 'Test persona.');
  await kv.put('user1-guidance', 'Be nice');
  const req = new Request('http://example.com/api/profile', {
    headers: { Authorization: 'Bearer user1' }
  });
  const res = await worker.fetch(req, { KV: kv });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    name: 'Jamie',
    persona: 'Test persona.',
    guidance: 'Be nice'
  });
});
