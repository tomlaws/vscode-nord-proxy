# Change Log

## Unreleased

- On Windows, enabling gracefully quits VS Code and relaunches the same
  executable with `HTTP_PROXY`, `HTTPS_PROXY`, and `no_proxy` in its process
  environment.
- Removed the `--proxy-server`, `--use-env-proxy`, `ALL_PROXY`,
  `NODE_USE_ENV_PROXY`, and lowercase proxy-variable launch mechanisms.
- Disabling gracefully restarts VS Code with the proxy environment removed.
- Restores a proxy bridge terminated during VS Code shutdown on the same
  loopback port inherited by the relaunched process.
- Monitors the local bridge while VS Code is running and automatically restores
  it on the same port if its process exits.
- Records companion lifecycle diagnostics in extension global storage.
- Preserves the detached local proxy process while VS Code exits so the local
  proxy port remains available to the relaunched process.
- Uses background Windows Script Host instead of PowerShell, avoiding a visible
  console window.
- Uses unique restart worker and log files so canceled or waiting restarts cannot
  cause `EBUSY` file-lock errors.
- Removed obsolete extension-host injection and monkeypatch experiments.

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
