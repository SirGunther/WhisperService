import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('all published JSON Schemas are valid JSON and declare 1.0.0 identities', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'schemas');
  const files = (await readdir(root)).filter((name) => name.endsWith('.json'));
  assert(files.length >= 6);
  for (const file of files) {
    const schema = JSON.parse(await readFile(join(root, file), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.title, /1\.0\.0/);
  }
});
test('OpenAPI publishes each required operation and WebSocket events', async () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'openapi.yaml');
  const openapi = await readFile(path, 'utf8');
  for (const value of ['/v1/health:', '/v1/sessions:', '/v1/sessions/{id}:', '/v1/sessions/{id}/stream:', '/v1/audio/transcriptions:', 'x-websocket-events:']) {
    assert.match(openapi, new RegExp(value.replace(/[{}]/g, '\\$&')));
  }
});
