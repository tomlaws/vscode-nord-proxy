# Nord Proxy for VS Code

Routes VS Code proxy-aware traffic through NordVPN's authenticated proxy
servers. The extension discovers locations through NordVPN's live API and
applies its local authenticated bridge through VS Code's user-level
`http.proxy` setting.

## Features

- Applies the proxy immediately without restarting VS Code.
- Restarts the extension host after enabling or disabling so extensions reload
  with the updated user proxy configuration.
- Loads available countries and cities from NordVPN's live API.
- Changes proxy location without restarting VS Code.
- Stores NordVPN service credentials in VS Code Secret Storage.
- Preserves and restores pre-existing user proxy settings.
- Cleans owned settings when disabled, deactivated, or uninstalled.
- Verifies the connection and displays the proxy exit IP.

## Setup

1. In Nord Account, open **Manual setup** and copy your **service username** and
   **service password**. These differ from your account email and password.
2. Run **Nord Proxy: Set NordVPN Service Credentials**.
3. Run **Nord Proxy: Change Proxy Location** if desired.
4. Run **Nord Proxy: Enable Proxy**.
5. Optionally run **Nord Proxy: Verify Proxy and Show Exit IP**.
6. Run **Nord Proxy: Disable Proxy** when finished.

The status-bar shield provides the same controls.

## Settings lifecycle

When enabled, the extension starts a loopback authenticated proxy bridge and
sets these user-level VS Code settings:

```jsonc
{
  "http.proxy": "http://127.0.0.1:<local-port>",
  "http.proxySupport": "override"
}
```

Before doing so, it records whether each setting existed and its exact previous
value. Disabling restores those values. A setting is restored only if it still
contains the value written by Nord Proxy, so a later manual user change is not
overwritten.

VS Code calls the extension's asynchronous deactivation hook when the extension
host shuts down or the extension is disabled. The extension restores the
settings and stops the bridge there. If proxy mode was left enabled during a
normal shutdown, it is reapplied on the next startup.

The package also registers VS Code's official `vscode:uninstall` hook. Its
standalone cleanup script edits the applicable user/profile `settings.json`
using a JSON-with-comments parser, preserving comments and unrelated settings.
This provides fallback cleanup if the extension is uninstalled while its proxy
setting is still owned.

The extension does not write workspace settings, terminal environment
variables, process environment variables, or proxy command-line arguments. It
does not restart VS Code.

After an explicit enable or disable, only the extension host is restarted. The
main VS Code window and editor state remain open. Intentional extension-host
restarts skip normal shutdown cleanup once, preventing the newly applied proxy
setting from being immediately restored.

## Reliability and limitations

A lightweight watchdog restores the local bridge on the same port if that
process exits. Transient Nord tunnel-establishment failures are retried, and a
dropped tunnel affects only its request rather than terminating the bridge.

VS Code does not expose a universal network-interception API. Software that
ignores `http.proxy`, remote extension hosts, and programs opening raw sockets
can bypass it. For strict process-wide leak prevention, use the NordVPN desktop
application or operating-system VPN/firewall controls.

This independent project is not affiliated with or endorsed by NordVPN.

## Development

```powershell
npm.cmd install
npm.cmd test
npm.cmd run lint
npm.cmd run package:vsix
```
