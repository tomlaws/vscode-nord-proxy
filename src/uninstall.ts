import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';

interface SettingBackup { present: boolean; value?: unknown }
interface CompanionInfo { token: string; controlPort: number }
interface CleanupState {
  version: 1;
  settingsPath: string;
  appliedProxy: string;
  appliedProxySupport: string;
  originalProxy: SettingBackup;
  originalProxySupport: SettingBackup;
  companion: CompanionInfo;
}

const statePath = path.join(__dirname, '..', 'uninstall-state.json');

if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as CleanupState;
    restoreSettings(state);
    stopCompanion(state.companion);
  } catch (error) {
    process.stderr.write(`Nord Proxy uninstall cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(statePath, { force: true });
  }
}

function restoreSettings(state: CleanupState): void {
  if (!existsSync(state.settingsPath)) return;
  let text = readFileSync(state.settingsPath, 'utf8');
  const settings = parse(text) as Record<string, unknown>;
  if (settings['http.proxy'] === state.appliedProxy) {
    text = update(text, ['http.proxy'], state.originalProxy);
  }
  const next = parse(text) as Record<string, unknown>;
  if (next['http.proxySupport'] === state.appliedProxySupport) {
    text = update(text, ['http.proxySupport'], state.originalProxySupport);
  }
  writeFileSync(state.settingsPath, text, 'utf8');
}

function update(text: string, property: string[], backup: SettingBackup): string {
  const value = backup.present ? backup.value : undefined;
  return applyEdits(text, modify(text, property, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
  }));
}

function stopCompanion(info: CompanionInfo): void {
  const request = http.request({
    host: '127.0.0.1',
    port: info.controlPort,
    path: '/stop',
    method: 'POST',
    headers: { authorization: `Bearer ${info.token}` },
  }, response => response.resume());
  request.setTimeout(1_000, () => request.destroy());
  request.on('error', () => undefined);
  request.end();
}
