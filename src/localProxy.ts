import * as http from 'node:http';
import * as net from 'node:net';
import { connectThroughNordProxy, ProxyCredentials } from './upstreamProxy';

export interface UpstreamConfig extends ProxyCredentials {
  hostname: string;
  port: number;
}

export class LocalProxy {
  private server?: http.Server;
  private readonly sockets = new Set<net.Socket>();
  public port = 0;

  constructor(private upstream: UpstreamConfig) {}

  async start(listenPort: number): Promise<number> {
    if (this.server) return this.port;
    this.server = http.createServer((request, response) => void this.forwardHttp(request, response));
    this.server.on('connect', (request, client, head) => void this.forwardConnect(request, client as net.Socket, head));
    this.server.on('connection', socket => this.track(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(listenPort, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Unable to determine local proxy port');
    this.port = address.port;
    return this.port;
  }

  update(upstream: UpstreamConfig): void {
    this.upstream = upstream;
    for (const socket of this.sockets) socket.destroy();
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  private async forwardConnect(request: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    try {
      const target = new URL(`http://${request.url ?? ''}`);
      const remote = await connectThroughNordProxy(
        this.upstream.hostname, this.upstream.port, this.upstream,
        target.hostname, Number(target.port || 443),
      );
      this.track(remote);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
    } catch (error) {
      client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${message(error)}`);
    }
  }

  private async forwardHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const target = new URL(request.url ?? '');
      const remote = await connectThroughNordProxy(
        this.upstream.hostname, this.upstream.port, this.upstream,
        target.hostname, Number(target.port || 80),
      );
      this.track(remote);
      const headers = sanitizeHeaders(request.headers, target.host);
      remote.write(serializeRequest(request.method ?? 'GET', `${target.pathname}${target.search}`, headers));
      request.pipe(remote);

      const upstreamHeaders = await readHeaders(remote);
      const { statusCode, statusMessage, headers: responseHeaders } = parseResponseHeaders(upstreamHeaders);
      response.writeHead(statusCode, statusMessage, responseHeaders);
      remote.pipe(response);
    } catch (error) {
      response.writeHead(502, { connection: 'close' });
      response.end(message(error));
    }
  }

  dispose(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeHeaders(headers: http.IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = { ...headers, host, connection: 'close' };
  delete next['proxy-authorization'];
  delete next['proxy-connection'];
  return next;
}

function serializeRequest(method: string, path: string, headers: Record<string, string | string[]>): string {
  const lines = [`${method} ${path || '/'} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  lines.push('', '');
  return lines.join('\r\n');
}

function parseResponseHeaders(raw: string): { statusCode: number; statusMessage: string; headers: Record<string, string | string[]> } {
  const [statusLine, ...headerLines] = raw.split('\r\n');
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine ?? '');
  if (!match) throw new Error(`Invalid upstream response: ${statusLine ?? 'missing status line'}`);
  const headers: Record<string, string | string[]> = {};
  for (const line of headerLines) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    const current = headers[name];
    if (current === undefined) headers[name] = value;
    else if (Array.isArray(current)) current.push(value);
    else headers[name] = [current, value];
  }
  return { statusCode: Number(match[1]), statusMessage: match[2] ?? '', headers };
}

function readHeaders(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      cleanup();
      const remainder = data.subarray(end + 4);
      if (remainder.length) socket.unshift(remainder);
      resolve(data.subarray(0, end).toString('latin1'));
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error('Proxy closed the connection')); };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}
