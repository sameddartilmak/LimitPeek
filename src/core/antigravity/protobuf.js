'use strict';

/**
 * The smallest protobuf wire reader that can decode ONE message, strictly.
 *
 * Why hand-written: adding a protobuf library for a single undocumented
 * message would be an operational commitment someone else carries, for a
 * schema we do not control and cannot regenerate. This is ~80 lines and it
 * does one thing.
 *
 * Why STRICT is the whole point (architecture review, guard 3a):
 *
 *   A documented JSON interface fails CLOSED. Rename `remaining_fraction` and
 *   the read yields `undefined` -> null -> "bilinmiyor". The user sees an
 *   absence, which is true.
 *
 *   A field-numbered wire format fails OPEN. Renumber a field and the bytes
 *   still decode: some other float lands where we looked, it is in [0,1], it
 *   passes every range guard we have, and the user sees a confident wrong
 *   percentage. Every guard this project has is a RANGE guard, and a range
 *   guard cannot tell 0.4-the-remaining-fraction from 0.4-something-else.
 *
 * So this module refuses on anything it did not expect — a wrong wire type, a
 * truncated varint, a trailing byte — and the caller refuses the whole reading
 * rather than the one field. A loud refusal is a correct outcome here.
 *
 * WHAT THIS CANNOT CATCH, stated plainly rather than papered over: a SEMANTIC
 * flip. If Antigravity keeps field 15.1 a float32 in [0,1] but changes its
 * meaning from remaining to used, 0.4 silently becomes 0.6 — optimistic, the
 * one direction this product exists to prevent. No structural check can see
 * that, because nothing structural changed. The residual risk is accepted and
 * is the reason the figure it produces is marked `provenance: 'derived'`
 * rather than `'documented'` in the contract.
 */

const WIRE = { VARINT: 0, I64: 1, LEN: 2, I32: 5 };

/** Thrown for every malformed or unexpected input. Never leaks byte content. */
class WireError extends Error {
  constructor(what) {
    super(`protobuf: ${what}`);
    this.name = 'WireError';
  }
}

function readVarint(buf, i) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    if (i >= buf.length) throw new WireError('truncated varint');
    byte = buf[i];
    i += 1;
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    // 10 groups of 7 bits is the maximum a 64-bit varint can occupy.
    if (shift > 70n) throw new WireError('varint too long');
  } while (byte & 0x80);
  return [result, i];
}

/**
 * Decodes one message into a flat list of `{ field, wire, value }`.
 *
 * Repeated fields appear repeatedly, in wire order — the caller decides
 * whether that is legal, because "exactly once" is a schema fact this layer
 * does not know. `value` is a Buffer for LEN, a BigInt for VARINT, a number
 * for I32/I64.
 *
 * @throws {WireError} on any byte it cannot account for.
 */
function decodeMessage(buf) {
  if (!Buffer.isBuffer(buf)) throw new WireError('not a buffer');
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag;
    [tag, i] = readVarint(buf, i);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) throw new WireError('field number 0');
    if (wire === WIRE.VARINT) {
      let v;
      [v, i] = readVarint(buf, i);
      out.push({ field, wire, value: v });
    } else if (wire === WIRE.I64) {
      if (i + 8 > buf.length) throw new WireError('truncated 64-bit');
      out.push({ field, wire, value: buf.readDoubleLE(i) });
      i += 8;
    } else if (wire === WIRE.I32) {
      if (i + 4 > buf.length) throw new WireError('truncated 32-bit');
      out.push({ field, wire, value: buf.readFloatLE(i) });
      i += 4;
    } else if (wire === WIRE.LEN) {
      let n;
      [n, i] = readVarint(buf, i);
      const len = Number(n);
      if (!Number.isSafeInteger(len) || i + len > buf.length) throw new WireError('truncated length-delimited');
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else {
      // Groups (3/4) were removed from proto3 and nothing else is defined.
      throw new WireError(`unknown wire type ${wire}`);
    }
  }
  return out;
}

/** Every entry with this field number, in wire order. */
function all(fields, field, wire) {
  return fields.filter((f) => f.field === field && (wire === undefined || f.wire === wire));
}

/**
 * The single entry with this field number.
 * @throws {WireError} when absent, repeated, or of the wrong wire type — all
 *   three are structural drift, and all three must fail closed.
 */
function one(fields, field, wire) {
  const hits = fields.filter((f) => f.field === field);
  if (hits.length === 0) throw new WireError(`field ${field} missing`);
  if (hits.length > 1) throw new WireError(`field ${field} repeated`);
  if (hits[0].wire !== wire) throw new WireError(`field ${field} wire ${hits[0].wire}, expected ${wire}`);
  return hits[0];
}

/**
 * Asserts the message carries EXACTLY this set of field numbers — no more, no
 * fewer, each once.
 *
 * Used only where the numbers live. An extra field appearing next to
 * `remaining_fraction` is precisely the case where guessing which of two
 * floats is the one we want would produce a confident wrong answer, so the
 * whole reading is refused instead.
 */
function exactly(fields, expected) {
  const seen = fields.map((f) => f.field).sort((a, b) => a - b);
  const want = [...expected].sort((a, b) => a - b);
  if (seen.length !== want.length || seen.some((v, idx) => v !== want[idx])) {
    throw new WireError(`shape [${seen.join(',')}], expected [${want.join(',')}]`);
  }
}

module.exports = { decodeMessage, all, one, exactly, WireError, WIRE };
