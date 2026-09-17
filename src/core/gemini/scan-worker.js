'use strict';
const { createGeminiUsageScanner } = require('./usage');
const { hostScanner } = require('../scan/usage-worker-host');

/** Gemini CLI chat-recording scan worker (ADR-003 A6). See scan/usage-worker-host.js. */
hostScanner(createGeminiUsageScanner());
