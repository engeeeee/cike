'use strict';
const http = require('http');
const crypto = require('crypto');

async function createWindowBridge(handler, token) {
  // A dedicated IPv4 loopback address needs neither DNS nor an IPv6 fallback.
  // Only this per-launch address bypasses Firefox's selected proxy.
  const bytes = crypto.randomBytes(3);
  const host = `127.${1 + bytes[0] % 253}.${1 + bytes[1] % 253}.${1 + bytes[2] % 253}`;
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/browserWindows') { response.writeHead(404); response.end(); return; }
    handler(request, response);
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  let closing;
  return { url: `http://${host}:${server.address().port}/api/browserWindows`, token,
    close: () => closing ||= new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
module.exports = { createWindowBridge };
