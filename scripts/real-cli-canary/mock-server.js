'use strict';
/**
 * A fake model server for the real-CLI canary (dev tooling, never shipped).
 *
 * It listens on 127.0.0.1 only, on an ephemeral port, and answers every
 * model call with the SAME usage, so whatever a real tool writes to disk can
 * be checked against fixed numbers:
 *   prompt 1234 tokens (of which 1000 cached), completion 56 (7 of it
 *   reasoning), and xAI's `cost_in_usd_ticks` 12345678 ($0.0012345678).
 *
 * Wire formats it speaks (matched on the path SUFFIX, so `/v1/...`,
 * `/api/v1/...` and a bare `/...` base all work):
 *   POST  .../chat/completions        OpenAI chat, streaming (SSE) or not
 *   POST  .../responses               OpenAI Responses, streaming or not
 *   POST  .../messages                Anthropic Messages, streaming or not
 *   POST  .../messages/count_tokens   Anthropic token count
 *   GET   .../models                  OpenAI-style model list
 * Anything else gets a JSON 404 and is recorded in `unknown`, so a tool that
 * started calling a new route shows up in the canary report instead of
 * failing silently.
 *
 * The text answer is always "OK" with no tool call, so an agent loop ends
 * after one model call. A request that asks for JSON output (Qwen's
 * next-speaker check and the like) gets a small JSON object instead.
 *
 * Only Node built-ins. Usable two ways:
 *   const { createMockServer } = require('./mock-server');
 *   node scripts/real-cli-canary/mock-server.js     (prints the base URL, runs until Ctrl+C)
 */

const http = require('node:http');
const crypto = require('node:crypto');

const USAGE = Object.freeze({
  prompt: 1234,
  cached: 1000,
  completion: 56,
  reasoning: 7,
  costTicks: 12345678,
});

/** The bodies above, uncached = prompt - cached. */
const UNCACHED = USAGE.prompt - USAGE.cached;

const MAX_BODY = 32 * 1024 * 1024;

function openAiChatUsage() {
  return {
    prompt_tokens: USAGE.prompt,
    completion_tokens: USAGE.completion,
    total_tokens: USAGE.prompt + USAGE.completion,
    prompt_tokens_details: { cached_tokens: USAGE.cached },
    completion_tokens_details: { reasoning_tokens: USAGE.reasoning },
    // Moonshot's own spelling of the cached count, beside OpenAI's.
    cached_tokens: USAGE.cached,
    // xAI reports the request's cost in 1e-10 USD.
    cost_in_usd_ticks: USAGE.costTicks,
  };
}

function responsesUsage() {
  return {
    input_tokens: USAGE.prompt,
    input_tokens_details: { cached_tokens: USAGE.cached },
    output_tokens: USAGE.completion,
    output_tokens_details: { reasoning_tokens: USAGE.reasoning },
    total_tokens: USAGE.prompt + USAGE.completion,
    cost_in_usd_ticks: USAGE.costTicks,
  };
}

/** Anthropic counts the uncached prompt only in `input_tokens`. */
function anthropicUsage(outputTokens) {
  return {
    input_tokens: UNCACHED,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: USAGE.cached,
    output_tokens: outputTokens,
  };
}

function id(prefix) {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

/** The answer text: JSON when the request asked for JSON, else "OK". */
function answerText(body) {
  const fmt = body && (body.response_format || (body.text && body.text.format));
  const type = fmt && typeof fmt === 'object' ? fmt.type : null;
  if (type === 'json_object' || type === 'json_schema') {
    return JSON.stringify({ next_speaker: 'user', reasoning: 'canary', title: 'canary', result: 'ok' });
  }
  return 'OK';
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

/** `data: <json>` only (OpenAI chat), or `event:` + `data:` (Responses, Anthropic). */
function sse(res, data, event) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function chatCompletions(body, res) {
  const model = (body && body.model) || 'mock-model';
  const text = answerText(body);
  const created = Math.floor(Date.now() / 1000);
  const cid = id('chatcmpl-');
  if (!body || !body.stream) {
    sendJson(res, 200, {
      id: cid,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop', logprobs: null }],
      usage: openAiChatUsage(),
    });
    return;
  }
  startSse(res);
  const chunk = (choices, extra) => ({ id: cid, object: 'chat.completion.chunk', created, model, choices, ...extra });
  sse(res, chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]));
  sse(res, chunk([{ index: 0, delta: { content: text }, finish_reason: null }]));
  sse(res, chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
  // The usage-only chunk OpenAI sends with `stream_options.include_usage`;
  // sent always, since a tool that did not ask for it simply ignores it.
  sse(res, chunk([], { usage: openAiChatUsage() }));
  sse(res, '[DONE]');
  res.end();
}

function responses(body, res) {
  const model = (body && body.model) || 'mock-model';
  const text = answerText(body);
  const rid = id('resp_');
  const mid = id('msg_');
  const created = Math.floor(Date.now() / 1000);
  const part = { type: 'output_text', text, annotations: [] };
  const done = { type: 'message', id: mid, role: 'assistant', status: 'completed', content: [part] };
  const final = {
    id: rid, object: 'response', created_at: created, status: 'completed', model,
    output: [done], usage: responsesUsage(),
  };
  if (!body || !body.stream) {
    sendJson(res, 200, final);
    return;
  }
  startSse(res);
  let seq = 0;
  const ev = (type, data) => sse(res, { type, sequence_number: seq++, ...data }, type);
  ev('response.created', { response: { ...final, status: 'in_progress', output: [], usage: null } });
  ev('response.in_progress', { response: { ...final, status: 'in_progress', output: [], usage: null } });
  ev('response.output_item.added', { output_index: 0, item: { ...done, status: 'in_progress', content: [] } });
  ev('response.content_part.added', { item_id: mid, output_index: 0, content_index: 0, part: { ...part, text: '' } });
  ev('response.output_text.delta', { item_id: mid, output_index: 0, content_index: 0, delta: text });
  ev('response.output_text.done', { item_id: mid, output_index: 0, content_index: 0, text });
  ev('response.content_part.done', { item_id: mid, output_index: 0, content_index: 0, part });
  ev('response.output_item.done', { output_index: 0, item: done });
  ev('response.completed', { response: final });
  res.end();
}

function messages(body, res) {
  const model = (body && body.model) || 'mock-model';
  const text = answerText(body);
  const mid = id('msg_');
  if (!body || !body.stream) {
    sendJson(res, 200, {
      id: mid, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: anthropicUsage(USAGE.completion),
    });
    return;
  }
  startSse(res);
  // As the real API does: `message_start` carries the prompt side and a
  // provisional output count, `message_delta` the final cumulative counts.
  sse(res, {
    type: 'message_start',
    message: {
      id: mid, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: anthropicUsage(1),
    },
  }, 'message_start');
  sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
  sse(res, { type: 'ping' }, 'ping');
  sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, 'content_block_delta');
  sse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
  sse(res, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: anthropicUsage(USAGE.completion),
  }, 'message_delta');
  sse(res, { type: 'message_stop' }, 'message_stop');
  res.end();
}

function modelList(res) {
  const ids = ['mock-model', 'qwen3-coder-plus', 'kimi-for-coding', 'grok-code-fast-1', 'gpt-5.5', 'claude-sonnet-5'];
  sendJson(res, 200, {
    object: 'list',
    data: ids.map((m) => ({ id: m, object: 'model', created: 0, owned_by: 'canary', type: 'model', display_name: m })),
    has_more: false,
  });
}

/**
 * @param {{ log?: (line: string) => void }} [options]
 *   `log` receives one line per request (method, path, route); default silent.
 */
function createMockServer(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  let tag = 'untagged';
  /** Per tag: { calls, routes: {route: n}, unknown: [{method, path}] }. */
  const byTag = new Map();

  const statsFor = (t) => {
    if (!byTag.has(t)) byTag.set(t, { calls: 0, routes: {}, unknown: [] });
    return byTag.get(t);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      const stats = statsFor(tag);
      const url = (req.url || '/').split('?')[0].replace(/\/+$/, '');
      let body = null;
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      }
      const post = req.method === 'POST';
      let route = null;
      if (post && /\/chat\/completions$/.test(url)) route = 'chat.completions';
      else if (post && /\/messages\/count_tokens$/.test(url)) route = 'messages.count_tokens';
      else if (post && /\/messages$/.test(url)) route = 'messages';
      else if (post && /\/responses$/.test(url)) route = 'responses';
      else if (req.method === 'GET' && /\/models$/.test(url)) route = 'models';
      const streaming = Boolean(body && body.stream);
      log(`[mock] ${tag} ${req.method} ${url} -> ${route || 'UNKNOWN'}${streaming ? ' (stream)' : ''}`);
      if (route) stats.routes[route + (streaming ? '+sse' : '')] = (stats.routes[route + (streaming ? '+sse' : '')] || 0) + 1;
      try {
        switch (route) {
          case 'chat.completions': stats.calls += 1; chatCompletions(body, res); return;
          case 'responses': stats.calls += 1; responses(body, res); return;
          case 'messages': stats.calls += 1; messages(body, res); return;
          case 'messages.count_tokens': sendJson(res, 200, { input_tokens: USAGE.prompt }); return;
          case 'models': modelList(res); return;
          default:
            stats.unknown.push({ method: req.method, path: url });
            sendJson(res, 404, { error: { type: 'not_found', message: `canary mock has no route ${req.method} ${url}` } });
        }
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { error: { type: 'mock_error', message: String(err && err.message) } });
        else res.end();
      }
    });
  });
  // Tools keep connections alive; never let one hold the canary open.
  server.keepAliveTimeout = 1000;

  return {
    /** Resolves to the base URL, `http://127.0.0.1:<port>` (no path). */
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolve());
      });
    },
    /** Requests from now on are counted under `t` (the tool being run). */
    setTag(t) { tag = String(t); },
    /** `{ calls, routes, unknown }` for one tag: `calls` = usage-bearing answers. */
    stats(t) { return JSON.parse(JSON.stringify(statsFor(t))); },
  };
}

module.exports = { createMockServer, USAGE, UNCACHED };

if (require.main === module) {
  const mock = createMockServer({ log: (l) => console.log(l) });
  mock.start().then((base) => {
    console.log(`canary mock listening on ${base}  (OpenAI: ${base}/v1, Anthropic: ${base})`);
  });
}
