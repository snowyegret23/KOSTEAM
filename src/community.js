/**
 * KOSTEAM Community Script
 * Adds store page link to Steam Community app pages
 */

/**
 * Extract appId from URL pathname
 * @param {string} pathname - URL pathname
 * @returns {string|null} appId or null if not found
 */
function extractAppId(pathname) {
  const match = pathname.match(/^\/app\/(\d+)(?:\/|$)/);
  return match ? match[1] : null;
}

/**
 * Generate Steam store URL from appId
 * @param {string} appId - Steam app ID
 * @returns {string} Steam store URL
 */
function generateStoreUrl(appId) {
  return `https://store.steampowered.com/app/${appId}`;
}

/**
 * Check if store link already exists in container
 * @param {Element} container - Container element
 * @returns {boolean} true if link exists
 */
function hasExistingStoreLink(container, appId) {
  if (container.querySelector('.kosteam-store-link')) return true;
  return Array.from(container.querySelectorAll('a[href]')).some(link => {
    try {
      const url = new URL(link.href);
      return url.protocol === 'https:' &&
        url.hostname === 'store.steampowered.com' &&
        url.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1] === appId;
    } catch {
      return false;
    }
  });
}

/**
 * Create store link element
 * @param {string} storeUrl - Steam store URL
 * @param {string} appId - Steam app ID
 * @param {string} [text='상점으로 이동'] - Link text
 * @returns {HTMLAnchorElement} Store link element
 */
function createStoreLinkElement(storeUrl, appId, text = '상점으로 이동') {
  const link = document.createElement('a');
  link.href = storeUrl;
  link.className = 'btnv6_blue_hoverfade btn_medium kosteam-store-link';
  link.dataset.appid = appId;

  const span = document.createElement('span');
  span.textContent = text;
  link.appendChild(span);

  return link;
}

/**
 * Inject store link into container
 * @param {Element} container - Container element
 * @param {HTMLAnchorElement} link - Link element to inject
 */
function injectLink(container, link) {
  container.append(document.createTextNode(' '));
  container.append(link);
}

/**
 * Main injection function
 * @param {Document} doc - Document object
 * @param {string} pathname - URL pathname
 * @returns {boolean} true if injection succeeded or link already exists
 */
function injectStoreLink(doc, pathname) {
  const appId = extractAppId(pathname);
  if (!appId) return false;

  const otherSiteInfo = doc.querySelector('.apphub_OtherSiteInfo');
  if (!otherSiteInfo) return false;

  if (hasExistingStoreLink(otherSiteInfo, appId)) return true;

  const storeUrl = generateStoreUrl(appId);
  const link = createStoreLinkElement(storeUrl, appId);
  injectLink(otherSiteInfo, link);

  return true;
}

/**
 * Initialize with MutationObserver for dynamic content
 * @param {Document} doc - Document object
 * @param {string} pathname - URL pathname
 */
function initWithObserver(doc, pathname) {
  if (injectStoreLink(doc, pathname)) return;

  const observer = new MutationObserver(() => {
    if (injectStoreLink(doc, pathname)) {
      observer.disconnect();
    }
  });

  observer.observe(doc.body, {
    childList: true,
    subtree: true,
  });
  doc.defaultView?.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}

// Auto-execute in browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initWithObserver(document, window.location.pathname);
}
