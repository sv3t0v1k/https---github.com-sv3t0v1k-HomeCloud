// Внутренний bounded probe; публичные nginx health endpoints закрыты.
const http = require('node:http');
const timer = setTimeout(() => process.exit(1), 4000);
const request = http.get('http://127.0.0.1:3000/api/v1/health/ready', (res) => {
  let body = '';
  res.on('data', (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) process.exit(1);
  });
  res.on('end', () => {
    clearTimeout(timer);
    try {
      const parsed = JSON.parse(body);
      const data = parsed.data || parsed;
      process.exit(res.statusCode === 200 && data.status === 'ready' &&
        data.checks?.database === 'ok' && data.checks?.storage === 'ok' ? 0 : 1);
    } catch { process.exit(1); }
  });
});
request.on('error', () => process.exit(1));
