'use strict';
const { createKimiUsageScanner } = require('./usage');
const { hostScanner } = require('../scan/usage-worker-host');

/** Kimi Code wire-journal scan worker (ADR-003 A6). See scan/usage-worker-host.js. */
hostScanner(createKimiUsageScanner());
