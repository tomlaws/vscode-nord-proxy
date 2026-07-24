# Change Log

## Unreleased

- Replaced process restarts, launch arguments, and proxy environment injection
  with user-level `http.proxy` and `http.proxySupport` settings.
- Preserves exact previous user values and restores only settings still owned by
  Nord Proxy.
- Cleans settings and stops the bridge during extension deactivation.
- Restarts the extension host after explicit proxy setting changes, while
  preserving the newly selected state across that intentional restart.
- Added the official `vscode:uninstall` lifecycle hook with JSONC-safe fallback
  cleanup for user/profile settings.
- Monitors the local bridge while VS Code is running and automatically restores
  it on the same port if its process exits.
- Records companion lifecycle diagnostics in extension global storage.
- Prevents transient upstream socket resets from terminating the companion and
  retries tunnel establishment up to three times.
- Removed the obsolete WScript restart worker, restart logs, Chromium proxy
  arguments, and environment-variable mechanisms.

## 0.0.2

- Does not persist proxy values in user or workspace settings.
- Removes proxy settings previously written by version 0.0.2 on first startup.
- Uses a dynamically allocated loopback port, with fallback for occupied fixed
  ports.
- Clarifies that raw sockets and software ignoring proxy configuration are not
  intercepted.

## 0.0.1

- Added authenticated NordVPN HTTPS proxy connections through a local bridge.
- Added live country, city, and recommended-server discovery.
- Added secure credential storage, location switching, exit-IP verification,
  and status-bar controls.
