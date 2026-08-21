'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value, fallback = []) =>
  value ? String(value).split(',').map((v) => v.trim()).filter(Boolean) : fallback;

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  port: int(process.env.PORT, 3000),
  apiPrefix: process.env.API_PREFIX || '/api',
  corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:4200']),
  publicApiUrl: (process.env.PUBLIC_API_URL || 'http://localhost:3000').replace(/\/$/, ''),
  appUrl: (process.env.APP_URL || 'http://localhost:4200').replace(/\/$/, ''),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'offers_app',
    connectionLimit: int(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'change-me-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'change-me-refresh-secret',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),

  /**
   * The httpOnly refresh cookie the web app uses (§22).
   *
   * SameSite depends on where the API sits relative to the SPA: same site can
   * use 'lax', a separate API domain needs 'none' - which browsers only accept
   * on a Secure cookie, so the two default together.
   */
  refreshCookie: {
    sameSite: (process.env.REFRESH_COOKIE_SAMESITE || (isProduction ? 'none' : 'lax')).toLowerCase(),
    secure: bool(process.env.REFRESH_COOKIE_SECURE, isProduction),
    domain: process.env.REFRESH_COOKIE_DOMAIN || '',
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'OffersOffer <no-reply@offers.app>',
  },

  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    uploadDir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || 'uploads'),
    maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
  },

  /** Discovery tuning (§16, §18). Configurable rather than hardcoded. */
  discovery: {
    defaultRadiusKm: int(process.env.DISCOVERY_DEFAULT_RADIUS_KM, 10),
    endingSoonHours: int(process.env.DISCOVERY_ENDING_SOON_HOURS, 72),
    urgentHours: int(process.env.DISCOVERY_URGENT_HOURS, 6),
  },

  /**
   * How long an anonymous public-discovery response may be cached (§26).
   * `shared` is the CDN/proxy window and is deliberately the longer of the
   * two - a shared cache can be purged, a browser cache cannot.
   */
  cache: {
    publicMaxAgeSeconds: int(process.env.CACHE_PUBLIC_MAX_AGE, 60),
    sharedMaxAgeSeconds: int(process.env.CACHE_SHARED_MAX_AGE, 300),
  },

  /**
   * The Python AI service (TOY-ai-backend). Provider keys live there, never
   * here and never in Angular (§40). `enabled` false makes every AI endpoint
   * answer "unavailable" cleanly rather than time out against a dead port.
   */
  ai: {
    enabled: bool(process.env.AI_SERVICE_ENABLED, true),
    baseUrl: (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, ''),
    token: process.env.AI_SERVICE_TOKEN || '',
    timeoutMs: int(process.env.AI_SERVICE_TIMEOUT_MS, 60000),
    /** How much history the assistant may be given (§11). */
    historyOfferLimit: int(process.env.AI_HISTORY_OFFER_LIMIT, 12),
    historyWindowDays: int(process.env.AI_HISTORY_WINDOW_DAYS, 180),
    /** Below this many measured offers, history is treated as insufficient (§38). */
    minHistoryOffers: int(process.env.AI_MIN_HISTORY_OFFERS, 2),
  },

  /**
   * Razorpay (V3 payments §2). Left empty in development: the checkout and
   * webhook endpoints then answer with a clear "payments are not configured"
   * rather than failing deep inside an HTTP call to the gateway.
   *
   * `planIds` map this app's plan keys onto Razorpay Plan ids, which is what a
   * recurring subscription (and therefore UPI AutoPay) is created against.
   */
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    apiBase: process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1',
    planIds: {
      BUSINESS: process.env.RAZORPAY_PLAN_BUSINESS || '',
      PREMIUM: process.env.RAZORPAY_PLAN_PREMIUM || '',
    },
    /** Billing cycles a mandate is authorised for before it must be renewed. */
    totalCount: int(process.env.RAZORPAY_TOTAL_COUNT, 120),
  },

  billing: {
    /** Days a failed renewal keeps its features before downgrade (§10). */
    graceDays: int(process.env.BILLING_GRACE_DAYS, 5),
    /** Percentage added to the plan price on invoices (§16). */
    taxPercent: Number(process.env.BILLING_TAX_PERCENT ?? 18),
    invoicePrefix: process.env.BILLING_INVOICE_PREFIX || 'INV',
  },

  seed: {
    superAdminEmail: process.env.SEED_SUPERADMIN_EMAIL || 'superadmin@offers.app',
    superAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD || 'SuperAdmin@123',
    demoData: bool(process.env.SEED_DEMO_DATA, true),
  },
};

// Refuse to boot production with the shipped placeholder secrets.
if (env.isProduction) {
  const weak = [];
  if (env.jwt.accessSecret.startsWith('change-me')) weak.push('JWT_ACCESS_SECRET');
  if (env.jwt.refreshSecret.startsWith('change-me')) weak.push('JWT_REFRESH_SECRET');
  if (weak.length) {
    throw new Error(`Refusing to start in production with default secrets: ${weak.join(', ')}`);
  }
}

module.exports = env;
