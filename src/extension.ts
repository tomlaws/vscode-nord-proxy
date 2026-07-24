import * as vscode from 'vscode';
import { ProxyController } from './proxyController';

let controller: ProxyController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const instance = new ProxyController(context);
  controller = instance;
  context.subscriptions.push(instance);

  const commands: Array<[string, () => Promise<void>]> = [
    ['nord-proxy.setCredentials', () => instance.setCredentials()],
    ['nord-proxy.selectLocation', () => instance.selectLocation()],
    ['nord-proxy.connect', () => instance.connect()],
    ['nord-proxy.disconnect', () => instance.disconnect()],
    ['nord-proxy.testConnection', () => instance.testConnection()],
    ['nord-proxy.showStatus', () => instance.showStatus()],
  ];

  for (const [id, callback] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await callback(); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Nord Proxy: ${detail}`);
      }
    }));
  }

  await instance.restore();
}

export async function deactivate(): Promise<void> {
  await controller?.deactivate();
  controller = undefined;
}
