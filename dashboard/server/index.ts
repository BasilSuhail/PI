/**
 * Serves the built client and the fleet API.
 *
 * Plain node:http rather than a framework — this handles four routes and a
 * static directory, and every dependency is memory that could go to the
 * workloads being watched instead.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchApps } from './apps';
import { fetchFleet } from './lib/fleet';
import { fetchContainers, fetchProcesses } from './lib/glances';
import { fetchTailnetDevices, ipv4Of } from './lib/tailnet';

const PORT = Number(process.env.PORT ?? 8080);
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

/** Resolves a tailnet device id to the address its agents listen on. */
const addressFor = async (id: string): Promise<string | null> => {
  const device = (await fetchTailnetDevices()).find((d) => d.id === id);
  return device ? ipv4Of(device) : null;
};

const handleApi = async (url: URL, res: ServerResponse): Promise<boolean> => {
  if (url.pathname === '/api/nodes') {
    sendJson(res, 200, await fetchFleet());
    return true;
  }

  if (url.pathname === '/api/apps') {
    sendJson(res, 200, await fetchApps());
    return true;
  }

  const match = url.pathname.match(/^\/api\/nodes\/([^/]+)\/(processes|containers)$/);
  if (match) {
    const [, rawId, kind] = match;
    const host = await addressFor(decodeURIComponent(rawId));
    if (!host) {
      sendJson(res, 404, { error: 'unknown node, or it has no IPv4 address' });
      return true;
    }
    if (kind === 'processes') {
      const limit = Number(url.searchParams.get('limit') ?? 30);
      sendJson(res, 200, await fetchProcesses(host, Number.isFinite(limit) ? limit : 30));
    } else {
      sendJson(res, 200, await fetchContainers(host));
    }
    return true;
  }

  return false;
};

const serveStatic = async (pathname: string, res: ServerResponse) => {
  // normalize() collapses any ../ before it can escape the static directory.
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(STATIC_DIR, rel === '/' ? 'index.html' : rel);

  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    // Single-page app: unknown paths fall back to the shell.
    file = join(STATIC_DIR, 'index.html');
  }

  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    await stat(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
};

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      if (!(await handleApi(url, res))) sendJson(res, 404, { error: 'no such endpoint' });
      return;
    }
    await serveStatic(url.pathname, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal error';
    if (url.pathname.startsWith('/api/')) sendJson(res, 502, { error: message });
    else res.writeHead(500).end(message);
  }
});

server.listen(PORT, () => {
  console.log(`tailnet-console listening on :${PORT}`);
  if (!process.env.TAILSCALE_API_KEY) {
    console.warn('TAILSCALE_API_KEY is not set — /api/nodes will return 502');
  }
});
