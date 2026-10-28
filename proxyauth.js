// Optional command line: node proxyauth.js [port] [configFile]
//   port        defaults to 3128; a second racer on the same machine uses
//               its own relay port (e.g. 3129) with its own proxy config.
//   configFile  defaults to proxy.json next to this script.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const LISTEN_PORT = Number(process.argv[2] || 3128);
const CONF_FILE = process.argv[3] || path.join(__dirname, 'proxy.json');

// proxy config file (e.g. proxy.json) holds the settings:
//   { "host": "geo.yourproxy.com", "port": 8080,
//     "user": "...", "pass": "..." }
const CONF = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
const AUTH = 'Basic ' + Buffer.from(CONF.user + ':' + CONF.pass).toString('base64');

const server = http.createServer();

// HTTPS traffic: browser sends CONNECT, we tunnel through the real proxy
server.on('connect', (req, clientSocket, head) => {
  try { console.log('[relay] CONNECT ' + req.url); } catch (e) {}
  const up = net.connect(CONF.port, CONF.host, () => {
    up.write(
      `CONNECT ${req.url} HTTP/1.1\r\n` +
      `Host: ${req.url}\r\n` +
      `Proxy-Authorization: ${AUTH}\r\n` +
      `Proxy-Connection: keep-alive\r\n\r\n`
    );
  });

  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    up.removeListener('data', onData);
    const head_ = buf.slice(0, idx).toString();
    if (/ 200 /.test(head_)) {
      clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (buf.length > idx + 4) clientSocket.write(buf.slice(idx + 4));
      if (head && head.length) clientSocket.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    } else {
      console.error('[proxyauth] upstream refused:', head_.split('\r\n')[0]);
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      up.destroy();
    }
  };
  up.on('data', onData);
  up.on('error', (e) => { try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e2) {} });
  clientSocket.on('error', () => up.destroy());
});

// plain HTTP traffic (rare): forward with the auth header added
server.on('request', (req, res) => {
  const options = {
    host: CONF.host, port: CONF.port,
    method: req.method, path: req.url,
    headers: { ...req.headers, 'Proxy-Authorization': AUTH },
  };
  const up = http.request(options, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', () => res.end('proxy error'));
  req.pipe(up);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[proxyauth] relay on 127.0.0.1:${LISTEN_PORT} -> ${CONF.host}:${CONF.port} (${path.basename(CONF_FILE)})`);
});
