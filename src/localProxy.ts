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
      const headers = { ...request.headers, host: target.host, connection: 'close' };
      delete headers['proxy-authorization'];
      const outgoing = http.request({
        method: request.method,
        hostname: target.hostname,
        port: Number(target.port || 80),
        path: `${target.pathname}${target.search}`,
        headers,
        agent: false,
        createConnection: () => remote,
      }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      outgoing.on('error', error => {
        if (!response.headersSent) response.writeHead(502, { connection: 'close' });
        response.end(message(error));
      });
      request.pipe(outgoing);
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
