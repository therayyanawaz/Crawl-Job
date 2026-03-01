import { test } from '../../harness.mjs';
import { strict as assert } from 'node:assert';
import { schema } from '../../../dist/config/envSchema.js';

test('schema applies defaults when values are omitted', () => {
    const parsed = schema.parse({});
    assert.equal(parsed.PGHOST, 'localhost');
    assert.equal(parsed.PGPORT, 5432);
    assert.equal(parsed.ENABLE_ALERTS, true);
    assert.equal(parsed.MAX_BACKOFF_ATTEMPTS, 5);
});

test('invalid SEARCH_QUERIES JSON is rejected', () => {
    assert.throws(() => schema.parse({ SEARCH_QUERIES: '{not-json' }));
});

test('boolean flags parse from strings', () => {
    const parsed = schema.parse({ ENABLE_INDEED: 'true', ENABLE_ALERTS: 'false' });
    assert.equal(parsed.ENABLE_INDEED, true);
    assert.equal(parsed.ENABLE_ALERTS, false);
});
