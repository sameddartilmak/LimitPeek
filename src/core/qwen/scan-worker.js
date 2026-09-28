'use strict';
const { createQwenUsageScanner } = require('./usage');
const { hostScanner } = require('../scan/usage-worker-host');

/** Qwen Code usage-log scan worker. See scan/usage-worker-host.js. */
hostScanner(createQwenUsageScanner());
