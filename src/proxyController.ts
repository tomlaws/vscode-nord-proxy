import * as childProcess from 'node:child_process';
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
const ENABLED_KEY = 'nord-proxy.enabled';
const COMPANION_PROTOCOL = 3;
const DEFAULT_LOCATION: ProxyLocation = { type: 'country', id: 228, label: 'United States', description: 'US' };

interface CompanionInfo { protocol: number; token: string; proxyPort: number; controlPort: number; pid: number }
interface SettingBackup { present: boolean; value?: unknown }
interface CleanupState {
  version: 1;
  settingsPath: string;
  appliedProxy: string;
  appliedProxySupport: string;
  originalProxy: SettingBackup;
  originalProxySupport: SettingBackup;
  companion: CompanionInfo;
}

export class ProxyController implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly infoPath: string;
  private readonly cleanupStatePath: string;
  private companion?: CompanionInfo;
  private cleanupState?: CleanupState;
  private watchdog?: NodeJS.Timeout;
  private recovery?: Promise<void>;
  private shuttingDown = false;
  private restartingExtensionHost = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.infoPath = path.join(context.globalStorageUri.fsPath, 'companion.json');
    this.cleanupStatePath = path.join(context.extensionPath, 'uninstall-state.json');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'nord-proxy.showStatus';
    this.status.name = 'Nord Proxy';
    this.status.show();
    this.render(false);
  }

  async restore(): Promise<void> {
    if (!this.context.globalState.get<boolean>(ENABLED_KEY, false)) {
      if (await this.readCleanupState()) await this.cleanUpRuntime();
      else this.render(false);
      return;
    }
    try {
      await this.enable(false);
    } catch (error) {
      this.render(false);
      void vscode.window.showErrorMessage(`Nord Proxy could not be restored: ${message(error)}`);
    }
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
      if (!locations.length) throw new Error(`location discovery failed: ${message(error)}`, { cause: error });
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
    await this.enable(true);
    this.restartExtensionHost();
  }

  async disconnect(): Promise<void> {
    await this.context.globalState.update(ENABLED_KEY, false);
    await this.cleanUpRuntime();
    void vscode.window.showInformationMessage('Nord Proxy disabled and previous user proxy settings restored.');
    this.restartExtensionHost();
  }

  async testConnection(): Promise<void> {
    this.companion ??= await this.readActiveCompanion();
    if (!this.companion) throw new Error('The proxy is disabled. Run Nord Proxy: Enable Proxy first.');
    const ip = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing Nord Proxy…' },
      () => requestViaProxy(this.companion!.proxyPort, 'api.ipify.org', '/'),
    );
    void vscode.window.showInformationMessage(`Nord Proxy is working. Egress IP: ${ip.trim()}`);
  }

  async showStatus(): Promise<void> {
    const active = Boolean(this.companion && await this.validateCompanion(this.companion));
    const selection = await vscode.window.showQuickPick([
      { label: active ? '$(debug-disconnect) Disable proxy' : '$(shield) Enable proxy', command: active ? 'nord-proxy.disconnect' : 'nord-proxy.connect' },
      { label: '$(globe) Change proxy location', command: 'nord-proxy.selectLocation' },
      { label: '$(key) Set service credentials', command: 'nord-proxy.setCredentials' },
      { label: '$(pulse) Verify proxy and show exit IP', command: 'nord-proxy.testConnection' },
    ], { title: `${active ? 'Proxy enabled' : 'Proxy disabled'} · ${this.location().label}` });
    if (selection) await vscode.commands.executeCommand(selection.command);
  }

  async deactivate(): Promise<void> {
    if (this.restartingExtensionHost) return;
    this.shuttingDown = true;
    await this.cleanUpRuntime();
  }

  private async enable(showMessage: boolean): Promise<void> {
    this.shuttingDown = false;
    this.companion = await this.readActiveCompanion();
    const existing = this.cleanupState ?? await this.readCleanupState();
    const previousPort = existing ? localProxyPort(existing.appliedProxy) : undefined;
    if (!this.companion) this.companion = await this.startCompanionWithRetry(previousPort);
    const proxyUrl = `http://127.0.0.1:${this.companion.proxyPort}`;
    await this.applyProxySettings(proxyUrl, this.companion);
    await this.context.globalState.update(ENABLED_KEY, true);
    this.startWatchdog(this.companion.proxyPort);
    this.render(true);
    if (showMessage) void vscode.window.showInformationMessage('Nord Proxy enabled in VS Code user settings.');
  }

  private async applyProxySettings(proxyUrl: string, companion: CompanionInfo): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('http');
    const proxy = configuration.inspect<unknown>('proxy');
    const proxySupport = configuration.inspect<unknown>('proxySupport');
    const existing = this.cleanupState ?? await this.readCleanupState();
    const stillOwned = existing
      && proxy?.globalValue === existing.appliedProxy
      && proxySupport?.globalValue === existing.appliedProxySupport;
    const state: CleanupState = {
      version: 1,
      settingsPath: settingsPathFor(this.context),
      appliedProxy: proxyUrl,
      appliedProxySupport: 'override',
      originalProxy: stillOwned ? existing.originalProxy : backup(proxy?.globalValue),
      originalProxySupport: stillOwned ? existing.originalProxySupport : backup(proxySupport?.globalValue),
      companion,
    };
    this.cleanupState = state;
    await this.writeCleanupState(state);
    await configuration.update('proxy', proxyUrl, vscode.ConfigurationTarget.Global);
    await configuration.update('proxySupport', 'override', vscode.ConfigurationTarget.Global);
  }

  private async restoreProxySettings(): Promise<void> {
    const state = this.cleanupState ?? await this.readCleanupState();
    if (!state) return;
    const configuration = vscode.workspace.getConfiguration('http');
    if (configuration.inspect<unknown>('proxy')?.globalValue === state.appliedProxy) {
      await configuration.update('proxy', restored(state.originalProxy), vscode.ConfigurationTarget.Global);
    }
    if (configuration.inspect<unknown>('proxySupport')?.globalValue === state.appliedProxySupport) {
      await configuration.update('proxySupport', restored(state.originalProxySupport), vscode.ConfigurationTarget.Global);
    }
    await this.removeCleanupState();
  }

  private async cleanUpRuntime(): Promise<void> {
    this.stopWatchdog();
    await this.restoreProxySettings();
    this.companion ??= await this.readActiveCompanion();
    if (this.companion) {
      try { await controlRequest(this.companion, 'POST', '/stop'); } catch { /* already stopped */ }
    }
    this.companion = undefined;
    await fs.rm(this.infoPath, { force: true });
    this.render(false);
  }

  private async startCompanion(listenPort?: number): Promise<CompanionInfo> {
    const credentials = await this.credentials();
    if (!credentials) {
      await this.setCredentials();
      if (!await this.credentials()) throw new Error('NordVPN service credentials are required');
      return this.startCompanion(listenPort);
    }
    await fs.mkdir(path.dirname(this.infoPath), { recursive: true });
    const token = randomBytes(32).toString('hex');
    const configuredPort = listenPort
      ?? vscode.workspace.getConfiguration('nordProxy').get<number>('localPort', 0);
    const child = childProcess.fork(path.join(__dirname, 'companion.js'), [], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: companionEnvironment(path.join(path.dirname(this.infoPath), 'companion.log')),
    });
    const info = await new Promise<CompanionInfo>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Local proxy service startup timed out')), 30_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('message', (response: unknown) => {
        clearTimeout(timeout);
        const value = response as { type?: string; message?: string; proxyPort?: number; controlPort?: number; pid?: number };
        if (value.type === 'error') return reject(new Error(value.message ?? 'Local proxy service failed'));
        if (value.type !== 'ready' || !value.proxyPort || !value.controlPort || !value.pid) {
          return reject(new Error('Invalid local proxy service response'));
        }
        resolve({ protocol: COMPANION_PROTOCOL, token, proxyPort: value.proxyPort, controlPort: value.controlPort, pid: value.pid });
      });
      child.send({ type: 'init', token, listenPort: configuredPort, allowPortFallback: listenPort === undefined, credentials, location: this.location() });
    });
    child.unref();
    child.channel?.unref();
    await fs.writeFile(this.infoPath, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
    return info;
  }

  private async startCompanionWithRetry(listenPort?: number): Promise<CompanionInfo> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await this.startCompanion(listenPort);
      } catch (error) {
        lastError = error;
        if (!listenPort || !/EADDRINUSE/i.test(message(error)) || attempt === 5) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw lastError;
  }

  private startWatchdog(proxyPort: number): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.recovery && !this.shuttingDown) {
        this.recovery = this.ensureCompanion(proxyPort).finally(() => { this.recovery = undefined; });
      }
    }, 5_000);
    this.watchdog.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private async ensureCompanion(proxyPort: number): Promise<void> {
    if (this.companion && await this.validateCompanion(this.companion)) return;
    try {
      this.companion = await this.startCompanion(proxyPort);
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;
      const state = this.cleanupState ?? await this.readCleanupState();
      if (state) {
        state.companion = this.companion;
        state.appliedProxy = proxyUrl;
        this.cleanupState = state;
        await this.writeCleanupState(state);
      }
      this.render(true);
    } catch {
      this.companion = undefined;
      this.render(false);
    }
  }

  private restartExtensionHost(): void {
    this.restartingExtensionHost = true;
    setTimeout(() => {
      void vscode.commands.executeCommand('workbench.action.restartExtensionHost').then(undefined, error => {
        if (!/cancel(?:ed|led)/i.test(message(error))) {
          void vscode.window.showErrorMessage(`Nord Proxy could not restart the extension host: ${message(error)}`);
        }
      });
    }, 100);
  }

  private async readActiveCompanion(): Promise<CompanionInfo | undefined> {
    try {
      const info = JSON.parse(await fs.readFile(this.infoPath, 'utf8')) as CompanionInfo;
      if (info.protocol !== COMPANION_PROTOCOL) {
        try { await controlRequest(info, 'POST', '/stop'); } catch { /* obsolete companion is already gone */ }
        await fs.rm(this.infoPath, { force: true });
        return undefined;
      }
      return await this.validateCompanion(info) ? info : undefined;
    } catch { return undefined; }
  }

  private async validateCompanion(info: CompanionInfo): Promise<boolean> {
    if (info.protocol !== COMPANION_PROTOCOL) return false;
    try {
      await controlRequest(info, 'GET', '/status');
      return true;
    } catch { return false; }
  }

  private async writeCleanupState(state: CleanupState): Promise<void> {
    await fs.writeFile(this.cleanupStatePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  }

  private async readCleanupState(): Promise<CleanupState | undefined> {
    try { return JSON.parse(await fs.readFile(this.cleanupStatePath, 'utf8')) as CleanupState; }
    catch { return undefined; }
  }

  private async removeCleanupState(): Promise<void> {
    this.cleanupState = undefined;
    await fs.rm(this.cleanupStatePath, { force: true });
  }

  private control(method: string, route: string, body?: unknown): Promise<unknown> {
    if (!this.companion) throw new Error('Local proxy service is not running');
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
    this.status.tooltip = `${active ? 'Proxy enabled' : 'Proxy disabled'} · ${this.location().label}`;
    this.status.backgroundColor = active ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose(): void {
    this.stopWatchdog();
    this.status.dispose();
  }
}

function backup(value: unknown): SettingBackup {
  return value === undefined ? { present: false } : { present: true, value };
}

function restored(value: SettingBackup): unknown {
  return value.present ? value.value : undefined;
}

function settingsPathFor(context: vscode.ExtensionContext): string {
  return path.join(path.dirname(path.dirname(context.globalStorageUri.fsPath)), 'settings.json');
}

function localProxyPort(value: string): number | undefined {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch { return undefined; }
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
        let parsed: { error?: string };
        try { parsed = data ? JSON.parse(data) as { error?: string } : {}; }
        catch { return reject(new Error(`Control request returned invalid JSON (HTTP ${response.statusCode ?? 'unknown'})`)); }
        if ((response.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `Control request failed (${response.statusCode})`));
        else resolve(parsed);
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('Local proxy service did not respond')));
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

function companionEnvironment(logPath: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'node_use_env_proxy'].includes(name.toLowerCase())) {
      delete environment[name];
    }
  }
  environment.NORD_PROXY_COMPANION_LOG = logPath;
  return environment;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
