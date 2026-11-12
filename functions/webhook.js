'use strict';
// webhook: stub until its own ticket lands. It exists so the App manifest has
// a real hook_attributes.url.
exports.handler = async () => ({ statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'not found\n' });
