# Change Log

## 0.0.1

- Replaced persistent user-setting changes with an isolated, proxy-protected
  VS Code window and detached in-memory companion process.
- Added authenticated NordVPN HTTPS proxy connections through a loopback proxy.
- Locations and recommended proxy servers now come from NordVPN's live
  `proxy_ssl` server APIs rather than a hardcoded list.
- Added secure credential storage, connect/disconnect, location switching,
  connection testing, automatic restore, and a status-bar controller.
