const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { QRLogin, SessionManager } = require('../auth');
const Bot = require('./bot');
const Defaults = require('../Defaults');

/**
 * Main entry point for the Arattix library.
 * Creates a session, handles authentication, and returns a Bot instance.
 */
class ArattixBot {
  /**
   * @param {object} [options]
   * @param {boolean} [options.isShowQr=true] - Display QR code in terminal.
   * @param {string|null} [options.proxy=null] - Not supported: passing a proxy URL throws.
   *   `axios-cookiejar-support` refuses custom HTTP agents, so route traffic through a proxy
   *   at the network level instead (VPN, transparent proxy, container network).
   */
  constructor({ isShowQr = true, proxy = null } = {}) {
    if (proxy) {
      throw new Error(
        'ArattixBot: the "proxy" option is not supported (the cookie-jar wrapper rejects custom HTTP agents); ' +
          'route traffic through a proxy at the network level instead'
      );
    }

    this.isShowQr = isShowQr;
    this.token = null;

    this.session = wrapper(
      axios.create({
        jar: new CookieJar(),
        withCredentials: true,
        // Without a timeout a stalled upstream connection hangs the caller forever.
        timeout: Defaults.DEFAULT_TIMEOUT,
        headers: { common: {} },
      })
    );
  }

  /**
   * Authenticate using QR code login.
   * Reuses saved session if valid.
   * @returns {Promise<Bot>} An authenticated Bot instance.
   */
  async loginWithQr() {
    const sessionManager = new SessionManager(this.session);

    const isValid = await sessionManager.testCookies();
    if (isValid) {
      return new Bot(this.session);
    }

    // The stored session (if any) was rejected: don't carry its cookies and headers into
    // the new login.
    sessionManager.reset();
    const qr = new QRLogin(this.session, { showQr: this.isShowQr });
    const qrResp = await qr.initiateLogin();

    if (qrResp) {
      await sessionManager.saveSession();
      return new Bot(this.session);
    }

    throw new Error('QR Login failed');
  }
}

module.exports = ArattixBot;
