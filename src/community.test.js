/**
 * @jest-environment jsdom
 */

import {
  extractAppId,
  generateStoreUrl,
  hasExistingStoreLink,
  createStoreLinkElement,
  injectLink,
  injectStoreLink,
} from './community.js';

describe('extractAppId', () => {
  it('should extract appId from valid pathname', () => {
    expect(extractAppId('/app/1693980')).toBe('1693980');
    expect(extractAppId('/app/12345/some/path')).toBe('12345');
  });

  it('should return null for invalid pathname', () => {
    expect(extractAppId('/games/1693980')).toBeNull();
    expect(extractAppId('/app/')).toBeNull();
    expect(extractAppId('/')).toBeNull();
    expect(extractAppId('')).toBeNull();
  });

  it('should handle edge cases', () => {
    expect(extractAppId('/app/0')).toBe('0');
    expect(extractAppId('/app/999999999')).toBe('999999999');
  });
});

describe('generateStoreUrl', () => {
  it('should generate correct Steam store URL', () => {
    expect(generateStoreUrl('1693980')).toBe('https://store.steampowered.com/app/1693980');
    expect(generateStoreUrl('12345')).toBe('https://store.steampowered.com/app/12345');
  });
});

describe('hasExistingStoreLink', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should return true if kosteam-store-link exists', () => {
    const container = document.createElement('div');
    const link = document.createElement('a');
    link.className = 'kosteam-store-link';
    container.appendChild(link);

    expect(hasExistingStoreLink(container)).toBe(true);
  });

  it('should return true if store.steampowered.com link exists', () => {
    const container = document.createElement('div');
    const link = document.createElement('a');
    link.href = 'https://store.steampowered.com/app/12345';
    container.appendChild(link);

    expect(hasExistingStoreLink(container)).toBe(true);
  });

  it('should return false if no store link exists', () => {
    const container = document.createElement('div');
    const link = document.createElement('a');
    link.href = 'https://example.com';
    container.appendChild(link);

    expect(hasExistingStoreLink(container)).toBe(false);
  });

  it('should return false for empty container', () => {
    const container = document.createElement('div');
    expect(hasExistingStoreLink(container)).toBe(false);
  });
});

describe('createStoreLinkElement', () => {
  it('should create link with correct attributes', () => {
    const link = createStoreLinkElement('https://store.steampowered.com/app/12345', '12345');

    expect(link.tagName).toBe('A');
    expect(link.href).toBe('https://store.steampowered.com/app/12345');
    expect(link.className).toBe('btnv6_blue_hoverfade btn_medium kosteam-store-link');
    expect(link.dataset.appid).toBe('12345');
  });

  it('should create link with default text', () => {
    const link = createStoreLinkElement('https://store.steampowered.com/app/12345', '12345');
    const span = link.querySelector('span');

    expect(span).not.toBeNull();
    expect(span.textContent).toBe('상점으로 이동');
  });

  it('should create link with custom text', () => {
    const link = createStoreLinkElement('https://store.steampowered.com/app/12345', '12345', 'Store');
    const span = link.querySelector('span');

    expect(span.textContent).toBe('Store');
  });
});

describe('injectLink', () => {
  it('should append link to container with space', () => {
    const container = document.createElement('div');
    const existingLink = document.createElement('a');
    existingLink.textContent = 'Existing';
    container.appendChild(existingLink);

    const newLink = document.createElement('a');
    newLink.textContent = 'New';

    injectLink(container, newLink);

    expect(container.childNodes.length).toBe(3);
    expect(container.childNodes[1].nodeType).toBe(Node.TEXT_NODE);
    expect(container.childNodes[1].textContent).toBe(' ');
    expect(container.childNodes[2]).toBe(newLink);
  });
});

describe('injectStoreLink', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should return false if appId not in pathname', () => {
    expect(injectStoreLink(document, '/invalid/path')).toBe(false);
  });

  it('should return false if container not found', () => {
    expect(injectStoreLink(document, '/app/12345')).toBe(false);
  });

  it('should inject link when container exists', () => {
    const container = document.createElement('div');
    container.className = 'apphub_OtherSiteInfo';
    document.body.appendChild(container);

    const result = injectStoreLink(document, '/app/12345');

    expect(result).toBe(true);
    expect(container.querySelector('.kosteam-store-link')).not.toBeNull();
    expect(container.querySelector('a').href).toBe('https://store.steampowered.com/app/12345');
  });

  it('should return true without duplicating if link already exists', () => {
    const container = document.createElement('div');
    container.className = 'apphub_OtherSiteInfo';
    const existingLink = document.createElement('a');
    existingLink.className = 'kosteam-store-link';
    container.appendChild(existingLink);
    document.body.appendChild(container);

    const result = injectStoreLink(document, '/app/12345');

    expect(result).toBe(true);
    expect(container.querySelectorAll('.kosteam-store-link').length).toBe(1);
  });

  it('should return true if external store link already exists', () => {
    const container = document.createElement('div');
    container.className = 'apphub_OtherSiteInfo';
    const existingLink = document.createElement('a');
    existingLink.href = 'https://store.steampowered.com/app/99999';
    container.appendChild(existingLink);
    document.body.appendChild(container);

    const result = injectStoreLink(document, '/app/12345');

    expect(result).toBe(true);
    expect(container.querySelectorAll('a').length).toBe(1);
  });
});
