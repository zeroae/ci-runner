'use strict';
// Reads a JIT config on stdin, writes the instance's #cloud-config on stdout.
// IDLE_SECONDS overrides the 15-minute idle exit (for testing it).
const { renderCloudConfig } = require('../functions/cloud-config.js');

const jitConfig = require('node:fs').readFileSync(0, 'utf8').trim();
const opts = { jitConfig };
if (process.env.IDLE_SECONDS) opts.idleSeconds = Number(process.env.IDLE_SECONDS);
process.stdout.write(renderCloudConfig(opts));
