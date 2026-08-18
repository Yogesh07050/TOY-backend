'use strict';

/**
 * Describes the device a session belongs to, for the "Logged-in devices"
 * screen (§28).
 *
 * Clients that know what they are - the React Native app - say so in
 * `X-Device-*` headers, which is always better than a guess. Browsers do not
 * send those, so the User-Agent is parsed as a fallback. Neither is a security
 * input: this only ever labels a row a user is shown.
 */

const DEVICE_TYPES = new Set(['mobile', 'tablet', 'desktop', 'web', 'unknown']);

/** Coarse platform name from a User-Agent string. */
function platformFromUserAgent(ua) {
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/mac os x/i.test(ua)) return 'macOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/linux/i.test(ua)) return 'Linux';
  return null;
}

/** Browser name, so two laptops are distinguishable in the session list. */
function browserFromUserAgent(ua) {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\//i.test(ua)) return 'Opera';
  if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) return 'Chrome';
  if (/safari\//i.test(ua) && !/chrome/i.test(ua)) return 'Safari';
  if (/firefox\//i.test(ua)) return 'Firefox';
  return null;
}

function typeFromUserAgent(ua) {
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone/i.test(ua)) return 'mobile';
  if (ua) return 'desktop';
  return 'unknown';
}

/**
 * @param {object} req Express request
 * @returns {{deviceType:string, deviceName:string|null, platform:string|null,
 *            userAgent:string|null, ipAddress:string|null}}
 */
function describe(req) {
  const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 255) || null;
  const header = (name) => {
    const value = req?.headers?.[name];
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
  };

  const claimedType = (header('x-device-type') || '').toLowerCase();
  const ua = userAgent || '';

  const platform = header('x-device-platform') || platformFromUserAgent(ua);
  const browser = browserFromUserAgent(ua);

  return {
    deviceType: DEVICE_TYPES.has(claimedType) ? claimedType : typeFromUserAgent(ua),
    deviceName:
      header('x-device-name') ||
      // "Chrome on macOS" reads better in a device list than a raw UA string.
      (browser && platform ? `${browser} on ${platform}` : browser || platform || null),
    platform: platform ? platform.slice(0, 40) : null,
    userAgent,
    ipAddress: req?.ip ? String(req.ip).slice(0, 64) : null,
  };
}

module.exports = { describe, DEVICE_TYPES };
