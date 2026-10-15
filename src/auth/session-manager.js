const fs = require('fs');
const { Cookie, CookieJar } = require('tough-cookie');
const Defaults = require('../Defaults');

/**
 * Write a file that only the current user can read: cookies.json and headers.json hold a
 * live login (session cookies, CSRF / auth headers).
 * @param {string} filename
 * @param {string} contents
 */
function writePrivateFile(filename, contents) {
  fs.writeFileSync(filename, contents, { encoding: 'utf-8', mode: 0o600 });
  // `mode` only applies when the file is created; tighten files left by older versions too.
  try {
    fs.chmodSync(filename, 0o600);
  } catch (err) {
    // Not every filesystem supports chmod (e.g. some Windows / network mounts).
  }
}

class SessionManager {
  /**
   * Manages session persistence (cookies + headers) to/from disk.
   * @param {import('axios').AxiosInstance} session - An axios instance with cookie jar support.
   */
  constructor(session) {
    this.session = session;
  }

  /**
   * Save cookies to a JSON file (readable by the current user only).
   * @param {string} filename - Path to save cookies.
   */
  async saveCookies(filename = 'cookies.json') {
    const jar = this.session.defaults.jar;
    const serialized = jar.toJSON();
    writePrivateFile(filename, JSON.stringify(serialized, null, 2));
  }

  /**
   * Save headers to a JSON file (readable by the current user only).
   * @param {string} filename - Path to save headers.
   */
  saveHeaders(filename = 'headers.json') {
    const headers = { ...this.session.defaults.headers.common };
    writePrivateFile(filename, JSON.stringify(headers, null, 2));
  }

  /**
   * Load cookies from a JSON file into the session cookie jar.
   * @param {string} filename - Path to load cookies from.
   */
  async loadCookies(filename = 'cookies.json') {
    if (!fs.existsSync(filename)) throw new Error(`Cookie file not found: ${filename}`);

    const raw = JSON.parse(fs.readFileSync(filename, 'utf-8'));
    const restoredJar = CookieJar.fromJSON(raw);

    // Copy cookies into the session jar
    const stores = restoredJar.toJSON().cookies || [];
    for (const cookie of stores) {
      const domain = cookie.domain.startsWith('.') ? cookie.domain : '.' + cookie.domain;
      const url = `https://${domain.replace(/^\./, '')}${cookie.path || '/'}`;
      const c = Cookie.fromJSON(cookie);
      if (c) {
        await this.session.defaults.jar.setCookie(c, url);
      }
    }
  }

  /**
   * Load headers from a JSON file into the session.
   * @param {string} filename - Path to load headers from.
   */
  loadHeaders(filename = 'headers.json') {
    if (!fs.existsSync(filename)) throw new Error(`Headers file not found: ${filename}`);

    const headers = JSON.parse(fs.readFileSync(filename, 'utf-8'));
    Object.assign(this.session.defaults.headers.common, headers);
  }

  /**
   * Save both cookies and headers.
   */
  async saveSession() {
    await this.saveCookies();
    this.saveHeaders();
  }

  /**
   * Load both headers and cookies.
   */
  async loadSession() {
    this.loadHeaders();
    await this.loadCookies();
  }

  /**
   * Test if the current session cookies are still valid.
   * Loads saved session and checks if the Arattai web URL resolves without redirect.
   * @returns {Promise<boolean>} Whether the session is valid.
   */
  async testCookies() {
    try {
      await this.loadSession();
    } catch (e) {
      return false;
    }

    try {
      await this.session.get(Defaults.WEB_BASE_URL + '/', {
        timeout: Defaults.DEFAULT_TIMEOUT,
        maxRedirects: 0,
        // Only 2xx counts as valid: an expired session answers with a 3xx redirect to the login page.
        validateStatus: (status) => status >= 200 && status < 300,
      });
      return true;
    } catch (err) {
      // Redirect (3xx) or error means invalid session
      return false;
    }
  }
}

module.exports = SessionManager;
