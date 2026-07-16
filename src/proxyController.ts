import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import * as vscode from 'vscode';
import { fetchLocations, ProxyLocation } from './nordApi';

const USERNAME_KEY = 'nord-proxy.username';
const PASSWORD_KEY = 'nord-proxy.password';
const LOCATION_KEY = 'nord-proxy.location';
const LOCATIONS_CACHE_KEY = 'nord-proxy.locationsCache';
const DEFAULT_LOCATION: ProxyLocation = { type: 'country', id: 228, label: 'United States', description: 'US' };

interface CompanionInfo { token: string; proxyPort: number; controlPort: number; pid: number }

export class ProxyController implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private companion?: CompanionInfo;
  private readonly infoPath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.infoPath = process.env.NORD_PROXY_CONTROL_FILE
      ?? path.join(context.globalStorageUri.fsPath, 'companion.json');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'nord-proxy.showStatus';
    this.status.name = 'Nord Proxy';
    this.status.show();
    this.render(false);
  }

  async restore(): Promise<void> {
    this.companion = await this.readActiveCompanion();
    this.render(Boolean(this.companion));
  }

  async setCredentials(): Promise<void> {
    const username = await vscode.window.showInputBox({
      title: 'NordVPN service username',
      prompt: 'Use the service username from Nord Account → Manual setup, not your email address.',
      value: await this.context.secrets.get(USERNAME_KEY), ignoreFocusOut: true,
    });
    if (username === undefined) return;
    const password = await vscode.window.showInputBox({
      title: 'NordVPN service password', password: true, ignoreFocusOut: true,
    });
    if (password === undefined) return;
    await this.context.secrets.store(USERNAME_KEY, username.trim());
    await this.context.secrets.store(PASSWORD_KEY, password);
    void vscode.window.showInformationMessage('NordVPN service credentials saved securely.');
  }

  async selectLocation(): Promise<void> {
    let locations: ProxyLocation[];
    try {
      locations = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading NordVPN locations…' },
        () => fetchLocations(),
      );
      await this.context.globalState.update(LOCATIONS_CACHE_KEY, locations);
    } catch (error) {
      locations = this.context.globalState.get<ProxyLocation[]>(LOCATIONS_CACHE_KEY) ?? [];
      if (!locations.length) throw new Error(`location discovery failed: ${message(error)}`);
    }
    const current = this.location();
    const choice = await vscode.window.showQuickPick(locations.map(location => ({
      label: location.label, description: location.description,
      picked: location.type === current.type && location.id === current.id, location,
    })), { title: 'Select NordVPN proxy location', placeHolder: current.label });
    if (!choice) return;
    await this.context.globalState.update(LOCATION_KEY, choice.location);
    if (this.companion) await this.control('POST', '/switch', choice.location);
    this.render(Boolean(this.companion));
    void vscode.window.showInformationMessage(`Nord Proxy location: ${choice.location.label}`);
  }

  async connect(): Promise<void> {
    this.companion = await this.readActiveCompanion();
    if (!this.companion) this.companion = await this.startCompanion();
    await this.launchProtectedWindow(this.companion);
    this.render(true);
    void vscode.window.showInformationMessage('Opening a proxy-protected VS Code window. This window is unchanged.');
  }

  async disconnect(): Promise<void> {
    this.companion ??= await this.readActiveCompanion();
    if (this.companion) {
      try { await this.control('POST', '/stop'); } catch { /* already stopped */ }
    }
    this.companion = undefined;
    await fs.rm(this.infoPath, { force: true });
    this.render(false);
    void vscode.window.showInformationMessage('Nord Proxy stopped. Close protected windows or relaunch them normally.');
  }

  async testConnection(): Promise<void> {
    this.companion ??= await this.readActiveCompanion();
    if (!this.companion) throw new Error('No proxy companion is running. Run Nord Proxy: Connect first.');
    const ip = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing Nord Proxy…' },
      () => requestViaProxy(this.companion!.proxyPort, 'api.ipify.org', '/'),
    );
    void vscode.window.showInformationMessage(`Nord Proxy is working. Egress IP: ${ip.trim()}`);
  }

  async showStatus(): Promise<void> {
    this.companion = await this.readActiveCompanion();
    const active = Boolean(this.companion);
    const selection = await vscode.window.showQuickPick([
      { label: active ? '$(debug-disconnect) Stop proxy' : '$(window) Open protected window', command: active ? 'nord-proxy.disconnect' : 'nord-proxy.connect' },
      { label: '$(globe) Switch location', command: 'nord-proxy.selectLocation' },
      { label: '$(key) Set service credentials', command: 'nord-proxy.setCredentials' },
      { label: '$(pulse) Test connection', command: 'nord-proxy.testConnection' },
    ], { title: `${active ? 'Proxy running' : 'Proxy stopped'} · ${this.location().label}` });
    if (selection) await vscode.commands.executeCommand(selection.command);
  }

  private async startCompanion(): Promise<CompanionInfo> {
    const credentials = await this.credentials();
    if (!credentials) {
      await this.setCredentials();
      const retry = await this.credentials();
      if (!retry) throw new Error('NordVPN service credentials are required');
      return this.startCompanion();
    }
    await fs.mkdir(path.dirname(this.infoPath), { recursive: true });
    const token = randomBytes(32).toString('hex');
    const listenPort = vscode.workspace.getConfiguration('nordProxy').get<number>('localPort', 17890);
    const child = fork(path.join(__dirname, 'companion.js'), [], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const info = await new Promise<CompanionInfo>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Proxy companion startup timed out')), 30_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('message', (response: unknown) => {
        clearTimeout(timeout);
        const value = response as { type?: string; message?: string; proxyPort?: number; controlPort?: number; pid?: number };
        if (value.type === 'error') return reject(new Error(value.message ?? 'Proxy companion failed'));
        if (value.type !== 'ready' || !value.proxyPort || !value.controlPort || !value.pid) return reject(new Error('Invalid proxy companion response'));
        resolve({ token, proxyPort: value.proxyPort, controlPort: value.controlPort, pid: value.pid });
      });
      child.send({ type: 'init', token, listenPort, credentials, location: this.location() });
    });
    child.unref();
    child.channel?.unref();
    await fs.writeFile(this.infoPath, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
    return info;
  }

  private async launchProtectedWindow(info: CompanionInfo): Promise<void> {
    const userData = path.join(path.dirname(this.infoPath), 'protected-user-data');
    await fs.mkdir(userData, { recursive: true });
    const args = [
      '--new-window', `--user-data-dir=${userData}`, '--profile', 'Nord Proxy',
      `--proxy-server=http://127.0.0.1:${info.proxyPort}`,
    ];
    if (this.context.extensionMode === vscode.ExtensionMode.Development) {
      args.push(`--extensionDevelopmentPath=${this.context.extensionPath}`);
    } else {
      args.push(`--extensions-dir=${path.dirname(this.context.extensionPath)}`);
    }
    if (vscode.workspace.workspaceFile) args.push(vscode.workspace.workspaceFile.fsPath);
    else for (const folder of vscode.workspace.workspaceFolders ?? []) args.push(folder.uri.fsPath);
    const proxyUrl = `http://127.0.0.1:${info.proxyPort}`;
    const child = spawn(process.execPath, args, {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: {
        ...process.env, NORD_PROXY_CONTROL_FILE: this.infoPath,
        HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      },
    });
    child.unref();
  }

  private async readActiveCompanion(): Promise<CompanionInfo | undefined> {
    try {
      const info = JSON.parse(await fs.readFile(this.infoPath, 'utf8')) as CompanionInfo;
      await controlRequest(info, 'GET', '/status');
      return info;
    } catch { return undefined; }
  }

  private control(method: string, route: string, body?: unknown): Promise<unknown> {
    if (!this.companion) throw new Error('Proxy companion is not running');
    return controlRequest(this.companion, method, route, body);
  }

  private async credentials(): Promise<{ username: string; password: string } | undefined> {
    const username = await this.context.secrets.get(USERNAME_KEY);
    const password = await this.context.secrets.get(PASSWORD_KEY);
    return username && password ? { username, password } : undefined;
  }

  private location(): ProxyLocation {
    const location = this.context.globalState.get<ProxyLocation>(LOCATION_KEY);
    return location?.id && location?.type && location?.label ? location : DEFAULT_LOCATION;
  }

  private render(active: boolean): void {
    this.status.text = active ? '$(shield) Nord Proxy' : '$(shield-x) Nord Proxy';
    this.status.tooltip = `${active ? 'Proxy running' : 'Proxy stopped'} · ${this.location().label}`;
    this.status.backgroundColor = active ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose(): void { this.status.dispose(); }
  async shutdown(): Promise<void> { /* Companion intentionally survives this Extension Host. */ }
}

function controlRequest(info: CompanionInfo, method: string, route: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1', port: info.controlPort, path: route, method,
      headers: { authorization: `Bearer ${info.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        const parsed = data ? JSON.parse(data) as { error?: string } : {};
        if ((response.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `Control request failed (${response.statusCode})`));
        else resolve(parsed);
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('Proxy companion did not respond')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function requestViaProxy(port: number, hostname: string, requestPath: string): Promise<string> {
  const tunnel = net.createConnection({ host: '127.0.0.1', port });
  tunnel.setTimeout(20_000, () => tunnel.destroy(new Error('Proxy test timed out')));
  await new Promise<void>((resolve, reject) => { tunnel.once('connect', resolve); tunnel.once('error', reject); });
  tunnel.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nConnection: keep-alive\r\n\r\n`);
  const response = await readHeaders(tunnel);
  if (!/^HTTP\/1\.1 200\b/.test(response)) throw new Error(`Local proxy tunnel failed: ${response.split('\r\n')[0]}`);
  const secure = tls.connect({ socket: tunnel, servername: hostname });
  await new Promise<void>((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    secure.on('data', chunk => { data = Buffer.concat([data, chunk]); });
    secure.once('error', reject);
    secure.once('end', () => {
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return reject(new Error('Proxy test returned an incomplete response'));
      const headers = data.subarray(0, end).toString('latin1');
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(headers)?.[1] ?? 0);
      if (status !== 200) return reject(new Error(`Proxy test returned HTTP ${status || 'unknown'}`));
      resolve(data.subarray(end + 4).toString('utf8'));
    });
    secure.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
  });
}

function readHeaders(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      cleanup();
      const remainder = data.subarray(end + 4); if (remainder.length) socket.unshift(remainder);
      resolve(data.subarray(0, end).toString('latin1'));
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error('Proxy closed the connection')); };
    const cleanup = (): void => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose);
  });
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
