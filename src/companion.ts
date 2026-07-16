import * as http from 'node:http';
import { LocalProxy, UpstreamConfig } from './localProxy';
import { ProxyLocation, recommendProxy } from './nordApi';

interface InitMessage {
  type: 'init';
  token: string;
  listenPort: number;
  credentials: { username: string; password: string };
  location: ProxyLocation;
}

let proxy: LocalProxy | undefined;
let control: http.Server | undefined;
let token = '';

process.once('message', (message: InitMessage) => void initialize(message));

async function initialize(message: InitMessage): Promise<void> {
  try {
    token = message.token;
    const upstream = await resolveUpstream(message.location, message.credentials);
    proxy = new LocalProxy(upstream);
    const proxyPort = await proxy.start(message.listenPort);
    control = http.createServer((request, response) => void handleControl(request, response, message.credentials));
    await new Promise<void>((resolve, reject) => {
      control!.once('error', reject);
      control!.listen(0, '127.0.0.1', resolve);
    });
    const address = control.address();
    if (!address || typeof address === 'string') throw new Error('Unable to determine companion control port');
    process.send?.({ type: 'ready', proxyPort, controlPort: address.port, pid: process.pid });
    process.disconnect?.();
  } catch (error) {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

async function handleControl(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  credentials: { username: string; password: string },
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: 'Unauthorized' });
  try {
    if (request.method === 'GET' && request.url === '/status') return json(response, 200, { active: Boolean(proxy) });
    if (request.method === 'POST' && request.url === '/switch') {
      const location = await readJson<ProxyLocation>(request);
      const upstream = await resolveUpstream(location, credentials);
      proxy?.update(upstream);
      return json(response, 200, { server: upstream.hostname });
    }
    if (request.method === 'POST' && request.url === '/stop') {
      json(response, 200, { stopped: true });
      setTimeout(shutdown, 50);
      return;
    }
    json(response, 404, { error: 'Not found' });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function resolveUpstream(
  location: ProxyLocation,
  credentials: { username: string; password: string },
): Promise<UpstreamConfig> {
  const hostname = await recommendProxy(location);
  return { ...credentials, hostname, port: 89 };
}

function readJson<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) request.destroy(new Error('Control request is too large'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body) as T); }
      catch { reject(new Error('Invalid control request')); }
    });
    request.on('error', reject);
  });
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify(value));
}

function shutdown(): void {
  proxy?.dispose();
  control?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
