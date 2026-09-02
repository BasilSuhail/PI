/**
 * Serves the built client and the fleet API.
 *
 * Plain node:http rather than a framework — this handles four routes and a
 * static directory, and every dependency is memory that could go to the
 * workloads being watched instead.
 */

import { createGzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchApps } from './apps';
import { credentialStatus } from './lib/expiry';
import { dialHost } from './lib/dial';
import { fetchCache, fetchListing, fetchRoots, openStream, postUpload, postWrite } from './lib/files';
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/** Below this, framing costs more than compression saves. */
const GZIP_MIN = 1024;
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;

const acceptsGzip = (req: IncomingMessage) =>
  /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));

const sendJson = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown) => {
  const payload = Buffer.from(JSON.stringify(body));
  const head: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (payload.length >= GZIP_MIN && acceptsGzip(req)) {
    head['Content-Encoding'] = 'gzip';
    head.Vary = 'Accept-Encoding';
    res.writeHead(status, head);
    const gz = createGzip();
    gz.pipe(res);
    gz.end(payload);
    return;
  }
  head['Content-Length'] = payload.length;
  res.writeHead(status, head);
  res.end(payload);
};

/** Resolves a tailnet device id to the address its agents listen on. */
const addressFor = async (id: string): Promise<string | null> => {
  const device = (await fetchTailnetDevices()).find((d) => d.id === id);
  const ip = device ? ipv4Of(device) : null;
  // Loopback for this machine's own address. See lib/dial.ts.
  return ip ? dialHost(ip) : null;
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const handleApi = async (req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> => {
  if (url.pathname === '/api/nodes') {
    sendJson(req, res, 200, await fetchFleet());
    return true;
  }

  if (url.pathname === '/api/apps') {
    sendJson(req, res, 200, await fetchApps());
    return true;
  }

  // Read from the environment, so no agent is involved and this cannot fail
  // the way a fleet poll can. Empty under systemd, where nothing expires.
  if (url.pathname === '/api/credentials') {
    sendJson(req, res, 200, credentialStatus());
    return true;
  }

  const files = url.pathname.match(/^\/api\/nodes\/([^/]+)\/files$/);
  if (files) {
    const host = await addressFor(decodeURIComponent(files[1]));
    if (!host) {
      sendJson(req, res, 404, { error: 'unknown node, or it has no IPv4 address' });
      return true;
    }
    // The path is not validated here. The shim owns that decision and refuses
    // anything outside its roots; duplicating the rule in two places is how
    // the two drift apart.
    const path = url.searchParams.get('path');
    try {
      sendJson(req, res, 200, path ? await fetchListing(host, path) : await fetchRoots(host));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'scan failed';
      sendJson(req, res, 502, { error: message });
    }
    return true;
  }

  // Bytes rather than JSON: the body is piped straight through so a download
  // never lands in this process's memory.
  const stream = url.pathname.match(/^\/api\/nodes\/([^/]+)\/(download|thumb)$/);
  if (stream) {
    const [, rawId, kind] = stream;
    const host = await addressFor(decodeURIComponent(rawId));
    const path = url.searchParams.get('path');
    if (!host || !path) {
      sendJson(req, res, 404, { error: 'unknown node, or no path given' });
      return true;
    }
    const upstream = await openStream(host, kind as 'download' | 'thumb', path);
    if (!upstream.ok || !upstream.body) {
      sendJson(req, res, upstream.status, { error: upstream.statusText });
      return true;
    }
    const name = path.split('/').pop() ?? 'file';
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      ...(upstream.headers.get('content-length')
        ? { 'Content-Length': upstream.headers.get('content-length')! }
        : {}),
      // A thumbnail is keyed on the file's mtime upstream, so it is safe to
      // keep. A download is not cached: the file may have changed.
      'Cache-Control': kind === 'thumb' ? 'private, max-age=86400' : 'no-store',
      ...(kind === 'download'
        ? { 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"` }
        : {}),
    });
    await pipeline(upstream.body as unknown as NodeJS.ReadableStream, res).catch(() => {});
    return true;
  }

  const write = url.pathname.match(/^\/api\/nodes\/([^/]+)\/(write|upload)$/);
  if (write && req.method === 'POST') {
    const [, rawId, kind] = write;
    const host = await addressFor(decodeURIComponent(rawId));
    if (!host) {
      sendJson(req, res, 404, { error: 'unknown node' });
      return true;
    }
    // The agent decides. Its refusal, and its wording, are what the person
    // gets back — the dashboard re-stating the rules would only let the two
    // disagree.
    const upstream =
      kind === 'upload'
        ? await postUpload(
            host,
            url.searchParams.get('path') ?? '',
            url.searchParams.get('name') ?? '',
            req,
            req.headers['content-length'] ?? '0',
          )
        : await postWrite(host, JSON.parse(await readBody(req)));
    const text = await upstream.text();
    if (!upstream.ok) {
      sendJson(req, res, upstream.status, { error: upstream.statusText || text });
      return true;
    }
    sendJson(req, res, 200, JSON.parse(text || '{}'));
    return true;
  }

  const cache = url.pathname.match(/^\/api\/nodes\/([^/]+)\/cache$/);
  if (cache) {
    const host = await addressFor(decodeURIComponent(cache[1]));
    if (!host) {
      sendJson(req, res, 404, { error: 'unknown node' });
      return true;
    }
    try {
      sendJson(req, res, 200, await fetchCache(host));
    } catch (err) {
      sendJson(req, res, 502, { error: err instanceof Error ? err.message : 'unreachable' });
    }
    return true;
  }

  const match = url.pathname.match(/^\/api\/nodes\/([^/]+)\/(processes|containers)$/);
  if (match) {
    const [, rawId, kind] = match;
    const host = await addressFor(decodeURIComponent(rawId));
    if (!host) {
      sendJson(req, res, 404, { error: 'unknown node, or it has no IPv4 address' });
      return true;
    }
    if (kind === 'processes') {
      const limit = Number(url.searchParams.get('limit') ?? 30);
      sendJson(req, res, 200, await fetchProcesses(host, Number.isFinite(limit) ? limit : 30));
    } else {
      sendJson(req, res, 200, await fetchContainers(host));
    }
    return true;
  }

  return false;
};

const serveStatic = async (req: IncomingMessage, pathname: string, res: ServerResponse) => {
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

  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const head: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  };

  const { size } = await stat(file);
  const gzip = COMPRESSIBLE.test(type) && size >= GZIP_MIN && acceptsGzip(req);
  if (gzip) {
    head['Content-Encoding'] = 'gzip';
    head.Vary = 'Accept-Encoding';
  } else {
    head['Content-Length'] = String(size);
  }
  res.writeHead(200, head);

  const source = createReadStream(file);
  // A client that leaves mid-transfer aborts the pipeline; that is not an error.
  await pipeline(gzip ? [source, createGzip(), res] : [source, res]).catch(() => {});
};

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      if (!(await handleApi(req, url, res))) sendJson(req, res, 404, { error: 'no such endpoint' });
      return;
    }
    await serveStatic(req, url.pathname, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal error';
    if (url.pathname.startsWith('/api/')) sendJson(req, res, 502, { error: message });
    else res.writeHead(500).end(message);
  }
});

server.listen(PORT, () => {
  console.log(`jug-console listening on :${PORT}`);
  if (!process.env.TAILSCALE_API_KEY) {
    console.warn('TAILSCALE_API_KEY is not set — /api/nodes will return 502');
  }
});
