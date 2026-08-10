#!/usr/bin/env node
// A controllable MCP-over-stdio server used to fault-inject against the zone client.
// Behaviour is selected with --mode; --root is accepted and ignored so the fixture is
// a drop-in stand-in for zbrain-mcp in registry entries.
//
//   ok       responds normally, Content-Length framing (default)
//   newline  responds normally, newline-delimited framing
//   slow     completes the handshake, then never answers a tool call
//   deaf     never answers anything, including the handshake
//   crash    exits non-zero immediately
//   die      exits non-zero after the handshake
//   error    returns a JSON-RPC error for tool calls
//   garbage  emits noise on stdout before each valid response
//   empty    returns a result with no recognisable hits
//   oversize declares a Content-Length far beyond the cap

const mode = (() => {
  const index = process.argv.indexOf('--mode');
  return index === -1 ? 'ok' : (process.argv[index + 1] ?? 'ok');
})();

if (mode === 'crash') process.exit(3);

const write = (message) => {
  const body = JSON.stringify(message);
  if (mode === 'newline') {
    process.stdout.write(`${body}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

const toolResult = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  isError: false,
});

const searchPayload = {
  results: [
    {
      id: 'concepts/hot-index-reload.md',
      snippet: 'Reload the index without dropping the served one.',
      score: 4.2,
      owner: 'me@example.com',
      modified: '2026-08-01T00:00:00.000Z',
      hash: 'abc123',
    },
    { id: 'inbox/notes.md', snippet: 'Assorted notes.', score: 1.1 },
    { notAHit: true },
  ],
};

let buffer = Buffer.alloc(0);

const takeMessages = () => {
  const out = [];
  for (;;) {
    if (buffer.length === 0) break;
    if (/^content-length:/i.test(buffer.subarray(0, 32).toString('ascii'))) {
      const separator = buffer.indexOf('\r\n\r\n');
      if (separator < 0) break;
      const header = buffer.subarray(0, separator).toString('ascii');
      const length = Number((/content-length:\s*(\d+)/i.exec(header) ?? [])[1]);
      const start = separator + 4;
      if (buffer.length < start + length) break;
      out.push(buffer.subarray(start, start + length).toString('utf8'));
      buffer = buffer.subarray(start + length);
      continue;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) break;
    const line = buffer.subarray(0, newline).toString('utf8').trim();
    buffer = buffer.subarray(newline + 1);
    if (line) out.push(line);
  }
  return out;
};

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  for (const raw of takeMessages()) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    if (mode === 'deaf') continue;

    if (mode === 'garbage') process.stdout.write('this is not a message\n');

    if (message.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'fake-zone', version: '1.0.0' },
          capabilities: { tools: {} },
        },
      });
      if (mode === 'die') setTimeout(() => process.exit(4), 20);
      continue;
    }

    if (mode === 'slow') continue;

    if (mode === 'oversize') {
      process.stdout.write(`Content-Length: ${1024 * 1024 * 8}\r\n\r\n`);
      continue;
    }

    if (mode === 'error') {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'zone said no' } });
      continue;
    }

    const name = message.params?.name;
    if (name === 'zbrain.get') {
      write({ jsonrpc: '2.0', id: message.id, result: toolResult({ text: 'excerpt line one' }) });
      continue;
    }
    if (name === 'zbrain.status') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: toolResult({ status: { documents: 42, generation: 'gen-7' } }),
      });
      continue;
    }
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: toolResult(mode === 'empty' ? { results: [] } : searchPayload),
    });
  }
});
