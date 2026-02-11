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

  // Helper to generate all available selector variants for an element
  function generateSelectorVariants(element) {
    const variants = [];

    // Try data-testid
    if (element.dataset && element.dataset.testid) {
      variants.push({
        type: 'testid',
        selector: '[data-testid="' + element.dataset.testid + '"]'
      });
    }

    // Try id
    if (element.id) {
      variants.push({
        type: 'id',
        selector: '#' + CSS.escape(element.id)
      });
    }

    // Try class combination
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\\s+/).filter(c => c.length > 0);
      if (classes.length > 0) {
        const selector = '.' + classes.map(c => CSS.escape(c)).join('.');
        variants.push({
          type: 'class',
          selector: selector
        });
      }
    }

    // Try label (for form elements, buttons, links)
    const labelSelector = generateLabelSelector(element);
    if (labelSelector) {
      variants.push({
        type: 'label',
        selector: labelSelector
      });
    }

    // Always add a fallback using nth-child
    const fallbackSelector = generateFallbackSelector(element);
    if (fallbackSelector) {
      variants.push({
        type: 'fallback',
        selector: fallbackSelector
      });
    }

    return variants;
  }

  // Generate a label-based selector (text content, aria-label, placeholder, etc.)
  function generateLabelSelector(element) {
    const tagName = element.tagName.toLowerCase();

    // For buttons and links, use text content
    if (tagName === 'button' || tagName === 'a') {
      const text = element.innerText.trim();
      if (text && text.length < 50) {
        return tagName + ':has-text("' + text.replace(/"/g, '\\\\"') + '")';
      }
    }

    // For inputs, try placeholder or aria-label
    if (tagName === 'input' || tagName === 'textarea') {
      if (element.placeholder) {
        return tagName + '[placeholder="' + element.placeholder.replace(/"/g, '\\\\"') + '"]';
      }
      if (element.getAttribute('aria-label')) {
        return tagName + '[aria-label="' + element.getAttribute('aria-label').replace(/"/g, '\\\\"') + '"]';
      }
      // Try associated label
      if (element.id) {
        const label = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
        if (label && label.innerText) {
          return 'label:has-text("' + label.innerText.trim().replace(/"/g, '\\\\"') + '") >> ' + tagName;
        }
      }
    }

    // For any element, try aria-label
    if (element.getAttribute('aria-label')) {
      return tagName + '[aria-label="' + element.getAttribute('aria-label').replace(/"/g, '\\\\"') + '"]';
    }

    // For any element, try title
    if (element.title) {
      return tagName + '[title="' + element.title.replace(/"/g, '\\\\"') + '"]';
    }

    return null;
  }

  // Generate a fallback selector using tag + nth-child
  function generateFallbackSelector(element) {
    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(element);
      const tagName = element.tagName.toLowerCase();
      const parentSelector = parent === document.body ? 'body' : generateFallbackSelector(parent);
      if (parentSelector) {
        return parentSelector + ' > ' + tagName + ':nth-child(' + (index + 1) + ')';
      }
      return tagName + ':nth-child(' + (index + 1) + ')';
    }
    return element.tagName.toLowerCase();
  }

  // Get the primary (best) selector from variants
  function getPrimarySelector(variants) {
    // Prefer testid > id > class > label > fallback
    const priority = ['testid', 'id', 'class', 'label', 'fallback'];
    for (const type of priority) {
      const variant = variants.find(v => v.type === type);
      if (variant) return variant.selector;
    }
    return variants[0]?.selector || '';
  }

  // Check if element is part of our toolbar
  function isToolbarElement(element) {
    return element.closest && element.closest('#latchkey-recorder-toolbar');
  }

  // Track clicks
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

    const variants = generateSelectorVariants(target);
    const selector = getPrimarySelector(variants);

    // Check if it's a checkbox or radio
    if (target.tagName === 'INPUT') {
      const inputType = target.type.toLowerCase();
      if (inputType === 'checkbox') {
        if (target.checked) {
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'check',
            selector: selector,
            selectorVariants: variants
          });
        } else {
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'uncheck',
            selector: selector,
            selectorVariants: variants
          });
        }
        return;
      }
    }

    window.__latchkeyRecordAction && window.__latchkeyRecordAction({
      type: 'click',
      selector: selector,
      selectorVariants: variants
    });
  }, true);

  // Track input/change for fill actions
  let lastInputElement = null;
  let lastInputValue = '';
  let lastInputVariants = [];
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
      lastInputVariants = generateSelectorVariants(target);

      // Debounce the recording to capture the final value
      if (inputTimeout) clearTimeout(inputTimeout);
      inputTimeout = setTimeout(() => {
        if (lastInputElement) {
          const selector = getPrimarySelector(lastInputVariants);
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'fill',
            selector: selector,
            selectorVariants: lastInputVariants,
            value: lastInputValue
          });
          lastInputElement = null;
          lastInputValue = '';
          lastInputVariants = [];
        }
      }, 500);
    }
  }, true);

  // Track select changes
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

    if (target.tagName === 'SELECT') {
      const variants = generateSelectorVariants(target);
      const selector = getPrimarySelector(variants);
      const selectedValue = target.value;
      window.__latchkeyRecordAction && window.__latchkeyRecordAction({
        type: 'select',
        selector: selector,
        selectorVariants: variants,
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
      const variants = generateSelectorVariants(target);
      const selector = getPrimarySelector(variants);
      window.__latchkeyRecordAction && window.__latchkeyRecordAction({
        type: 'press',
        selector: selector,
        selectorVariants: variants,
        key: event.key
      });
    }
  }, true);
})();
`;
}
