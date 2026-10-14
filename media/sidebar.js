(function () {
  const vscode = acquireVsCodeApi();

  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const frameView = document.getElementById('frame-view');
  const cardView = document.getElementById('card-view');
  const cardContent = document.getElementById('card-content');
  const btnConnect = document.getElementById('btn-connect');
  const btnPaste = document.getElementById('btn-paste');
  const btnReload = document.getElementById('btn-reload');
  const btnBrowser = document.getElementById('btn-browser');
  const btnLogs = document.getElementById('btn-logs');
  const btnAutoPair = document.getElementById('btn-autopair');

  let currentIframeUrl = '';

  // Button Listeners
  if (btnAutoPair) {
    btnAutoPair.addEventListener('click', () => {
      vscode.postMessage({ command: 'autoPair' });
    });
  }

  if (btnConnect) {
    btnConnect.addEventListener('click', () => {
      vscode.postMessage({ command: 'connect' });
    });
  }

  if (btnPaste) {
    btnPaste.addEventListener('click', () => {
      vscode.postMessage({ command: 'pasteLink' });
    });
  }

  if (btnReload) {
    btnReload.addEventListener('click', () => {
      vscode.postMessage({ command: 'reload' });
    });
  }

  if (btnBrowser) {
    btnBrowser.addEventListener('click', () => {
      vscode.postMessage({ command: 'openBrowser' });
    });
  }

  if (btnLogs) {
    btnLogs.addEventListener('click', () => {
      vscode.postMessage({ command: 'showOutput' });
    });
  }

  // Handle messages sent from the extension to the webview
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'status':
        updateStatus(msg.status, msg.message, msg.iframeUrl);
        break;
      case 'reload':
        if (frameView && currentIframeUrl) {
          frameView.src = currentIframeUrl;
        }
        break;
    }
  });

  function updateStatus(status, message, iframeUrl) {
    // Update dot classes
    statusDot.className = 'status-dot ' + (status || 'disconnected');
    statusLabel.textContent = message || capitalize(status);

    if (status === 'connected' && iframeUrl) {
      currentIframeUrl = iframeUrl;
      cardView.classList.add('hidden');
      frameView.classList.add('active');
      if (frameView.src !== iframeUrl) {
        frameView.src = iframeUrl;
      }
    } else if (status === 'connecting') {
      frameView.classList.remove('active');
      cardView.classList.remove('hidden');
      cardContent.innerHTML = `
        <div class="spinner"></div>
        <div class="card-title">Connecting...</div>
        <div class="card-desc">${escapeHtml(message || 'Requesting pairing link from OpenCode')}</div>
      `;
    } else if (status === 'error') {
      frameView.classList.remove('active');
      cardView.classList.remove('hidden');
      cardContent.innerHTML = `
        <div class="logo-wrapper">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M3 3H21V21H3V3ZM5 5V19H19V5H5Z" fill="currentColor"/>
            <rect x="8" y="8" width="8" height="8" fill="currentColor" opacity="0.6"/>
          </svg>
        </div>
        <div class="card-title">Connection Failed</div>
        <button id="card-retry-btn" class="btn btn-primary">Try Again</button>
        <button id="card-paste-btn" class="btn btn-secondary">Paste Pairing Link</button>
        <div class="error-banner">${escapeHtml(message || 'Could not connect to OpenCode service.')}</div>
      `;
      document.getElementById('card-retry-btn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'connect' });
      });
      document.getElementById('card-paste-btn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'pasteLink' });
      });
    } else {
      // Disconnected
      frameView.classList.remove('active');
      cardView.classList.remove('hidden');
      cardContent.innerHTML = `
        <div class="logo-wrapper">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M3 3H21V21H3V3ZM5 5V19H19V5H5Z" fill="currentColor"/>
            <rect x="8" y="8" width="8" height="8" fill="currentColor" opacity="0.6"/>
          </svg>
        </div>
        <div class="card-title">OpenCode</div>
        <div class="card-desc">AI coding assistant Web UI running in your sidebar.</div>
        <button id="card-connect-btn" class="btn btn-primary">Connect to OpenCode</button>
        <button id="card-paste2-btn" class="btn btn-secondary">Paste Pairing Link</button>
      `;
      document.getElementById('card-connect-btn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'connect' });
      });
      document.getElementById('card-paste2-btn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'pasteLink' });
      });
    }
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Notify extension that webview is ready
  vscode.postMessage({ command: 'ready' });
})();
