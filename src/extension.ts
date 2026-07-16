import * as vscode from 'vscode';
import { ProxyController } from './proxyController';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new ProxyController(context);
  context.subscriptions.push(controller);

  const commands: Array<[string, () => Promise<void>]> = [
    ['nord-proxy.setCredentials', () => controller.setCredentials()],
    ['nord-proxy.selectLocation', () => controller.selectLocation()],
    ['nord-proxy.connect', () => controller.connect()],
    ['nord-proxy.disconnect', () => controller.disconnect()],
    ['nord-proxy.testConnection', () => controller.testConnection()],
    ['nord-proxy.showStatus', () => controller.showStatus()],
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

  await controller.restore();
}
