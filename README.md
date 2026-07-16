# Nord Proxy for VS Code

Opens an isolated VS Code window whose proxy-aware HTTP/HTTPS traffic is routed
through NordVPN's authenticated HTTPS proxy service. The extension discovers
locations and recommended servers through NordVPN's live API.

## Motivation
I wanted to use Codex in VSCode, but OpenAI's API is blocked in my country. I have a NordVPN subscription but I don't want to route all my traffic through the VPN, so I wrote this extension to route VS Code's traffic through NordVPN's proxy service. Plus, proxy is faster than VPN (though it doesn't encrypt traffic). This extension is not affiliated with or endorsed by NordVPN.

It may also be useful if you are not allowed to use VPNs at work or school, but you are allowed to use HTTPS proxies.

## Setup and use

1. In Nord Account, open **Manual setup** and copy your **service username** and
   **service password**. These differ from your account email and password.
2. Run **Nord Proxy: Set NordVPN Service Credentials**. Credentials are kept in
   VS Code Secret Storage and passed to the companion over private process IPC;
   they are not written to settings, command arguments, environment variables,
   or companion files.
3. Run **Nord Proxy: Switch Proxy Location**.
4. Run **Nord Proxy: Open Proxy-Protected Window**.
5. In either window, run **Nord Proxy: Test Connection** to display the egress IP.

## How isolation works

The extension does not modify `http.proxy`, user settings, workspace settings,
or terminal settings. Instead it:

- starts a detached loopback HTTP-to-NordVPN bridge;
- obtains a current `proxy_ssl` server from NordVPN for the selected location;
- launches a separate VS Code instance with isolated user data;
- supplies Chromium's `--proxy-server` startup option;
- supplies standard proxy environment variables to that process;
- keeps NordVPN service credentials only in the companion's memory;
- supports live location switching for new connections.

By default, the companion selects a free loopback port automatically. A fixed
port can be configured with `nordProxy.localPort`; if it is occupied, the
companion safely falls back to another free port.

The original VS Code window remains unchanged. Use **Nord Proxy: Stop Proxy
Companion** and close the protected window to stop using the proxy.

## Scope limitation

VS Code does not expose a universal network-interception API. Chromium traffic
and programs honoring standard proxy variables use the bridge, but software
that deliberately opens raw sockets can bypass it. For strict leak prevention,
use the NordVPN desktop app, an operating-system VPN, or firewall enforcement.

This independent project is not affiliated with or endorsed by NordVPN.

## Development

Run `npm install`, then press `F5`. Use `npm test` and `npm run lint` for local
verification.
