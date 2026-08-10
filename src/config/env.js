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

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
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

  mail: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'Offers App <no-reply@offers.app>',
  },

  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    uploadDir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || 'uploads'),
    maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
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
