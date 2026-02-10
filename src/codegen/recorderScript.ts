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

  // Helper to generate a simple selector for an element
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

    // Try tag + nth-child
    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(element);
      const tagName = element.tagName.toLowerCase();
      const parentSelector = parent === document.body ? 'body' : generateSelector(parent);
      return parentSelector + ' > ' + tagName + ':nth-child(' + (index + 1) + ')';
    }

    // Fallback to tag name
    return element.tagName.toLowerCase();
  }

  // Check if element is part of our toolbar
  function isToolbarElement(element) {
    return element.closest && element.closest('#latchkey-recorder-toolbar');
  }

  // Track clicks
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

    const selector = generateSelector(target);

    // Check if it's a checkbox or radio
    if (target.tagName === 'INPUT') {
      const inputType = target.type.toLowerCase();
      if (inputType === 'checkbox') {
        if (target.checked) {
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'check',
            selector: selector
          });
        } else {
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'uncheck',
            selector: selector
          });
        }
        return;
      }
    }

    window.__latchkeyRecordAction && window.__latchkeyRecordAction({
      type: 'click',
      selector: selector
    });
  }, true);

  // Track input/change for fill actions
  let lastInputElement = null;
  let lastInputValue = '';
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

      // Debounce the recording to capture the final value
      if (inputTimeout) clearTimeout(inputTimeout);
      inputTimeout = setTimeout(() => {
        if (lastInputElement) {
          const selector = generateSelector(lastInputElement);
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'fill',
            selector: selector,
            value: lastInputValue
          });
          lastInputElement = null;
          lastInputValue = '';
        }
      }, 500);
    }
  }, true);

  // Track select changes
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

    if (target.tagName === 'SELECT') {
      const selector = generateSelector(target);
      const selectedValue = target.value;
      window.__latchkeyRecordAction && window.__latchkeyRecordAction({
        type: 'select',
        selector: selector,
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
      const selector = generateSelector(target);
      window.__latchkeyRecordAction && window.__latchkeyRecordAction({
        type: 'press',
        selector: selector,
        key: event.key
      });
    }
  }, true);
})();
`;
}
