/**
 * Creates the toolbar overlay script to be injected into pages.
 */
export function createToolbarScript(): string {
  return `
(function() {
  // Don't inject twice
  if (document.getElementById('latchkey-recorder-toolbar')) return;

  function createAndInjectToolbar() {
    // Don't inject twice (in case of race condition)
    if (document.getElementById('latchkey-recorder-toolbar')) return;

    // State
    let isSelectingApiKeyElement = false;
    let highlightOverlay = null;

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
        white-space: nowrap;
      }

      .latchkey-toolbar-button:hover {
        background: #444;
        border-color: #666;
      }

      .latchkey-toolbar-button:active {
        background: #555;
      }

      .latchkey-toolbar-button.active {
        background: #2563eb;
        border-color: #3b82f6;
      }

      .latchkey-toolbar-button.active:hover {
        background: #1d4ed8;
        border-color: #2563eb;
      }

      .latchkey-toolbar-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
        min-width: 140px;
      }

      .latchkey-toolbar-status.pre-login {
        color: #ff6b6b;
      }

      .latchkey-toolbar-status.logging-in {
        color: #fbbf24;
      }

      .latchkey-toolbar-status.post-login {
        color: #4ade80;
      }

      .latchkey-phase-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .latchkey-phase-dot.pre-login {
        background: #ff4444;
        animation: latchkey-pulse 1.5s infinite;
      }

      .latchkey-phase-dot.logging-in {
        background: #fbbf24;
        animation: latchkey-pulse 1s infinite;
      }

      .latchkey-phase-dot.post-login {
        background: #4ade80;
        animation: none;
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

      #latchkey-highlight-overlay {
        position: fixed;
        pointer-events: none;
        border: 2px solid #22c55e;
        background: rgba(34, 197, 94, 0.1);
        z-index: 2147483646;
        transition: all 0.05s ease-out;
      }
    \`;

    // Add styles to head (or documentElement if head doesn't exist)
    (document.head || document.documentElement).appendChild(style);

    // Create highlight overlay for element picker
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = 'latchkey-highlight-overlay';
    highlightOverlay.style.display = 'none';
    document.body.appendChild(highlightOverlay);

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

    // Phase indicator dot
    const phaseDot = document.createElement('div');
    phaseDot.className = 'latchkey-phase-dot pre-login';
    toolbar.appendChild(phaseDot);

    // Status text
    const status = document.createElement('span');
    status.className = 'latchkey-toolbar-status pre-login';
    status.textContent = 'Recording (pre-login)';
    toolbar.appendChild(status);

    // Separator
    const sep1 = document.createElement('div');
    sep1.className = 'latchkey-toolbar-separator';
    toolbar.appendChild(sep1);

    // "Logging In" button - transitions from pre-login to logging-in
    const loggingInBtn = document.createElement('button');
    loggingInBtn.className = 'latchkey-toolbar-button';
    loggingInBtn.innerHTML = \`
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z"/>
      </svg>
      Logging In
    \`;
    loggingInBtn.title = 'Click when you are about to log in';
    toolbar.appendChild(loggingInBtn);

    // "Logged In" button - transitions from logging-in to post-login
    const loggedInBtn = document.createElement('button');
    loggedInBtn.className = 'latchkey-toolbar-button';
    loggedInBtn.disabled = true;
    loggedInBtn.innerHTML = \`
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
      </svg>
      Logged In
    \`;
    loggedInBtn.title = 'Click when you have successfully logged in';
    toolbar.appendChild(loggedInBtn);

    // Separator
    const sep2 = document.createElement('div');
    sep2.className = 'latchkey-toolbar-separator';
    toolbar.appendChild(sep2);

    // "Select API Key Element" button
    const apiKeyBtn = document.createElement('button');
    apiKeyBtn.className = 'latchkey-toolbar-button';
    apiKeyBtn.innerHTML = \`
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M1 3l1-1h12l1 1v6h-1V3H2v8h5v1H2l-1-1V3zm14.707 9.707L9 6v9.414l2.707-2.707h4zM10 13V8.414l3.293 3.293h-2L10 13z"/>
      </svg>
      Select API Key Element
    \`;
    apiKeyBtn.title = 'Click to select the element containing the API key';
    toolbar.appendChild(apiKeyBtn);

    // Append toolbar to body
    document.body.appendChild(toolbar);

    // Function to update UI based on current phase
    function updatePhaseUI(phase) {
      // Update dot
      phaseDot.className = 'latchkey-phase-dot ' + phase;

      // Update status text
      status.className = 'latchkey-toolbar-status ' + phase;
      switch (phase) {
        case 'pre-login':
          status.textContent = 'Recording (pre-login)';
          loggingInBtn.disabled = false;
          loggedInBtn.disabled = true;
          break;
        case 'logging-in':
          status.textContent = 'Logging in...';
          loggingInBtn.disabled = true;
          loggedInBtn.disabled = false;
          break;
        case 'post-login':
          status.textContent = 'Logged in (not recording)';
          loggingInBtn.disabled = true;
          loggedInBtn.disabled = true;
          break;
      }
    }

    // Button handlers
    loggingInBtn.onclick = () => {
      if (loggingInBtn.disabled) return;
      window.__latchkeyTransitionToLoggingIn && window.__latchkeyTransitionToLoggingIn();
      updatePhaseUI('logging-in');
    };

    loggedInBtn.onclick = () => {
      if (loggedInBtn.disabled) return;
      window.__latchkeyTransitionToPostLogin && window.__latchkeyTransitionToPostLogin();
      updatePhaseUI('post-login');
    };

    apiKeyBtn.onclick = () => {
      isSelectingApiKeyElement = !isSelectingApiKeyElement;
      apiKeyBtn.classList.toggle('active', isSelectingApiKeyElement);
      highlightOverlay.style.display = isSelectingApiKeyElement ? 'block' : 'none';
      if (isSelectingApiKeyElement) {
        status.textContent = 'Click the API key element...';
      } else {
        // Restore status based on current phase
        const phase = window.__latchkeyGetPhase ? window.__latchkeyGetPhase() : 'pre-login';
        updatePhaseUI(phase);
      }
    };

    // Element picker: highlight on mousemove
    document.addEventListener('mousemove', (e) => {
      if (!isSelectingApiKeyElement) return;

      const target = e.target;
      if (!target || target === highlightOverlay || toolbar.contains(target)) {
        highlightOverlay.style.display = 'none';
        return;
      }

      const rect = target.getBoundingClientRect();
      highlightOverlay.style.display = 'block';
      highlightOverlay.style.left = rect.left + 'px';
      highlightOverlay.style.top = rect.top + 'px';
      highlightOverlay.style.width = rect.width + 'px';
      highlightOverlay.style.height = rect.height + 'px';
    }, true);

    // Element picker: select on click
    document.addEventListener('click', (e) => {
      // Handle API key element selection
      if (isSelectingApiKeyElement) {
        const target = e.target;
        if (!target || target === highlightOverlay || toolbar.contains(target)) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        isSelectingApiKeyElement = false;
        apiKeyBtn.classList.remove('active');
        highlightOverlay.style.display = 'none';

        // Generate selector for the element
        const selector = generateSelector(target);
        window.__latchkeyApiKeyElementSelected && window.__latchkeyApiKeyElementSelected(selector);

        // Restore status based on current phase
        const phase = window.__latchkeyGetPhase ? window.__latchkeyGetPhase() : 'pre-login';
        updatePhaseUI(phase);
      }
    }, true);

    // Generate a CSS selector for an element
    function generateSelector(element) {
      // Try data-testid first
      if (element.dataset && element.dataset.testid) {
        return '[data-testid="' + element.dataset.testid + '"]';
      }

      // Try id
      if (element.id) {
        return '#' + CSS.escape(element.id);
      }

      // Try unique class combination
      if (element.className && typeof element.className === 'string') {
        const classes = element.className.trim().split(/\\s+/).filter(c => c.length > 0);
        if (classes.length > 0) {
          const selector = '.' + classes.map(c => CSS.escape(c)).join('.');
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }
      }

      // Fall back to tag + nth-child
      const parent = element.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const index = siblings.indexOf(element) + 1;
        const parentSelector = parent === document.body ? 'body' : generateSelector(parent);
        return parentSelector + ' > ' + element.tagName.toLowerCase() + ':nth-child(' + index + ')';
      }

      return element.tagName.toLowerCase();
    }

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

    // Expose function to update UI when phase changes externally
    window.__latchkeyUpdatePhase = updatePhaseUI;

    // Initialize UI based on current phase
    const initialPhase = window.__latchkeyGetPhase ? window.__latchkeyGetPhase() : 'pre-login';
    updatePhaseUI(initialPhase);
  }

  // Wait for DOM to be ready
  if (document.body) {
    createAndInjectToolbar();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createAndInjectToolbar);
  } else {
    // readyState is 'interactive' or 'complete' but body doesn't exist yet
    // Use a short timeout to wait for body
    setTimeout(createAndInjectToolbar, 0);
  }
})();
`;
}
