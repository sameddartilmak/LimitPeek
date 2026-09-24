'use strict';
const { createAntigravityUsageScanner } = require('./usage');
const { hostScanner } = require('../scan/usage-worker-host');

/** Antigravity conversation-store scan worker. See scan/usage-worker-host.js. */
hostScanner(createAntigravityUsageScanner());
