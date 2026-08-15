import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_MESSAGE_BYTES, MessageFramer, encodeMessage } from './framing.ts';

/** Frame a payload the way a Content-Length server would. */
function framed(payload: unknown): string {
  return encodeMessage(payload);
}

test('encodeMessage writes a byte-accurate Content-Length header', () => {
  const encoded = encodeMessage({ hello: 'wörld' });
  const [header, body] = encoded.split('\r\n\r\n');

  assert.equal(body, '{"hello":"wörld"}');
  assert.equal(header, `Content-Length: ${Buffer.byteLength(body ?? '')}`);
  assert.notEqual(Buffer.byteLength(body ?? ''), (body ?? '').length, 'test needs a multi-byte character');
});

test('a framer reads a single Content-Length message', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push(framed({ id: 1 })), ['{"id":1}']);
  assert.equal(framer.pending, 0);
});

test('a framer reads several messages from one chunk', () => {
  const framer = new MessageFramer();
  const messages = framer.push(`${framed({ id: 1 })}${framed({ id: 2 })}`);

  assert.deepEqual(messages, ['{"id":1}', '{"id":2}']);
});

test('a framer reassembles a message split mid-header', () => {
  const framer = new MessageFramer();
  const encoded = framed({ id: 1 });

  assert.deepEqual(framer.push(encoded.slice(0, 8)), []);
  assert.ok(framer.pending > 0);
  assert.deepEqual(framer.push(encoded.slice(8)), ['{"id":1}']);
});

test('a framer reassembles a message split mid-body', () => {
  const framer = new MessageFramer();
  const encoded = framed({ id: 1, text: 'abcdefghij' });
  const split = encoded.length - 4;

  assert.deepEqual(framer.push(encoded.slice(0, split)), []);
  assert.deepEqual(framer.push(encoded.slice(split)), ['{"id":1,"text":"abcdefghij"}']);
});

test('a framer reads newline-delimited messages', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push('{"id":1}\n{"id":2}\n'), ['{"id":1}', '{"id":2}']);
});

test('a framer waits for the newline terminator', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push('{"id":1}'), []);
  assert.deepEqual(framer.push('\n'), ['{"id":1}']);
});

test('a framer skips blank lines', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push('\n\n{"id":1}\n'), ['{"id":1}']);
});

test('a framer handles both framings in one stream', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push(`{"id":1}\n${framed({ id: 2 })}`), ['{"id":1}', '{"id":2}']);
});

test('a framer accepts a lowercase header', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push('content-length: 8\r\n\r\n{"id":1}'), ['{"id":1}']);
});

test('a framer resynchronises past an unparseable header', () => {
  const framer = new MessageFramer();
  const messages = framer.push(`Content-Length: abc\r\n\r\n${framed({ id: 2 })}`);

  assert.deepEqual(messages, ['{"id":2}']);
});

test('a framer rejects an oversized declared length', () => {
  const framer = new MessageFramer();
  assert.throws(
    () => framer.push(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`),
    /exceeds the 1048576 byte cap/,
  );
  assert.equal(framer.pending, 0, 'the buffer is dropped so the stream can recover');
});

test('a framer rejects an unterminated newline message that grows past the cap', () => {
  const framer = new MessageFramer();
  assert.throws(() => framer.push('x'.repeat(MAX_MESSAGE_BYTES + 1)), /unterminated message/);
  assert.equal(framer.pending, 0);
});

test('a framer accepts Buffer and string chunks alike', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push(Buffer.from('{"id":1}\n')), ['{"id":1}']);
  assert.deepEqual(framer.push('{"id":2}\n'), ['{"id":2}']);
});

test('a framer returns nothing for an empty chunk', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push(''), []);
});
