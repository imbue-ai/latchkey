/**
 * Creates the recorder script that captures user interactions.
 * This script is injected into every page and listens for clicks, inputs, etc.
 */
export function createRecorderScript(): string {
  return `
(function() {
  // Don't inject twice
  if (window.__latchkeyRecorderInstalled) return;
  window.__latchkeyRecorderInstalled = true;

  // Get the implicit ARIA role for an element
  function getImplicitRole(element) {
    const tag = element.tagName.toLowerCase();
    const type = element.type ? element.type.toLowerCase() : '';

    // Common implicit roles
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

  // Track clicks
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

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
})();
`;
}
