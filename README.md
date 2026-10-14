# OpenCode Sidebar for VS Code

Embed OpenCode Web UI directly into your VS Code **Sidebar** (Activity Bar), completely separate from your terminal.

Unofficial, experimental extension. Not affiliated with the OpenCode project or SST.

![OpenCode Sidebar Icon](media/icon.png)

---

## ✨ Features

- **True Sidebar Integration**: Adds a dedicated OpenCode icon to your Activity Bar. You can also drag or move it to the **Secondary Side Bar (Right Side)** to chat beside your editor without touching your bottom Terminal.
- **One-Click Pairing**: Automatically runs `opencode pair` in the background and signs into the web session seamlessly.
- **Session Persistence**: Built-in lightweight local bridge ensures session cookies and tokens remain valid across tab switches and hidden states (`retainContextWhenHidden`).
- **Streaming**: The local bridge forwards HTTP streams and WebSocket connections to the original Web UI.
- **Privacy & Security**:
  - The bridge listens on `127.0.0.1`; automatic pairing uses the local CLI.
  - Sensitive tokens are redacted from normal extension logs.
  - Does not run `opencode pair --remote` automatically.
- **Fallback Controls**:
  - **Paste Pairing URL**: Easily connect manually if you run `opencode pair` on a custom port or remote tunnel.
  - **Open in Browser**: One click opens the full session in your default browser.
  - **Reload**: Refresh the UI at any time.

---

## 🚀 Getting Started

### 1. Requirements
Ensure you have the OpenCode CLI installed and running on your system:
```bash
opencode --version
```

### 2. Install the Extension
Install the generated `.vsix` file:
```bash
code --install-extension opencode-sidebar-0.3.2.vsix
```
*Or in VS Code:*
1. Open the Extensions view (`Ctrl+Shift+X`).
2. Click the `...` menu in the top right of the Extensions panel.
3. Select **Install from VSIX...** and choose `opencode-sidebar-0.3.2.vsix`.

### 3. Open OpenCode in the Sidebar
1. Click the **OpenCode** icon on the Activity Bar (left strip).
2. The extension will automatically connect to your running OpenCode service.
3. If prompt appears, click **Connect to OpenCode**.
4. To move it to the right sidebar: right-click the OpenCode header and choose **Move View -> Secondary Side Bar**.

---

## ⚙️ Settings

You can customize these in VS Code Settings (`Ctrl+,` -> search **OpenCode**):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `opencode.savedCookie` | `""` | Remembered session cookie. Saved globally in VS Code settings so all workspaces stay connected without pairing again. |
| `opencode.bridgePort` | `49375` | Local bridge port. Keeping a fixed port allows multiple VS Code windows and workspaces to share the same session, localStorage, and Web UI settings (e.g. Show agent). |
| `opencode.serverUrl` | `""` | Custom URL for OpenCode service. If blank, auto-detected from `opencode service status`. |
| `opencode.executablePath` | `"opencode"` | Command or absolute path to the OpenCode CLI binary. |
| `opencode.autoConnect` | `true` | Automatically pair and connect when the sidebar is opened. |

### Security and current limitations

- `opencode.savedCookie` is a credential stored as **plain text in User Settings** in this prototype. Do not commit, share, or sync it. Encrypted SecretStorage is not implemented yet.
- The authenticated loopback bridge currently has no client authentication. Use only on a trusted personal machine; other local clients may access it. Remote connections are not a supported/tested configuration.
- A second VS Code window may reuse the first window's bridge. If that window closes, reconnect from the remaining window. Shared bridge lifetime management is not implemented.
- Sync Workspace registers the folder with OpenCode; it does **not** automatically switch the Web UI's selected session or working directory.
- This version has automated bridge tests and a live authenticated API smoke test, not a full automated VS Code UI test.

### Recovering from an older version stuck in Auto-pairing

1. Update to 0.3.1, save your files, then reload **all** VS Code windows running OpenCode Sidebar. An old window may still own the shared bridge.
2. Open OpenCode Sidebar and use **OpenCode: Auto Pair (Refresh Auth)** if necessary.
3. If connection fails, run **OpenCode: Show Output Logs**. Do not share `savedCookie` or pairing URLs.

### Connected but sending prompts reports Authentication required

Update to 0.3.2 and reload VS Code. Older bridges forwarded the loopback browser Origin unchanged to the upstream OpenCode server. Cookie-authenticated POST requests failed the server's Origin checks even when GET health checks worked. Pairing again did not fix that mismatch. Version 0.3.2 validates the local browser Origin before translating it to the upstream Origin, and refuses to reuse an older incompatible bridge. It does not disable OpenCode authentication or change the server's CORS configuration.

---

## 🛠️ Development & Building

```bash
# Install dependencies
npm install

# Run TypeScript checks and compile
npm run compile

# Build bundle
npm run build

# Run unit tests
npm test

# Package .vsix
npm run package
```
