# Nord Proxy for VS Code

Gracefully restarts Visual Studio Code with `HTTP_PROXY` and `HTTPS_PROXY`
pointing to a local authenticated NordVPN proxy bridge. It does not change user
or workspace settings.

## Features

- Requests a normal VS Code application quit and restarts the same executable
  with proxy environment variables after shutdown completes.
- Reuses your normal VS Code user data and profiles.
- Adds standard proxy environment variables to the restarted process for child
  programs that honor them.
- Loads available countries and cities from NordVPN's live API.
- Changes location without restarting VS Code.
- Stores NordVPN service credentials in VS Code Secret Storage.
- Verifies the connection and displays the proxy exit IP.

## Setup

1. In Nord Account, open **Manual setup** and copy your **service username** and
   **service password**. These are different from your account email and
   password.
2. Run **Nord Proxy: Set NordVPN Service Credentials**.
3. Run **Nord Proxy: Change Proxy Location** if you want a specific location.
4. Save work in every VS Code window, then run **Nord Proxy: Restart VS Code
   with Proxy** and confirm the warning.
5. Optionally run **Nord Proxy: Verify Proxy and Show Exit IP**.
6. Save your work and run **Nord Proxy: Restart VS Code without Proxy** when you
   no longer need it.

The status-bar shield provides the same controls.

## What is proxied

The extension starts a local loopback bridge, starts an invisible Windows Script
Host worker, and invokes VS Code's normal application quit command. The worker
preserves the detached local proxy process, waits for the initiating extension
host to exit, sets the following environment for the new process tree, and
starts the same VS Code executable:

```bat
set HTTP_PROXY=http://127.0.0.1:<local-port>
set HTTPS_PROXY=http://127.0.0.1:<local-port>
set no_proxy=localhost,127.0.0.1
start "" "<current Code.exe path>"
```

No `--proxy-server` argument is used. Turning the proxy off repeats the restart
with these proxy environment variables removed.

VS Code activates the extension during startup. If shutdown terminated the
detached local bridge, the extension recreates it on the same port recorded in
`HTTP_PROXY` before reporting the proxy active.

While VS Code is running, a lightweight watchdog checks the local bridge every
five seconds and recreates it on the same port if the process disappears.

The extension does not write `http.proxy`, `http.proxySupport`, or terminal
environment values to user or workspace settings.

Each restart attempt uses its own timestamped `restart-*.log` and hidden worker
file in extension global storage, preventing a waiting worker from locking a
later attempt's files.

## Limitations

This mechanism is currently Windows-only. VS Code may prompt for unsaved work;
canceling that prompt prevents the restart worker from relaunching. Window
restoration follows your VS Code configuration.

VS Code does not give extensions a universal network-interception API. Programs
that ignore standard proxy variables, remote extension hosts, and software that
opens raw sockets directly can bypass it.
For strict process-wide leak prevention, use the NordVPN desktop application or
an operating-system VPN/firewall.

This independent project is not affiliated with or endorsed by NordVPN.

## Development

```powershell
npm.cmd install
npm.cmd test
npm.cmd run lint
npm.cmd run package:vsix
```
