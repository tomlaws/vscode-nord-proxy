import * as net from 'node:net';
import * as tls from 'node:tls';

export interface ProxyCredentials { username: string; password: string }

export async function connectThroughNordProxy(
  proxyHost: string,
  proxyPort: number,
  credentials: ProxyCredentials,
  destinationHost: string,
  destinationPort: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await connectOnce(
        proxyHost, proxyPort, credentials, destinationHost, destinationPort, timeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (isAuthenticationError(error) || attempt === 3) break;
      await new Promise(resolve => setTimeout(resolve, attempt * 200));
    }
  }
  throw lastError;
}

async function connectOnce(
  proxyHost: string,
  proxyPort: number,
  credentials: ProxyCredentials,
  destinationHost: string,
  destinationPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const socket = tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('NordVPN proxy connection timed out')));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    const auth = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64');
    socket.write([
      `CONNECT ${destinationHost}:${destinationPort} HTTP/1.1`,
      `Host: ${destinationHost}:${destinationPort}`,
      `Proxy-Authorization: Basic ${auth}`,
      'Proxy-Connection: Keep-Alive',
      '', '',
    ].join('\r\n'));
    const response = await readHeaders(socket);
    const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(response);
    const status = Number(match?.[1] ?? 0);
    if (status !== 200) {
      if (status === 407) throw new Error('NordVPN rejected the service credentials');
      throw new Error(`NordVPN proxy tunnel failed (HTTP ${status || 'unknown'})`);
    }
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && /rejected the service credentials/i.test(error.message);
}

function readHeaders(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) {
        if (data.length > 64 * 1024) finish(new Error('NordVPN proxy response headers are too large'));
        return;
      }
      const remainder = data.subarray(end + 4);
      cleanup();
      if (remainder.length) socket.unshift(remainder);
      resolve(data.subarray(0, end).toString('latin1'));
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error('NordVPN proxy closed the connection'));
    const cleanup = (): void => {
      socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
    };
    const finish = (error: Error): void => { cleanup(); reject(error); };
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose);
  });
}
