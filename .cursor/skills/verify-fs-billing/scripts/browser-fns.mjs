// Callbacks drive.mjs hands to page.evaluate. Playwright serializes each one and runs it in
// the page, so they must not close over anything from this module.
export const dispatchVisibilityChange = () =>
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));

export const storedTheme = () => localStorage.getItem('fs-billing.theme');

export const documentScrollWidth = () => document.documentElement.scrollWidth;
