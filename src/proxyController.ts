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
const PREVIOUS_SETTINGS_KEY = 'nord-proxy.previousSettings';
const COMPANION_PROTOCOL = 2;
const DEFAULT_LOCATION: ProxyLocation = { type: 'country', id: 228, label: 'United States', description: 'US' };

interface CompanionInfo { protocol: number; token: string; proxyPort: number; controlPort: number; pid: number }
interface PreviousSettings { httpProxy?: unknown; proxySupport?: unknown; terminalEnvironments: Record<string, unknown> }

export class ProxyController implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private companion?: CompanionInfo;
  private readonly infoPath: string;
  private watchdog?: NodeJS.Timeout;
  private recovery?: Promise<void>;
  private recoveryErrorShown = false;

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
    await this.removeLegacyProxySettings();
    const saved = await this.readSavedCompanion();
    this.companion = saved ? await this.validateCompanion(saved) : undefined;
    if (!this.companion && saved?.protocol === COMPANION_PROTOCOL
      && proxyPortFromEnvironment() === saved.proxyPort) {
      try {
        this.companion = await this.restoreCompanion(saved.proxyPort);
      } catch (error) {
        void vscode.window.showErrorMessage(`Nord Proxy could not be restored: ${message(error)}`);
      }
    }
    if (saved?.protocol === COMPANION_PROTOCOL
      && proxyPortFromEnvironment() === saved.proxyPort) this.startWatchdog(saved.proxyPort);
    this.render(Boolean(this.companion));
    if (this.companion) {
      vscode.window.showInformationMessage("Proxy activated successfully.");
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
    this.requireWindows();
    const confirmed = await vscode.window.showWarningMessage(
      'Nord Proxy will ask VS Code to quit and then restart it with the proxy. Save all work first.',
      { modal: true },
      'Quit and Restart VS Code',
    );
    if (confirmed !== 'Quit and Restart VS Code') return;
    this.companion = await this.readActiveCompanion();
    if (!this.companion) this.companion = await this.startCompanion();
    await this.scheduleFullRestart(`http://127.0.0.1:${this.companion.proxyPort}`);
    this.render(true);
    scheduleGracefulQuit();
  }

  async disconnect(): Promise<void> {
    this.requireWindows();
    this.stopWatchdog();
    this.companion ??= await this.readActiveCompanion();
    const confirmed = await vscode.window.showWarningMessage(
      'Nord Proxy will ask VS Code to quit and then restart it without the proxy. Save all work first.',
      { modal: true },
      'Quit and Restart Without Proxy',
    );
    if (confirmed !== 'Quit and Restart Without Proxy') return;
    await this.scheduleFullRestart();
    if (this.companion) {
      try { await this.control('POST', '/stop'); } catch { /* already stopped */ }
    }
    this.companion = undefined;
    await fs.rm(this.infoPath, { force: true });
    this.render(false);
    scheduleGracefulQuit();
  }

  async testConnection(): Promise<void> {
    this.companion ??= await this.readActiveCompanion();
    if (!this.companion) throw new Error('The proxy is disabled. Run Nord Proxy: Restart VS Code with Proxy first.');
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
      { label: active ? '$(debug-restart) Restart VS Code without proxy' : '$(debug-restart) Restart VS Code with proxy', command: active ? 'nord-proxy.disconnect' : 'nord-proxy.connect' },
      { label: '$(globe) Change proxy location', command: 'nord-proxy.selectLocation' },
      { label: '$(key) Set service credentials', command: 'nord-proxy.setCredentials' },
      { label: '$(pulse) Verify proxy and show exit IP', command: 'nord-proxy.testConnection' },
    ], { title: `${active ? 'Proxy enabled' : 'Proxy disabled'} · ${this.location().label}` });
    if (selection) await vscode.commands.executeCommand(selection.command);
  }

  private async startCompanion(listenPortOverride?: number, allowPortFallback = true): Promise<CompanionInfo> {
    const credentials = await this.credentials();
    if (!credentials) {
      await this.setCredentials();
      const retry = await this.credentials();
      if (!retry) throw new Error('NordVPN service credentials are required');
      return this.startCompanion(listenPortOverride, allowPortFallback);
    }
    await fs.mkdir(path.dirname(this.infoPath), { recursive: true });
    const token = randomBytes(32).toString('hex');
    const listenPort = listenPortOverride
      ?? vscode.workspace.getConfiguration('nordProxy').get<number>('localPort', 0);
    const companionLogPath = path.join(path.dirname(this.infoPath), 'companion.log');
    const child = childProcess.fork(path.join(__dirname, 'companion.js'), [], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: companionEnvironment(companionLogPath),
    });
    const info = await new Promise<CompanionInfo>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Local proxy service startup timed out')), 30_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('message', (response: unknown) => {
        clearTimeout(timeout);
        const value = response as { type?: string; message?: string; proxyPort?: number; controlPort?: number; pid?: number };
        if (value.type === 'error') return reject(new Error(value.message ?? 'Local proxy service failed'));
        if (value.type !== 'ready' || !value.proxyPort || !value.controlPort || !value.pid) return reject(new Error('Invalid local proxy service response'));
        resolve({ protocol: COMPANION_PROTOCOL, token, proxyPort: value.proxyPort, controlPort: value.controlPort, pid: value.pid });
      });
      child.send({ type: 'init', token, listenPort, allowPortFallback, credentials, location: this.location() });
    });
    child.unref();
    child.channel?.unref();
    await fs.writeFile(this.infoPath, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
    return info;
  }

  private async restoreCompanion(proxyPort: number): Promise<CompanionInfo> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await this.startCompanion(proxyPort, false);
      } catch (error) {
        lastError = error;
        if (!/EADDRINUSE/i.test(message(error)) || attempt === 5) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw lastError;
  }

  private startWatchdog(proxyPort: number): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.recovery) {
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
    if (this.companion && await this.validateCompanion(this.companion)) {
      this.recoveryErrorShown = false;
      return;
    }
    this.companion = undefined;
    try {
      this.companion = await this.restoreCompanion(proxyPort);
      this.recoveryErrorShown = false;
      this.render(true);
    } catch (error) {
      this.render(false);
      if (!this.recoveryErrorShown) {
        this.recoveryErrorShown = true;
        void vscode.window.showErrorMessage(`Nord Proxy stopped and could not be restored: ${message(error)}`);
      }
    }
  }

  private requireWindows(): void {
    if (process.platform !== 'win32') throw new Error('Full process-tree restart is currently supported on Windows only');
  }

  private async scheduleFullRestart(proxyUrl?: string): Promise<void> {
    await fs.mkdir(path.dirname(this.infoPath), { recursive: true });
    const restartId = `${process.pid}-${Date.now()}`;
    const logPath = path.join(path.dirname(this.infoPath), `restart-${restartId}.log`);
    await fs.writeFile(logPath, `Restart requested at ${new Date().toISOString()}\r\n`, 'utf8');
    const workerPath = path.join(path.dirname(this.infoPath), `restart-${restartId}.vbs`);
    const workerScript = [
      'Option Explicit',
      'Dim shell, env, fso, logFile, services, processes, startedAt, command, launchResult',
      'Set shell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `Set logFile = fso.OpenTextFile(${vbsLiteral(logPath)}, 8, True)`,
      'logFile.WriteLine "Worker started at " & Now',
      'Set services = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2")',
      'startedAt = Now',
      'Do',
      `  Set processes = services.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=${process.pid}")`,
      '  If processes.Count = 0 Then Exit Do',
      '  If DateDiff("s", startedAt, Now) >= 300 Then',
      '    logFile.WriteLine "Timed out waiting for VS Code to exit; restart canceled"',
      '    logFile.Close',
      '    WScript.Quit 1',
      '  End If',
      '  WScript.Sleep 250',
      'Loop',
      'WScript.Sleep 2000',
      'Set env = shell.Environment("Process")',
      'env.Remove "ELECTRON_RUN_AS_NODE"',
      'env.Remove "ALL_PROXY" : env.Remove "all_proxy" : env.Remove "http_proxy" : env.Remove "https_proxy" : env.Remove "NODE_USE_ENV_PROXY"',
      proxyUrl
        ? `env("HTTP_PROXY") = ${vbsLiteral(proxyUrl)} : env("HTTPS_PROXY") = ${vbsLiteral(proxyUrl)} : env("no_proxy") = "localhost,127.0.0.1"`
        : 'env.Remove "HTTP_PROXY" : env.Remove "HTTPS_PROXY" : env.Remove "no_proxy" : env.Remove "NO_PROXY"',
      `command = ${vbsLiteral(`"${process.execPath}"`)}`,
      'On Error Resume Next',
      'launchResult = shell.Run(command, 0, False)',
      'If Err.Number <> 0 Then',
      '  logFile.WriteLine "VS Code launch failed: " & Err.Number & " " & Err.Description',
      '  logFile.Close',
      '  WScript.Quit 1',
      'End If',
      'logFile.WriteLine "VS Code launch requested at " & Now & "; result=" & launchResult & "; command=" & command',
      'logFile.Close',
    ].join('\r\n');
    await fs.writeFile(workerPath, workerScript, 'utf8');
    const wscript = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
    const child = childProcess.spawn(wscript, ['//B', '//Nologo', workerPath], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  }

  /** One-time cleanup for settings written by version 0.0.2. */
  private async removeLegacyProxySettings(): Promise<void> {
    const previous = this.context.globalState.get<PreviousSettings>(PREVIOUS_SETTINGS_KEY);
    if (!previous) return;
    const httpConfig = vscode.workspace.getConfiguration('http');
    await httpConfig.update('proxy', previous.httpProxy, vscode.ConfigurationTarget.Global);
    await httpConfig.update('proxySupport', previous.proxySupport, vscode.ConfigurationTarget.Global);
    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    for (const platform of ['windows', 'linux', 'osx']) {
      await terminalConfig.update(
        `env.${platform}`,
        previous.terminalEnvironments?.[platform],
        vscode.ConfigurationTarget.Global,
      );
    }
    await this.context.globalState.update(PREVIOUS_SETTINGS_KEY, undefined);
  }

  private async readActiveCompanion(): Promise<CompanionInfo | undefined> {
    const info = await this.readSavedCompanion();
    return info ? this.validateCompanion(info) : undefined;
  }

  private async readSavedCompanion(): Promise<CompanionInfo | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.infoPath, 'utf8')) as CompanionInfo;
    } catch { return undefined; }
  }

  private async validateCompanion(info: CompanionInfo): Promise<CompanionInfo | undefined> {
    if (info.protocol !== COMPANION_PROTOCOL) {
      try { await controlRequest(info, 'POST', '/stop'); } catch { /* obsolete process is already gone */ }
      await fs.rm(this.infoPath, { force: true });
      return undefined;
    }
    try {
      await controlRequest(info, 'GET', '/status');
      return info;
    } catch { return undefined; }
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

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function vbsLiteral(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function companionEnvironment(logPath: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  const inheritedProxyVariables = new Set([
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'node_use_env_proxy',
  ]);
  for (const name of Object.keys(environment)) {
    if (inheritedProxyVariables.has(name.toLowerCase())) delete environment[name];
  }
  environment.NORD_PROXY_COMPANION_LOG = logPath;
  return environment;
}

function proxyPortFromEnvironment(): number | undefined {
  const value = process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return undefined;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch { return undefined; }
}

function scheduleGracefulQuit(): void {
  setTimeout(() => {
    void vscode.commands.executeCommand('workbench.action.quit').then(undefined, error => {
      if (!/cancel(?:ed|led)/i.test(message(error))) {
        void vscode.window.showErrorMessage(`Nord Proxy: Could not quit VS Code: ${message(error)}`);
      }
    });
  }, 100);
}
