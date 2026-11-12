'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../functions/webhook.js');

test('the webhook stub answers 404', async () => {
  assert.equal((await handler({})).statusCode, 404);
});
