/**
 * Creates the combined script injected into pages.
 * Contains both the interaction recorder and the toolbar UI.
 */
export function createInjectedScript(): string {
  return `
(function() {
  // ===== SHARED HELPER FUNCTIONS =====

  // Get the implicit ARIA role for an element
  function getImplicitRole(element) {
    const tag = element.tagName.toLowerCase();
    const type = element.type ? element.type.toLowerCase() : '';

    const roleMap = {
      'a': element.href ? 'link' : null,
      'article': 'article',
      'aside': 'complementary',
      'button': 'button',
      'dialog': 'dialog',
      'form': 'form',
      'h1': 'heading',
      'h2': 'heading',
      'h3': 'heading',
      'h4': 'heading',
      'h5': 'heading',
      'h6': 'heading',
      'header': 'banner',
      'footer': 'contentinfo',
      'img': 'img',
      'input': getInputRole(type),
      'li': 'listitem',
      'main': 'main',
      'nav': 'navigation',
      'ol': 'list',
      'option': 'option',
      'progress': 'progressbar',
      'section': 'region',
      'select': 'combobox',
      'table': 'table',
      'textarea': 'textbox',
      'ul': 'list',
    };

    return roleMap[tag] || null;
  }

  function getInputRole(type) {
    const inputRoles = {
      'button': 'button',
      'checkbox': 'checkbox',
      'email': 'textbox',
      'number': 'spinbutton',
      'radio': 'radio',
      'range': 'slider',
      'search': 'searchbox',
      'submit': 'button',
      'tel': 'textbox',
      'text': 'textbox',
      'url': 'textbox',
    };
    return inputRoles[type] || 'textbox';
  }

  // Get accessible name for an element
  function getAccessibleName(element) {
    // Check aria-label first
    if (element.getAttribute('aria-label')) {
      return element.getAttribute('aria-label');
    }

    // Check aria-labelledby
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) {
        return labelEl.textContent.trim();
      }
    }

    // For inputs, check associated label
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
      if (element.id) {
        const label = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
        if (label) {
          return label.textContent.trim();
        }
      }
      // Check for wrapping label
      const parentLabel = element.closest('label');
      if (parentLabel) {
        // Get text content excluding the input itself
        const clone = parentLabel.cloneNode(true);
        const inputs = clone.querySelectorAll('input, textarea, select');
        inputs.forEach(function(input) { input.remove(); });
        const text = clone.textContent.trim();
        if (text) return text;
      }
    }

    // For buttons and links, use text content
    const tag = element.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a') {
      const text = element.textContent.trim();
      if (text && text.length < 100) {
        return text;
      }
    }

    // Check title attribute
    if (element.title) {
      return element.title;
    }

    // For images, check alt
    if (tag === 'img' && element.alt) {
      return element.alt;
    }

    return null;
  }

  // Get element info for ancestry
  function getElementInfo(element) {
    const tag = element.tagName.toLowerCase();
    const info = { tag: tag };

    if (element.id) {
      info.id = element.id;
    }

    if (element.className && typeof element.className === 'string' && element.className.trim()) {
      info.className = element.className.trim();
    }

    if (element.name) {
      info.name = element.name;
    }

    // Get role (explicit or implicit)
    const explicitRole = element.getAttribute('role');
    const role = explicitRole || getImplicitRole(element);
    if (role) {
      info.role = role;
    }

    // Get accessible name
    const accessibleName = getAccessibleName(element);
    if (accessibleName) {
      info.accessibleName = accessibleName;
    }

    // For inputs, capture type
    if (tag === 'input' && element.type) {
      info.inputType = element.type.toLowerCase();
    }

    // Capture placeholder
    if (element.placeholder) {
      info.placeholder = element.placeholder;
    }

    return info;
  }

  // Get full ancestry from element to body
  function getAncestry(element) {
    const ancestry = [];
    let current = element;

    while (current && current !== document.body && current !== document.documentElement) {
      ancestry.push(getElementInfo(current));
      current = current.parentElement;
    }

    return ancestry;
  }

  // Check if element is part of our toolbar
  function isToolbarElement(element) {
    return element.closest && element.closest('#latchkey-recorder-toolbar');
  }

  // Global flag to track API key selection mode (set by toolbar, checked by recorder)
  window.__latchkeyIsSelectingApiKey = false;

  // ===== INTERACTION RECORDER =====

  // Don't inject recorder twice
  if (!window.__latchkeyRecorderInstalled) {
    window.__latchkeyRecorderInstalled = true;

    // Track clicks
    document.addEventListener('click', (event) => {
      const target = event.target;
      // Don't record clicks when selecting API key element
      if (!target || isToolbarElement(target) || window.__latchkeyIsSelectingApiKey) return;

      const ancestry = getAncestry(target);

      // Check if it's a checkbox or radio
      if (target.tagName === 'INPUT') {
        const inputType = target.type.toLowerCase();
        if (inputType === 'checkbox') {
          if (target.checked) {
            window.__latchkeyRecordAction && window.__latchkeyRecordAction({
              type: 'check',
              ancestry: ancestry
            });
          } else {
            window.__latchkeyRecordAction && window.__latchkeyRecordAction({
              type: 'uncheck',
              ancestry: ancestry
            });
          }
          return;
        }
      }

      window.__latchkeyRecordAction && window.__latchkeyRecordAction({
        type: 'click',
        ancestry: ancestry
      });
    }, true);

    // Track input/change for fill actions
    let lastInputElement = null;
    let lastInputValue = '';
    let lastInputAncestry = [];
    let inputTimeout = null;

    document.addEventListener('input', (event) => {
      const target = event.target;
      if (!target || isToolbarElement(target)) return;

      const tagName = target.tagName;
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable) {
        const inputType = target.type ? target.type.toLowerCase() : 'text';

        // Skip checkboxes and radios (handled by click)
        if (inputType === 'checkbox' || inputType === 'radio') return;

        lastInputElement = target;
        lastInputValue = target.value || target.innerText || '';
        lastInputAncestry = getAncestry(target);

        // Debounce the recording to capture the final value
        if (inputTimeout) clearTimeout(inputTimeout);
        inputTimeout = setTimeout(() => {
          if (lastInputElement) {
            window.__latchkeyRecordAction && window.__latchkeyRecordAction({
              type: 'fill',
              ancestry: lastInputAncestry,
              value: lastInputValue
            });
            lastInputElement = null;
            lastInputValue = '';
            lastInputAncestry = [];
          }
        }, 500);
      }
    }, true);

    // Track select changes
    document.addEventListener('change', (event) => {
      const target = event.target;
      if (!target || isToolbarElement(target)) return;

      if (target.tagName === 'SELECT') {
        const ancestry = getAncestry(target);
        const selectedValue = target.value;
        window.__latchkeyRecordAction && window.__latchkeyRecordAction({
          type: 'select',
          ancestry: ancestry,
          value: selectedValue
        });
      }
    }, true);

    // Track key presses (for special keys like Enter, Tab, etc.)
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!target || isToolbarElement(target)) return;

      // Only record special keys
      const specialKeys = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (specialKeys.includes(event.key)) {
        const ancestry = getAncestry(target);
        window.__latchkeyRecordAction && window.__latchkeyRecordAction({
          type: 'press',
          ancestry: ancestry,
          key: event.key
        });
      }
    }, true);
  }

  // ===== TOOLBAR UI =====

  function createAndInjectToolbar() {
    // Don't inject toolbar twice
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

    // "I've logged in" button - transitions from pre-login to post-login
    const loggedInBtn = document.createElement('button');
    loggedInBtn.className = 'latchkey-toolbar-button';
    loggedInBtn.innerHTML = \`
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
      </svg>
      I've logged in
    \`;
    loggedInBtn.title = 'Click after you have successfully logged in to start recording';
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
          status.textContent = 'Not recording (log in first)';
          loggedInBtn.disabled = false;
          break;
        case 'post-login':
          status.textContent = 'Recording';
          loggedInBtn.disabled = true;
          break;
      }
    }

    // Button handler
    loggedInBtn.onclick = () => {
      if (loggedInBtn.disabled) return;
      window.__latchkeyTransitionToPostLogin && window.__latchkeyTransitionToPostLogin();
      updatePhaseUI('post-login');
    };

    apiKeyBtn.onclick = () => {
      isSelectingApiKeyElement = !isSelectingApiKeyElement;
      window.__latchkeyIsSelectingApiKey = isSelectingApiKeyElement;
      apiKeyBtn.classList.toggle('active', isSelectingApiKeyElement);
      highlightOverlay.style.display = isSelectingApiKeyElement ? 'block' : 'none';
      if (isSelectingApiKeyElement) {
        status.textContent = 'Click the API key element...';
      } else {
        // Restore status based on current phase (async)
        if (window.__latchkeyGetPhase) {
          window.__latchkeyGetPhase().then(function(phase) {
            updatePhaseUI(phase || 'pre-login');
          });
        }
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
        window.__latchkeyIsSelectingApiKey = false;
        apiKeyBtn.classList.remove('active');
        highlightOverlay.style.display = 'none';

        // Capture ancestry for the element
        const ancestry = getAncestry(target);
        window.__latchkeyApiKeyElementSelected && window.__latchkeyApiKeyElementSelected(ancestry);

        // Restore status based on current phase (async)
        if (window.__latchkeyGetPhase) {
          window.__latchkeyGetPhase().then(function(phase) {
            updatePhaseUI(phase || 'pre-login');
          });
        }
      }
    }, true);

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

    // Initialize UI based on current phase (async because exposeFunction returns Promise)
    if (window.__latchkeyGetPhase) {
      window.__latchkeyGetPhase().then(function(phase) {
        updatePhaseUI(phase || 'pre-login');
      }).catch(function() {
        updatePhaseUI('pre-login');
      });
    } else {
      updatePhaseUI('pre-login');
    }
  }

  // Wait for DOM to be ready before creating toolbar
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
