const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const vm = require('vm');
const crypto = require('crypto');

const root = __dirname;
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

function loadConfig() {
  const defaults = {
    PODCAST_PROVIDER: 'listennotes',
    PODCAST_API_KEY: '',
    PODCAST_BASE_URL: 'https://listen-api-test.listennotes.com/api/v2',
    PODCAST_PI_KEY: '',
    PODCAST_PI_SECRET: '',
    PODCAST_PI_BASE_URL: 'https://api.podcastindex.org/api/1.0',
  };

  try {
    const code = fs.readFileSync(path.join(root, 'config.local.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const w = sandbox.window;
    return {
      PODCAST_PROVIDER: w.__PODCAST_PROVIDER__ || defaults.PODCAST_PROVIDER,
      PODCAST_API_KEY: w.__PODCAST_API_KEY__ || defaults.PODCAST_API_KEY,
      PODCAST_BASE_URL: w.__PODCAST_BASE_URL__ || defaults.PODCAST_BASE_URL,
      PODCAST_PI_KEY: w.__PODCAST_PI_KEY__ || defaults.PODCAST_PI_KEY,
      PODCAST_PI_SECRET: w.__PODCAST_PI_SECRET__ || defaults.PODCAST_PI_SECRET,
      PODCAST_PI_BASE_URL: w.__PODCAST_PI_BASE_URL__ || defaults.PODCAST_PI_BASE_URL,
    };
  } catch (e) {
    return defaults;
  }
}

const CONFIG = loadConfig();
console.log('Loaded config:', CONFIG.PODCAST_PROVIDER, CONFIG.PODCAST_BASE_URL, CONFIG.PODCAST_PI_BASE_URL);

function proxyRequest(req, res) {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/api-proxy') return false;

  const targetUrl = parsed.query.url;
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing url parameter');
    return true;
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid url parameter');
    return true;
  }

  const isHttps = targetUrl.startsWith('https://');
  const transport = isHttps ? https : http;

  const hopByHop = new Set([
    'host', 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'
  ]);

  const headers = {};
  for (const key of Object.keys(req.headers)) {
    if (!hopByHop.has(key.toLowerCase())) {
      headers[key] = req.headers[key];
    }
  }

  const options = {
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + (target.search || ''),
    method: 'GET',
    headers: headers,
  };

  if (target.hostname === 'api.podcastindex.org' && CONFIG.PODCAST_PI_KEY && CONFIG.PODCAST_PI_SECRET) {
    const authDate = Math.floor(Date.now() / 1000);
    options.headers['X-Auth-Key'] = CONFIG.PODCAST_PI_KEY;
    options.headers['X-Auth-Date'] = String(authDate);
    options.headers['Authorization'] = crypto.createHash('sha1').update(CONFIG.PODCAST_PI_KEY + CONFIG.PODCAST_PI_SECRET + authDate).digest('hex');
  }

  if (target.hostname === 'listen-api-test.listennotes.com' && CONFIG.PODCAST_API_KEY) {
    options.headers['X-ListenAPI-Key'] = CONFIG.PODCAST_API_KEY;
  }

  console.log(`Proxying ${req.method} ${targetUrl} -> ${options.hostname}${options.path}`);

  const apiReq = transport.request(options, (apiRes) => {
    console.log(`Response ${apiRes.statusCode} for ${targetUrl}`);
    res.writeHead(apiRes.statusCode, {
      'Content-Type': apiRes.headers['content-type'] || 'application/json',
    });
    apiRes.pipe(res);
  });

  apiReq.on('error', (err) => {
    console.error(`Proxy error for ${targetUrl}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy error: ' + err.message);
  });

  return true;
}

const server = http.createServer((req, res) => {
  if (proxyRequest(req, res)) return;

  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, path.normalize(urlPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(8000, () => console.log('Serving on http://localhost:8000'));
