/**
 * Creates the toolbar overlay script to be injected into pages.
 */
export function createToolbarScript(): string {
  return `
(function() {
  // Don't inject twice
  if (document.getElementById('latchkey-recorder-toolbar')) return;

  // Create styles
  const style = document.createElement('style');
  style.textContent = \`
    #latchkey-recorder-toolbar {
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #1a1a1a;
      border-radius: 0 0 8px 8px;
      padding: 8px 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
      user-select: none;
    }

    #latchkey-recorder-toolbar * {
      box-sizing: border-box;
    }

    .latchkey-toolbar-button {
      background: #333;
      border: 1px solid #555;
      border-radius: 4px;
      color: #fff;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.15s, border-color 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .latchkey-toolbar-button:hover {
      background: #444;
      border-color: #666;
    }

    .latchkey-toolbar-button:active {
      background: #555;
    }

    .latchkey-toolbar-button.recording {
      background: #dc3545;
      border-color: #dc3545;
    }

    .latchkey-toolbar-button.recording:hover {
      background: #c82333;
      border-color: #bd2130;
    }

    .latchkey-toolbar-separator {
      width: 1px;
      height: 24px;
      background: #444;
      margin: 0 4px;
    }

    .latchkey-toolbar-status {
      color: #aaa;
      font-size: 11px;
      margin-left: 8px;
    }

    .latchkey-toolbar-status.recording {
      color: #ff6b6b;
    }

    .latchkey-recording-dot {
      width: 8px;
      height: 8px;
      background: #ff4444;
      border-radius: 50%;
      animation: latchkey-pulse 1.5s infinite;
    }

    @keyframes latchkey-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .latchkey-toolbar-gripper {
      color: #666;
      cursor: move;
      padding: 4px;
      display: flex;
      align-items: center;
    }

    .latchkey-toolbar-gripper svg {
      width: 16px;
      height: 16px;
    }
  \`;
  document.head.appendChild(style);

  // Create toolbar
  const toolbar = document.createElement('div');
  toolbar.id = 'latchkey-recorder-toolbar';

  // Gripper for dragging
  const gripper = document.createElement('div');
  gripper.className = 'latchkey-toolbar-gripper';
  gripper.innerHTML = \`
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M5 3h2v2H5zm0 4h2v2H5zm0 4h2v2H5zm4-8h2v2H9zm0 4h2v2H9zm0 4h2v2H9z"/>
    </svg>
  \`;
  toolbar.appendChild(gripper);

  // Recording indicator
  const recordingDot = document.createElement('div');
  recordingDot.className = 'latchkey-recording-dot';
  toolbar.appendChild(recordingDot);

  // Status text
  const status = document.createElement('span');
  status.className = 'latchkey-toolbar-status recording';
  status.textContent = 'Recording';
  toolbar.appendChild(status);

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'latchkey-toolbar-separator';
  toolbar.appendChild(sep1);

  // Record button (toggle)
  const recordBtn = document.createElement('button');
  recordBtn.className = 'latchkey-toolbar-button recording';
  recordBtn.innerHTML = \`
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="8" r="6"/>
    </svg>
    Record
  \`;
  recordBtn.title = 'Toggle recording';
  recordBtn.onclick = () => {
    window.__latchkeyToggleRecording && window.__latchkeyToggleRecording();
  };
  toolbar.appendChild(recordBtn);

  // Inspect button
  const inspectBtn = document.createElement('button');
  inspectBtn.className = 'latchkey-toolbar-button';
  inspectBtn.innerHTML = \`
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M1 3l1-1h12l1 1v6h-1V3H2v8h5v1H2l-1-1V3zm14.707 9.707L9 6v9.414l2.707-2.707h4zM10 13V8.414l3.293 3.293h-2L10 13z"/>
    </svg>
    Inspect
  \`;
  inspectBtn.title = 'Pick locator';
  inspectBtn.onclick = () => {
    window.__latchkeyInspect && window.__latchkeyInspect();
  };
  toolbar.appendChild(inspectBtn);

  // Separator
  const sep2 = document.createElement('div');
  sep2.className = 'latchkey-toolbar-separator';
  toolbar.appendChild(sep2);

  // Foo button (custom)
  const fooBtn = document.createElement('button');
  fooBtn.className = 'latchkey-toolbar-button';
  fooBtn.innerHTML = \`
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z"/>
    </svg>
    Foo
  \`;
  fooBtn.title = 'Foo button (placeholder)';
  fooBtn.onclick = () => {
    window.__latchkeyFoo && window.__latchkeyFoo();
  };
  toolbar.appendChild(fooBtn);

  document.body.appendChild(toolbar);

  // Make toolbar draggable
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  gripper.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = toolbar.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    toolbar.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    toolbar.style.left = x + 'px';
    toolbar.style.top = y + 'px';
    toolbar.style.transform = 'none';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
})();
`;
}
