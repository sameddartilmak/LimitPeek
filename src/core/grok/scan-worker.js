'use strict';
const { createGrokUsageScanner } = require('./usage');
const { hostScanner } = require('../scan/usage-worker-host');

/** Grok Build session usage-file scan worker. See scan/usage-worker-host.js. */
hostScanner(createGrokUsageScanner());
