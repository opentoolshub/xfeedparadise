'use strict';

const http = require('node:http');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 8080;
const app = createApp();
const server = http.createServer((req, res) => { app.handle(req, res); });
server.requestTimeout = 30000;
server.headersTimeout = 10000;

server.listen(port, () => {
  const backends = app.config.backends.map(b => b.backend.id).join(',') || 'none';
  process.stdout.write(`${JSON.stringify({ severity: 'INFO', msg: 'listening', port, backends })}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
