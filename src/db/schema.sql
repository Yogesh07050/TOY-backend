-- =====================================================================
--  OffersOffer - MySQL schema
--  Requirements reference: section 30 (Database Structure)
--  Engine: InnoDB / utf8mb4. Target: MySQL 8.0+
-- =====================================================================

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120)    NOT NULL,
  email           VARCHAR(190)    NOT NULL,
  password_hash   VARCHAR(255)    NOT NULL,
  phone           VARCHAR(30)             DEFAULT NULL,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  email_verified  TINYINT(1)      NOT NULL DEFAULT 0,
  avatar_url      VARCHAR(500)            DEFAULT NULL,
  -- preferred location used for "offers near me" when GPS is not shared
  pref_city       VARCHAR(120)            DEFAULT NULL,
  pref_latitude   DECIMAL(10,7)           DEFAULT NULL,
  pref_longitude  DECIMAL(10,7)           DEFAULT NULL,
  last_login_at   DATETIME                DEFAULT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)     NOT NULL,
  description VARCHAR(255)            DEFAULT NULL,
  -- 'global' roles grant their permissions application-wide.
  -- 'shop' roles only ever grant them for the shops the user is a member of,
  -- which is what makes an Admin an admin *of a particular shop* (§3.2).
  scope       ENUM('global','shop') NOT NULL DEFAULT 'shop',
  -- system roles cannot be deleted or renamed (SUPER_ADMIN, ADMIN, CUSTOMER)
  is_system   TINYINT(1)      NOT NULL DEFAULT 0,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)     NOT NULL,
  description VARCHAR(255)            DEFAULT NULL,
  category    VARCHAR(60)             DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_id       BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_role_permission (role_id, permission_id),
  KEY idx_rp_permission (permission_id),
  CONSTRAINT fk_rp_role       FOREIGN KEY (role_id)       REFERENCES roles (id)       ON DELETE CASCADE,
  CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Global (application-wide) role assignments.
-- Shop-scoped roles live on shop_members.role_id instead.
CREATE TABLE IF NOT EXISTS user_roles (
  id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_role (user_id, role_id),
  KEY idx_ur_role (role_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Auth tokens
-- ---------------------------------------------------------------------
-- One row per issued refresh token. This is the `user_sessions` table of
-- the persistent-login spec (§27): a "session" is a family of refresh
-- tokens sharing `family_id`, rotated on every use (§29), so the newest
-- live row in a family *is* that device's session.
--
-- Raw tokens are never stored, only their SHA-256 digest (§27).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  token_hash     CHAR(64)        NOT NULL,
  -- Shared by every rotation of one device's session. Presenting a token
  -- that was already rotated away is a reuse signal, and the whole family
  -- is revoked in response (§29).
  family_id      CHAR(32)                DEFAULT NULL,
  expires_at     DATETIME        NOT NULL,
  revoked_at     DATETIME                DEFAULT NULL,
  revoked_reason ENUM('rotated','logout','logout_others','reuse_detected',
                      'password_changed','revoked','account_disabled')
                 DEFAULT NULL,
  device_type    ENUM('mobile','tablet','desktop','web','unknown') NOT NULL DEFAULT 'unknown',
  device_name    VARCHAR(120)            DEFAULT NULL,
  platform       VARCHAR(40)             DEFAULT NULL,
  user_agent     VARCHAR(255)            DEFAULT NULL,
  ip_address     VARCHAR(64)             DEFAULT NULL,
  last_used_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY idx_refresh_user (user_id),
  KEY idx_refresh_family (family_id),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Password reset + email verification share one table, separated by purpose.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  purpose    ENUM('password_reset','email_verification') NOT NULL,
  token_hash CHAR(64)        NOT NULL,
  expires_at DATETIME        NOT NULL,
  used_at    DATETIME                DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_token_hash (token_hash),
  KEY idx_auth_token_user (user_id, purpose),
  CONSTRAINT fk_auth_token_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120)    NOT NULL,
  slug        VARCHAR(140)    NOT NULL,
  description VARCHAR(500)            DEFAULT NULL,
  icon        VARCHAR(80)             DEFAULT NULL,
  image_url   VARCHAR(500)            DEFAULT NULL,
  parent_id   BIGINT UNSIGNED         DEFAULT NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_slug (slug),
  KEY idx_categories_parent (parent_id),
  KEY idx_categories_status (status),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shops (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(160)    NOT NULL,
  slug           VARCHAR(180)    NOT NULL,
  description    TEXT                    DEFAULT NULL,
  logo_url       VARCHAR(500)            DEFAULT NULL,
  cover_url      VARCHAR(500)            DEFAULT NULL,
  contact_number VARCHAR(30)             DEFAULT NULL,
  email          VARCHAR(190)            DEFAULT NULL,
  website_url    VARCHAR(500)            DEFAULT NULL,
  social_links   JSON                    DEFAULT NULL,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by     BIGINT UNSIGNED         DEFAULT NULL,
  updated_by     BIGINT UNSIGNED         DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shops_slug (slug),
  KEY idx_shops_status (status),
  KEY idx_shops_name (name),
  CONSTRAINT fk_shops_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_shops_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shop_categories (
  shop_id     BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (shop_id, category_id),
  KEY idx_sc_category (category_id),
  CONSTRAINT fk_sc_shop     FOREIGN KEY (shop_id)     REFERENCES shops (id)      ON DELETE CASCADE,
  CONSTRAINT fk_sc_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shop_branches (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id        BIGINT UNSIGNED NOT NULL,
  branch_name    VARCHAR(160)    NOT NULL,
  address        VARCHAR(500)            DEFAULT NULL,
  city           VARCHAR(120)            DEFAULT NULL,
  state          VARCHAR(120)            DEFAULT NULL,
  country        VARCHAR(120)            DEFAULT NULL,
  pincode        VARCHAR(20)             DEFAULT NULL,
  latitude       DECIMAL(10,7)           DEFAULT NULL,
  longitude      DECIMAL(10,7)           DEFAULT NULL,
  contact_number VARCHAR(30)             DEFAULT NULL,
  is_primary     TINYINT(1)      NOT NULL DEFAULT 0,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_branch_shop (shop_id),
  KEY idx_branch_city (city),
  KEY idx_branch_pincode (pincode),
  -- bounding-box prefilter for radius search rides on this index
  KEY idx_branch_geo (latitude, longitude),
  CONSTRAINT fk_branch_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A user may belong to several shops, so membership is its own relation (§18).
CREATE TABLE IF NOT EXISTS shop_members (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id     BIGINT UNSIGNED NOT NULL,
  branch_id   BIGINT UNSIGNED         DEFAULT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  role_id     BIGINT UNSIGNED         DEFAULT NULL,
  designation VARCHAR(120)            DEFAULT NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shop_member (shop_id, user_id),
  KEY idx_member_user (user_id),
  KEY idx_member_branch (branch_id),
  CONSTRAINT fk_member_shop   FOREIGN KEY (shop_id)   REFERENCES shops (id)         ON DELETE CASCADE,
  CONSTRAINT fk_member_branch FOREIGN KEY (branch_id) REFERENCES shop_branches (id) ON DELETE SET NULL,
  CONSTRAINT fk_member_user   FOREIGN KEY (user_id)   REFERENCES users (id)         ON DELETE CASCADE,
  CONSTRAINT fk_member_role   FOREIGN KEY (role_id)   REFERENCES roles (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offers (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id           BIGINT UNSIGNED NOT NULL,
  category_id       BIGINT UNSIGNED         DEFAULT NULL,
  subcategory_id    BIGINT UNSIGNED         DEFAULT NULL,
  title             VARCHAR(200)    NOT NULL,
  product_name      VARCHAR(200)            DEFAULT NULL,
  description       TEXT                    DEFAULT NULL,
  -- headline shown on the card, e.g. "Buy 3 Get 3 Free", "Up to 70% OFF"
  offer_text        VARCHAR(200)            DEFAULT NULL,
  offer_type        ENUM('percentage','flat','buy_x_get_y','price_drop','up_to','other') NOT NULL DEFAULT 'percentage',
  discount_type     ENUM('percentage','flat','none') NOT NULL DEFAULT 'percentage',
  discount_value    DECIMAL(10,2)           DEFAULT NULL,
  original_price    DECIMAL(12,2)           DEFAULT NULL,
  discounted_price  DECIMAL(12,2)           DEFAULT NULL,
  buy_quantity      INT UNSIGNED            DEFAULT NULL,
  get_quantity      INT UNSIGNED            DEFAULT NULL,
  min_purchase      DECIMAL(12,2)           DEFAULT NULL,
  terms_conditions  TEXT                    DEFAULT NULL,
  eligibility       TEXT                    DEFAULT NULL,
  usage_restrictions TEXT                   DEFAULT NULL,
  applicable_products VARCHAR(500)          DEFAULT NULL,
  is_recurring      TINYINT(1)      NOT NULL DEFAULT 0,
  recurrence_type   ENUM('daily','weekly','monthly') DEFAULT NULL,
  start_date        DATETIME        NOT NULL,
  end_date          DATETIME        NOT NULL,
  status            ENUM('draft','scheduled','active','expired','deactivated') NOT NULL DEFAULT 'draft',
  -- how the offer maps to physical locations (§8.3)
  applicability_type ENUM('shop_wide','selected_branches','online') NOT NULL DEFAULT 'shop_wide',
  view_count        INT UNSIGNED    NOT NULL DEFAULT 0,
  click_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  favorite_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  created_by        BIGINT UNSIGNED         DEFAULT NULL,
  updated_by        BIGINT UNSIGNED         DEFAULT NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_offers_shop (shop_id),
  KEY idx_offers_category (category_id),
  KEY idx_offers_status_end (status, end_date),
  KEY idx_offers_status_start (status, start_date),
  KEY idx_offers_created (created_at),
  KEY idx_offers_discount (discount_value),
  KEY idx_offers_views (view_count),
  FULLTEXT KEY ft_offers_search (title, product_name, description, offer_text),
  CONSTRAINT fk_offers_shop        FOREIGN KEY (shop_id)        REFERENCES shops (id)      ON DELETE CASCADE,
  CONSTRAINT fk_offers_category    FOREIGN KEY (category_id)    REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_offers_subcategory FOREIGN KEY (subcategory_id) REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_offers_created_by  FOREIGN KEY (created_by)     REFERENCES users (id)      ON DELETE SET NULL,
  CONSTRAINT fk_offers_updated_by  FOREIGN KEY (updated_by)     REFERENCES users (id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS offer_locations (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id  BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_offer_branch (offer_id, branch_id),
  KEY idx_ol_branch (branch_id),
  CONSTRAINT fk_ol_offer  FOREIGN KEY (offer_id)  REFERENCES offers (id)        ON DELETE CASCADE,
  CONSTRAINT fk_ol_branch FOREIGN KEY (branch_id) REFERENCES shop_branches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS offer_images (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id      BIGINT UNSIGNED NOT NULL,
  image_url     VARCHAR(500)    NOT NULL,
  thumbnail_url VARCHAR(500)            DEFAULT NULL,
  display_order INT             NOT NULL DEFAULT 0,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oi_offer (offer_id, display_order),
  CONSTRAINT fk_oi_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Customer engagement
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorites (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  offer_id   BIGINT UNSIGNED NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_favorite (user_id, offer_id),
  KEY idx_fav_offer (offer_id),
  CONSTRAINT fk_fav_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE CASCADE,
  CONSTRAINT fk_fav_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS followed_shops (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  shop_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_follow_shop (user_id, shop_id),
  KEY idx_fs_shop (shop_id),
  CONSTRAINT fk_fs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fs_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS followed_categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_follow_category (user_id, category_id),
  KEY idx_fc_category (category_id),
  CONSTRAINT fk_fc_user     FOREIGN KEY (user_id)     REFERENCES users (id)      ON DELETE CASCADE,
  CONSTRAINT fk_fc_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Customer personalization (V2 §23) — explicit onboarding preferences.
-- Distinct from followed_shops/followed_categories above: those are
-- notification opt-ins the customer can toggle from anywhere, these are
-- the weighted taste profile collected once at onboarding (categories
-- require a minimum of 5, enforced at the application layer) and reused
-- as recommendation-scoring signals. Favorite shops intentionally reuse
-- followed_shops rather than a parallel table — see preferences module.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_category_preferences (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ccp_user_category (user_id, category_id),
  KEY idx_ccp_category (category_id),
  CONSTRAINT fk_ccp_user     FOREIGN KEY (user_id)     REFERENCES users (id)      ON DELETE CASCADE,
  CONSTRAINT fk_ccp_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- offer_type here is an app-level vocabulary (PERCENTAGE_DISCOUNT, CASHBACK,
-- APP_EXCLUSIVE, ...) distinct from offers.offer_type's ENUM, which doesn't
-- cover deal shapes like cashback/combo/clearance. VARCHAR, not a FK/ENUM,
-- for the same "add a value without a migration" reason as analytics_events.
CREATE TABLE IF NOT EXISTS customer_preferred_offer_types (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  offer_type VARCHAR(40)     NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cpot_user_type (user_id, offer_type),
  CONSTRAINT fk_cpot_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviews (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  offer_id   BIGINT UNSIGNED         DEFAULT NULL,
  shop_id    BIGINT UNSIGNED         DEFAULT NULL,
  rating     TINYINT UNSIGNED NOT NULL,
  comment    TEXT                    DEFAULT NULL,
  status     ENUM('pending','approved','rejected') NOT NULL DEFAULT 'approved',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_review_user_offer (user_id, offer_id),
  KEY idx_review_offer (offer_id, status),
  KEY idx_review_shop (shop_id, status),
  CONSTRAINT fk_review_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE CASCADE,
  CONSTRAINT fk_review_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_shop  FOREIGN KEY (shop_id)  REFERENCES shops (id)  ON DELETE CASCADE,
  CONSTRAINT ck_review_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Analytics raw events
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_views (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED         DEFAULT NULL,
  branch_id  BIGINT UNSIGNED         DEFAULT NULL,
  event_type ENUM('view','click','share','impression') NOT NULL DEFAULT 'view',
  ip_address VARCHAR(64)             DEFAULT NULL,
  -- V3: coarse location of the customer at the time of the event, which is what
  -- the location intelligence dashboard (§11) aggregates.
  city       VARCHAR(120)            DEFAULT NULL,
  latitude   DECIMAL(10,7)           DEFAULT NULL,
  longitude  DECIMAL(10,7)           DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ov_offer (offer_id, event_type),
  KEY idx_ov_created (created_at),
  -- Dashboards always slice by offer + type + window together.
  KEY idx_ov_offer_type_time (offer_id, event_type, created_at),
  KEY idx_ov_city (city),
  KEY idx_ov_user (user_id),
  CONSTRAINT fk_ov_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_ov_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  type        VARCHAR(60)     NOT NULL,
  title       VARCHAR(200)    NOT NULL,
  message     VARCHAR(1000)           DEFAULT NULL,
  entity_type VARCHAR(60)             DEFAULT NULL,
  entity_id   BIGINT UNSIGNED         DEFAULT NULL,
  is_read     TINYINT(1)      NOT NULL DEFAULT 0,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notif_user (user_id, is_read, created_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id              BIGINT UNSIGNED NOT NULL,
  email_enabled        TINYINT(1) NOT NULL DEFAULT 1,
  followed_shop_offers TINYINT(1) NOT NULL DEFAULT 1,
  followed_category_offers TINYINT(1) NOT NULL DEFAULT 1,
  nearby_offers        TINYINT(1) NOT NULL DEFAULT 1,
  favorite_expiring    TINYINT(1) NOT NULL DEFAULT 1,
  offer_updates        TINYINT(1) NOT NULL DEFAULT 1,
  admin_announcements  TINYINT(1) NOT NULL DEFAULT 1,
  updated_at           DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_np_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED         DEFAULT NULL,
  action      VARCHAR(80)     NOT NULL,
  entity_type VARCHAR(60)     NOT NULL,
  entity_id   BIGINT UNSIGNED         DEFAULT NULL,
  old_value   JSON                    DEFAULT NULL,
  new_value   JSON                    DEFAULT NULL,
  ip_address  VARCHAR(64)             DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_user (user_id),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V2 additions
-- =====================================================================

-- ---------------------------------------------------------------------
-- Featured banners (§13). Every banner promotes one specific offer, so
-- offer_id is NOT NULL: a banner without a destination has no purpose.
-- ON DELETE CASCADE means deleting an offer takes its banners with it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banners (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title            VARCHAR(200)    NOT NULL,
  subtitle         VARCHAR(300)            DEFAULT NULL,
  description      TEXT                    DEFAULT NULL,
  image_url        VARCHAR(500)            DEFAULT NULL,
  mobile_image_url VARCHAR(500)            DEFAULT NULL,
  desktop_image_url VARCHAR(500)           DEFAULT NULL,
  offer_id         BIGINT UNSIGNED NOT NULL,
  button_text      VARCHAR(60)     NOT NULL DEFAULT 'View Offer',
  start_date       DATETIME        NOT NULL,
  end_date         DATETIME        NOT NULL,
  status           ENUM('draft','scheduled','published','expired','deactivated')
                                   NOT NULL DEFAULT 'draft',
  display_order    INT             NOT NULL DEFAULT 0,
  impression_count INT UNSIGNED    NOT NULL DEFAULT 0,
  click_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  -- V3: optional campaign grouping for the campaign performance dashboard (§15).
  -- The FK is added by the migration patch so this file stays re-runnable.
  campaign_id      BIGINT UNSIGNED         DEFAULT NULL,
  created_by       BIGINT UNSIGNED         DEFAULT NULL,
  updated_by       BIGINT UNSIGNED         DEFAULT NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_banner_offer (offer_id),
  -- The customer query filters on status + window and orders by display_order.
  KEY idx_banner_live (status, start_date, end_date, display_order),
  CONSTRAINT fk_banner_offer      FOREIGN KEY (offer_id)   REFERENCES offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_banner_created_by FOREIGN KEY (created_by) REFERENCES users (id)  ON DELETE SET NULL,
  CONSTRAINT fk_banner_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS banner_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  banner_id  BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED         DEFAULT NULL,
  event_type ENUM('impression','click') NOT NULL,
  ip_address VARCHAR(64)             DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_be_banner (banner_id, event_type),
  KEY idx_be_created (created_at),
  CONSTRAINT fk_be_banner FOREIGN KEY (banner_id) REFERENCES banners (id) ON DELETE CASCADE,
  CONSTRAINT fk_be_user   FOREIGN KEY (user_id)   REFERENCES users (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Claims and redemptions (§22-§24). A claim is the customer reserving an
-- offer; redemption is staff marking it used, which is what closes the
-- funnel. The code is what a QR scan resolves to.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_claims (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id     BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  branch_id    BIGINT UNSIGNED         DEFAULT NULL,
  code         VARCHAR(24)     NOT NULL,
  status       ENUM('claimed','redeemed','expired','cancelled') NOT NULL DEFAULT 'claimed',
  claimed_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  redeemed_at  DATETIME                DEFAULT NULL,
  redeemed_by  BIGINT UNSIGNED         DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_claim_code (code),
  -- One live claim per customer per offer; re-claiming returns the same code.
  UNIQUE KEY uq_claim_user_offer (user_id, offer_id),
  KEY idx_claim_offer (offer_id, status),
  KEY idx_claim_claimed (claimed_at),
  CONSTRAINT fk_claim_offer       FOREIGN KEY (offer_id)    REFERENCES offers (id)        ON DELETE CASCADE,
  CONSTRAINT fk_claim_user        FOREIGN KEY (user_id)     REFERENCES users (id)         ON DELETE CASCADE,
  CONSTRAINT fk_claim_branch      FOREIGN KEY (branch_id)   REFERENCES shop_branches (id) ON DELETE SET NULL,
  CONSTRAINT fk_claim_redeemed_by FOREIGN KEY (redeemed_by) REFERENCES users (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Search terms, used only as a mild recommendation signal (§20).
CREATE TABLE IF NOT EXISTS search_history (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  term       VARCHAR(120)    NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_search_user (user_id, created_at),
  CONSTRAINT fk_search_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V3 additions - subscriptions, campaigns and the analytics warehouse
-- =====================================================================

-- ---------------------------------------------------------------------
-- One subscription row per shop (§2, §38). The plan is the single source
-- of truth for feature entitlements; everything else here is billing
-- bookkeeping that a payment provider can later drive.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shop_subscriptions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id        BIGINT UNSIGNED NOT NULL,
  plan           ENUM('FREE','BUSINESS','PREMIUM') NOT NULL DEFAULT 'FREE',
  -- 'created' is a paid plan chosen but not yet paid for; 'paused' is a
  -- Razorpay-side halt. Entitlements only follow 'active' (§9).
  status         ENUM('created','active','past_due','paused','cancelled','expired')
                 NOT NULL DEFAULT 'active',
  billing_cycle  ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  price_amount   DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  currency       CHAR(3)         NOT NULL DEFAULT 'INR',
  payment_status ENUM('not_required','pending','paid','failed') NOT NULL DEFAULT 'not_required',
  started_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  renews_at      DATETIME                DEFAULT NULL,
  cancelled_at   DATETIME                DEFAULT NULL,
  provider       VARCHAR(40)             DEFAULT NULL,
  provider_ref   VARCHAR(120)            DEFAULT NULL,
  -- ---- Gateway bookkeeping (Razorpay §6, §17) ----
  -- Identifiers only. No card, UPI or banking credential is ever stored.
  gateway               VARCHAR(40)      DEFAULT NULL,
  gateway_customer_id   VARCHAR(120)     DEFAULT NULL,
  gateway_subscription_id VARCHAR(120)   DEFAULT NULL,
  gateway_plan_id       VARCHAR(120)     DEFAULT NULL,
  current_period_start  DATETIME         DEFAULT NULL,
  current_period_end    DATETIME         DEFAULT NULL,
  -- Set when the merchant cancels or downgrades: benefits run to the end of
  -- the paid period before `pending_plan` takes effect (§12, §13).
  cancel_at_period_end  TINYINT(1)       NOT NULL DEFAULT 0,
  pending_plan          ENUM('FREE','BUSINESS','PREMIUM') DEFAULT NULL,
  -- The plan a checkout is in flight for. Parked here rather than written
  -- to `plan`, so starting a purchase never disturbs the plan the merchant
  -- has already paid for (§7, §12). Applied by `activate()` on payment.
  checkout_plan         ENUM('FREE','BUSINESS','PREMIUM') DEFAULT NULL,
  -- How long a failed renewal keeps its features before downgrade (§10).
  grace_until           DATETIME         DEFAULT NULL,
  -- True once a UPI AutoPay / card mandate is authorised (§5).
  autopay_enabled       TINYINT(1)       NOT NULL DEFAULT 0,
  payment_method        VARCHAR(40)      DEFAULT NULL,
  last_payment_at       DATETIME         DEFAULT NULL,
  last_failure_reason   VARCHAR(255)     DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- A shop has exactly one subscription; upgrades mutate this row.
  UNIQUE KEY uq_subscription_shop (shop_id),
  KEY idx_subscription_plan (plan, status),
  KEY idx_subscription_gateway (gateway_subscription_id),
  CONSTRAINT fk_subscription_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Plan change history. Kept separate from audit_logs so billing can be
-- reconstructed without trawling the generic trail.
CREATE TABLE IF NOT EXISTS subscription_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id    BIGINT UNSIGNED NOT NULL,
  from_plan  ENUM('FREE','BUSINESS','PREMIUM')         DEFAULT NULL,
  to_plan    ENUM('FREE','BUSINESS','PREMIUM') NOT NULL,
  action     ENUM('created','upgraded','downgraded','renewed','cancelled','reactivated',
                  'payment_failed','past_due','expired','grace_started') NOT NULL,
  amount     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  actor_id   BIGINT UNSIGNED         DEFAULT NULL,
  note       VARCHAR(255)            DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sub_event_shop (shop_id, created_at),
  CONSTRAINT fk_sub_event_shop  FOREIGN KEY (shop_id)  REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_sub_event_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-period usage counters (§38). `period` is the billing month (YYYY-MM),
-- which is what makes the Free plan's "one offer per month" cheap to enforce.
CREATE TABLE IF NOT EXISTS subscription_usage (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id           BIGINT UNSIGNED NOT NULL,
  period            CHAR(7)         NOT NULL,
  offers_published  INT UNSIGNED    NOT NULL DEFAULT 0,
  banners_published INT UNSIGNED    NOT NULL DEFAULT 0,
  exports_generated INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usage_shop_period (shop_id, period),
  CONSTRAINT fk_usage_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Campaigns (§15, §25). A campaign groups banners and offers so their
-- combined performance - and optionally ROI - can be reported on.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id            BIGINT UNSIGNED NOT NULL,
  name               VARCHAR(160)    NOT NULL,
  description        VARCHAR(500)            DEFAULT NULL,
  start_date         DATETIME        NOT NULL,
  end_date           DATETIME        NOT NULL,
  -- Optional merchant inputs behind the ROI dashboard. NULL means "not
  -- provided", which is what keeps ROI hidden rather than guessed (§25).
  cost               DECIMAL(12,2)           DEFAULT NULL,
  avg_order_value    DECIMAL(12,2)           DEFAULT NULL,
  avg_margin_percent DECIMAL(5,2)            DEFAULT NULL,
  status             ENUM('draft','running','completed','archived') NOT NULL DEFAULT 'running',
  created_by         BIGINT UNSIGNED         DEFAULT NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_campaign_shop (shop_id, status),
  CONSTRAINT fk_campaign_shop    FOREIGN KEY (shop_id)    REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_campaign_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_offers (
  campaign_id BIGINT UNSIGNED NOT NULL,
  offer_id    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (campaign_id, offer_id),
  KEY idx_co_offer (offer_id),
  CONSTRAINT fk_co_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_co_offer    FOREIGN KEY (offer_id)    REFERENCES offers (id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Generic analytics event stream (§28). Offer and banner events keep their
-- dedicated tables - this covers the discovery/customer events that have no
-- home, and carries the coarse location every location dashboard needs.
--
-- Only the fields the dashboards actually aggregate are stored; nothing here
-- identifies a customer beyond the user id already present elsewhere (§13).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type  VARCHAR(40)     NOT NULL,
  shop_id     BIGINT UNSIGNED         DEFAULT NULL,
  offer_id    BIGINT UNSIGNED         DEFAULT NULL,
  banner_id   BIGINT UNSIGNED         DEFAULT NULL,
  branch_id   BIGINT UNSIGNED         DEFAULT NULL,
  category_id BIGINT UNSIGNED         DEFAULT NULL,
  user_id     BIGINT UNSIGNED         DEFAULT NULL,
  city        VARCHAR(120)            DEFAULT NULL,
  pincode     VARCHAR(20)             DEFAULT NULL,
  latitude    DECIMAL(10,7)           DEFAULT NULL,
  longitude   DECIMAL(10,7)           DEFAULT NULL,
  term        VARCHAR(160)            DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The shape every dashboard query uses: one shop, one event type, a window.
  KEY idx_ae_shop_type_time (shop_id, event_type, created_at),
  KEY idx_ae_type_time (event_type, created_at),
  KEY idx_ae_offer (offer_id, created_at),
  KEY idx_ae_user (user_id, created_at),
  KEY idx_ae_city (city),
  CONSTRAINT fk_ae_shop   FOREIGN KEY (shop_id)   REFERENCES shops (id)         ON DELETE CASCADE,
  CONSTRAINT fk_ae_offer  FOREIGN KEY (offer_id)  REFERENCES offers (id)        ON DELETE CASCADE,
  CONSTRAINT fk_ae_banner FOREIGN KEY (banner_id) REFERENCES banners (id)       ON DELETE CASCADE,
  CONSTRAINT fk_ae_branch FOREIGN KEY (branch_id) REFERENCES shop_branches (id) ON DELETE SET NULL,
  CONSTRAINT fk_ae_user   FOREIGN KEY (user_id)   REFERENCES users (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Pre-aggregated daily rollups (§29). Dashboards read these instead of
-- scanning the raw event tables for every KPI card.
--
-- offer_id / branch_id use 0 rather than NULL for the "all" rollup so the
-- unique key actually de-duplicates (NULLs never collide in MySQL).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_daily_snapshots (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id             BIGINT UNSIGNED NOT NULL,
  snapshot_date       DATE            NOT NULL,
  offer_id            BIGINT UNSIGNED NOT NULL DEFAULT 0,
  branch_id           BIGINT UNSIGNED NOT NULL DEFAULT 0,
  impressions         INT UNSIGNED    NOT NULL DEFAULT 0,
  views               INT UNSIGNED    NOT NULL DEFAULT 0,
  saves               INT UNSIGNED    NOT NULL DEFAULT 0,
  shares              INT UNSIGNED    NOT NULL DEFAULT 0,
  clicks              INT UNSIGNED    NOT NULL DEFAULT 0,
  claims              INT UNSIGNED    NOT NULL DEFAULT 0,
  redemptions         INT UNSIGNED    NOT NULL DEFAULT 0,
  unique_customers    INT UNSIGNED    NOT NULL DEFAULT 0,
  new_customers       INT UNSIGNED    NOT NULL DEFAULT 0,
  returning_customers INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_snapshot (shop_id, snapshot_date, offer_id, branch_id),
  KEY idx_snapshot_date (snapshot_date),
  CONSTRAINT fk_snapshot_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- First time a customer engaged with a shop, which is what makes
-- "new vs returning" (§14) answerable without scanning every event.
CREATE TABLE IF NOT EXISTS shop_customers (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id        BIGINT UNSIGNED NOT NULL,
  user_id        BIGINT UNSIGNED NOT NULL,
  first_seen_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  visit_count    INT UNSIGNED    NOT NULL DEFAULT 1,
  save_count     INT UNSIGNED    NOT NULL DEFAULT 0,
  claim_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  redeem_count   INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shop_customer (shop_id, user_id),
  KEY idx_sc_first_seen (shop_id, first_seen_at),
  CONSTRAINT fk_shopcust_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_shopcust_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V4 additions - Services (a parallel listing type to offers) and
--  configurable saved-offer expiry notifications
-- =====================================================================

-- ---------------------------------------------------------------------
-- Services mirror the offers table's conventions (shop/category/branch/
-- image ownership, status lifecycle, denormalized counters) but carry
-- service-specific fields (pricing model, duration, availability,
-- booking) instead of discount fields. Categories are shared with
-- offers - no separate service_categories table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id               BIGINT UNSIGNED NOT NULL,
  category_id           BIGINT UNSIGNED         DEFAULT NULL,
  subcategory_id        BIGINT UNSIGNED         DEFAULT NULL,
  name                  VARCHAR(200)    NOT NULL,
  description           TEXT                    DEFAULT NULL,
  pricing_type          ENUM('fixed','starting_from','price_on_enquiry') NOT NULL DEFAULT 'fixed',
  price                 DECIMAL(12,2)           DEFAULT NULL,
  duration_minutes      INT UNSIGNED            DEFAULT NULL,
  duration_label        VARCHAR(60)             DEFAULT NULL,
  -- CSV of 3-letter day codes, e.g. 'mon,tue,wed'.
  available_days        VARCHAR(120)            DEFAULT NULL,
  available_time_start  TIME                    DEFAULT NULL,
  available_time_end    TIME                    DEFAULT NULL,
  home_service          TINYINT(1)      NOT NULL DEFAULT 0,
  walk_in_available     TINYINT(1)      NOT NULL DEFAULT 0,
  appointment_required  TINYINT(1)      NOT NULL DEFAULT 0,
  booking_type          ENUM('walk_in','appointment','both','enquiry_only') NOT NULL DEFAULT 'walk_in',
  service_area          VARCHAR(255)            DEFAULT NULL,
  terms_conditions      TEXT                    DEFAULT NULL,
  applicability_type    ENUM('shop_wide','selected_branches','online') NOT NULL DEFAULT 'shop_wide',
  status                ENUM('draft','scheduled','active','paused','expired','deactivated') NOT NULL DEFAULT 'draft',
  start_date            DATETIME                DEFAULT NULL,
  end_date              DATETIME                DEFAULT NULL,
  view_count            INT UNSIGNED    NOT NULL DEFAULT 0,
  click_count           INT UNSIGNED    NOT NULL DEFAULT 0,
  save_count            INT UNSIGNED    NOT NULL DEFAULT 0,
  created_by            BIGINT UNSIGNED         DEFAULT NULL,
  updated_by            BIGINT UNSIGNED         DEFAULT NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_services_shop (shop_id),
  KEY idx_services_category (category_id),
  KEY idx_services_status_end (status, end_date),
  KEY idx_services_status_start (status, start_date),
  KEY idx_services_created (created_at),
  FULLTEXT KEY ft_services_search (name, description),
  CONSTRAINT fk_services_shop        FOREIGN KEY (shop_id)        REFERENCES shops (id)      ON DELETE CASCADE,
  CONSTRAINT fk_services_category    FOREIGN KEY (category_id)    REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_services_subcategory FOREIGN KEY (subcategory_id) REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_services_created_by  FOREIGN KEY (created_by)     REFERENCES users (id)      ON DELETE SET NULL,
  CONSTRAINT fk_services_updated_by  FOREIGN KEY (updated_by)     REFERENCES users (id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_locations (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_branch (service_id, branch_id),
  KEY idx_sl_branch (branch_id),
  CONSTRAINT fk_sl_service FOREIGN KEY (service_id) REFERENCES services (id)      ON DELETE CASCADE,
  CONSTRAINT fk_sl_branch  FOREIGN KEY (branch_id)  REFERENCES shop_branches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_images (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id    BIGINT UNSIGNED NOT NULL,
  image_url     VARCHAR(500)    NOT NULL,
  thumbnail_url VARCHAR(500)            DEFAULT NULL,
  display_order INT             NOT NULL DEFAULT 0,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_si_service (service_id, display_order),
  CONSTRAINT fk_si_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The promotional layer on a service (§6: "an Offer belongs to a Listing").
-- One service can carry many offers over time; this is never merged back
-- into the services row.
CREATE TABLE IF NOT EXISTS service_offers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id       BIGINT UNSIGNED NOT NULL,
  -- Denormalized so shop-scope checks/joins don't always need `services`.
  shop_id          BIGINT UNSIGNED NOT NULL,
  offer_text       VARCHAR(200)            DEFAULT NULL,
  offer_type       ENUM('percentage','flat','price_drop','other') NOT NULL DEFAULT 'percentage',
  discount_type    ENUM('percentage','flat','none') NOT NULL DEFAULT 'percentage',
  discount_value   DECIMAL(10,2)           DEFAULT NULL,
  original_price   DECIMAL(12,2)           DEFAULT NULL,
  offer_price      DECIMAL(12,2)           DEFAULT NULL,
  terms_conditions TEXT                    DEFAULT NULL,
  is_recurring     TINYINT(1)      NOT NULL DEFAULT 0,
  recurrence_type  ENUM('daily','weekly','monthly') DEFAULT NULL,
  start_date       DATETIME        NOT NULL,
  end_date         DATETIME        NOT NULL,
  status           ENUM('draft','scheduled','active','expired','deactivated') NOT NULL DEFAULT 'draft',
  view_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  claim_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  created_by       BIGINT UNSIGNED         DEFAULT NULL,
  updated_by       BIGINT UNSIGNED         DEFAULT NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_so_service (service_id),
  KEY idx_so_shop (shop_id),
  KEY idx_so_status_end (status, end_date),
  CONSTRAINT fk_so_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_so_shop    FOREIGN KEY (shop_id)    REFERENCES shops (id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_offer_claims (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_offer_id BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  branch_id        BIGINT UNSIGNED         DEFAULT NULL,
  code             VARCHAR(24)     NOT NULL,
  status           ENUM('claimed','redeemed','expired','cancelled') NOT NULL DEFAULT 'claimed',
  claimed_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  redeemed_at      DATETIME                DEFAULT NULL,
  redeemed_by      BIGINT UNSIGNED         DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_claim_code (code),
  UNIQUE KEY uq_service_claim_user_offer (user_id, service_offer_id),
  KEY idx_service_claim_offer (service_offer_id, status),
  KEY idx_service_claim_claimed (claimed_at),
  CONSTRAINT fk_soc_offer       FOREIGN KEY (service_offer_id) REFERENCES service_offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_soc_user        FOREIGN KEY (user_id)          REFERENCES users (id)          ON DELETE CASCADE,
  CONSTRAINT fk_soc_branch      FOREIGN KEY (branch_id)        REFERENCES shop_branches (id)  ON DELETE SET NULL,
  CONSTRAINT fk_soc_redeemed_by FOREIGN KEY (redeemed_by)      REFERENCES users (id)          ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "Saved offers" for services, mirroring `favorites`.
CREATE TABLE IF NOT EXISTS saved_services (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saved_service (user_id, service_id),
  KEY idx_ss_service (service_id),
  CONSTRAINT fk_ss_user    FOREIGN KEY (user_id)    REFERENCES users (id)    ON DELETE CASCADE,
  CONSTRAINT fk_ss_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Minimal booking-request entity backing MANAGE_SERVICE_BOOKING and the
-- SERVICE_BOOK/SERVICE_CANCEL analytics events.
CREATE TABLE IF NOT EXISTS service_bookings (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id       BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  branch_id        BIGINT UNSIGNED         DEFAULT NULL,
  service_offer_id BIGINT UNSIGNED         DEFAULT NULL,
  requested_at     DATETIME                DEFAULT NULL,
  status           ENUM('requested','confirmed','completed','cancelled') NOT NULL DEFAULT 'requested',
  notes            VARCHAR(500)            DEFAULT NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sb_service (service_id, status),
  KEY idx_sb_user (user_id),
  CONSTRAINT fk_sb_service FOREIGN KEY (service_id)      REFERENCES services (id)       ON DELETE CASCADE,
  CONSTRAINT fk_sb_user    FOREIGN KEY (user_id)          REFERENCES users (id)          ON DELETE CASCADE,
  CONSTRAINT fk_sb_branch  FOREIGN KEY (branch_id)        REFERENCES shop_branches (id)  ON DELETE SET NULL,
  CONSTRAINT fk_sb_offer   FOREIGN KEY (service_offer_id) REFERENCES service_offers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Configurable saved-offer expiry reminders (§24-§26). Thresholds are
-- shared across product offers and service offers - "do not implement
-- separate expiry logic" applies across listing types too, not just
-- across web/mobile.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_thresholds (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  hours_before INT UNSIGNED    NOT NULL,
  label        VARCHAR(60)             DEFAULT NULL,
  is_active    TINYINT(1)      NOT NULL DEFAULT 1,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_threshold_hours (hours_before)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dedup ledger: one row per (user, notification type, entity, threshold)
-- that has already fired, kept separate from the user-facing
-- `notifications` table so its `type` values stay stable and readable.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  type            VARCHAR(60)     NOT NULL,
  entity_type     VARCHAR(60)     NOT NULL,
  entity_id       BIGINT UNSIGNED NOT NULL,
  threshold_hours INT UNSIGNED    NOT NULL,
  sent_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notif_delivery (user_id, type, entity_type, entity_id, threshold_hours),
  KEY idx_nd_entity (entity_type, entity_id),
  CONSTRAINT fk_nd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V3 Payments (Razorpay) - "Razorpay Payments & Persistent Login" §17
-- =====================================================================

-- ---------------------------------------------------------------------
-- Every payment attempt the gateway told us about (§17). One row per
-- Razorpay payment; `gateway_payment_id` is unique so a webhook replay
-- updates the existing row rather than inserting a duplicate.
--
-- Nothing here can identify a card: only gateway references, the last
-- four digits Razorpay itself echoes back, and the method name (§6).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id            BIGINT UNSIGNED NOT NULL,
  subscription_id    BIGINT UNSIGNED         DEFAULT NULL,
  gateway            VARCHAR(40)     NOT NULL DEFAULT 'razorpay',
  gateway_order_id   VARCHAR(120)            DEFAULT NULL,
  gateway_payment_id VARCHAR(120)            DEFAULT NULL,
  gateway_invoice_id VARCHAR(120)            DEFAULT NULL,
  plan               ENUM('FREE','BUSINESS','PREMIUM') NOT NULL DEFAULT 'FREE',
  amount             DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  amount_refunded    DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  currency           CHAR(3)         NOT NULL DEFAULT 'INR',
  -- 'upi', 'card', 'netbanking', 'wallet' ... whatever Razorpay reports.
  payment_method     VARCHAR(40)             DEFAULT NULL,
  -- Safe-to-store descriptors Razorpay echoes back; never the full number.
  method_detail      VARCHAR(120)            DEFAULT NULL,
  status             ENUM('CREATED','PENDING','AUTHORIZED','CAPTURED','FAILED',
                          'REFUNDED','PARTIALLY_REFUNDED','CANCELLED')
                     NOT NULL DEFAULT 'CREATED',
  failure_reason     VARCHAR(255)            DEFAULT NULL,
  paid_at            DATETIME                DEFAULT NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_gateway_payment (gateway_payment_id),
  KEY idx_payment_shop (shop_id, created_at),
  KEY idx_payment_order (gateway_order_id),
  KEY idx_payment_status (status),
  CONSTRAINT fk_payment_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Raw webhook ledger (§8, §17). The unique key on (gateway, event_id) is
-- what makes processing idempotent: a redelivered event collides on
-- insert, so the handler can tell "seen before" from "new" atomically
-- rather than by reading first and racing itself.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_webhooks (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gateway      VARCHAR(40)     NOT NULL DEFAULT 'razorpay',
  event_id     VARCHAR(160)    NOT NULL,
  event_type   VARCHAR(80)     NOT NULL,
  payload      JSON            NOT NULL,
  processed    TINYINT(1)      NOT NULL DEFAULT 0,
  processed_at DATETIME                DEFAULT NULL,
  error        VARCHAR(500)            DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_event (gateway, event_id),
  KEY idx_webhook_type (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Issued invoices (§16). Generated from a captured payment, so an
-- invoice only ever exists for money that actually arrived.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id        BIGINT UNSIGNED NOT NULL,
  transaction_id BIGINT UNSIGNED         DEFAULT NULL,
  number         VARCHAR(40)     NOT NULL,
  plan           ENUM('FREE','BUSINESS','PREMIUM') NOT NULL,
  period_start   DATETIME                DEFAULT NULL,
  period_end     DATETIME                DEFAULT NULL,
  -- Amount excluding tax, the tax charged, and what the merchant paid.
  subtotal       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  tax_amount     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  total          DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  currency       CHAR(3)         NOT NULL DEFAULT 'INR',
  status         ENUM('issued','paid','void','refunded') NOT NULL DEFAULT 'paid',
  billing_name   VARCHAR(190)            DEFAULT NULL,
  billing_address VARCHAR(500)           DEFAULT NULL,
  issued_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_number (number),
  KEY idx_invoice_shop (shop_id, issued_at),
  CONSTRAINT fk_invoice_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_txn  FOREIGN KEY (transaction_id)
    REFERENCES payment_transactions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  Super Admin feature overrides (§11A-§11L)
-- =====================================================================

-- Controlled catalogue (§11J). An override may only name a key that
-- exists and is active here, which is what stops a typo or an invented
-- feature name from being inserted and then silently never matching.
CREATE TABLE IF NOT EXISTS feature_catalogue (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  feature_key VARCHAR(60)     NOT NULL,
  name        VARCHAR(120)    NOT NULL,
  description VARCHAR(255)            DEFAULT NULL,
  category    VARCHAR(60)     NOT NULL DEFAULT 'General',
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_feature_key (feature_key),
  KEY idx_feature_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (shop, feature) grant (§11J). Scoped to the shop rather
-- than the admin user: entitlements are consumed per shop everywhere
-- else, and a shop's staff must all see the same feature set.
-- `admin_user_id` records which merchant account the grant was made for.
CREATE TABLE IF NOT EXISTS feature_overrides (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id       BIGINT UNSIGNED NOT NULL,
  admin_user_id BIGINT UNSIGNED         DEFAULT NULL,
  feature_key   VARCHAR(60)     NOT NULL,
  status        ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  starts_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME                DEFAULT NULL,
  is_permanent  TINYINT(1)      NOT NULL DEFAULT 0,
  reason        VARCHAR(500)            DEFAULT NULL,
  granted_by    BIGINT UNSIGNED         DEFAULT NULL,
  revoked_by    BIGINT UNSIGNED         DEFAULT NULL,
  revoked_at    DATETIME                DEFAULT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- A shop has at most one override row per feature; re-granting a
  -- revoked feature reactivates this row so its history stays in one place.
  UNIQUE KEY uq_override_shop_feature (shop_id, feature_key),
  KEY idx_override_status (status, expires_at),
  KEY idx_override_feature (feature_key, status),
  CONSTRAINT fk_override_shop    FOREIGN KEY (shop_id)       REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_override_admin   FOREIGN KEY (admin_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_override_granter FOREIGN KEY (granted_by)    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_override_revoker FOREIGN KEY (revoked_by)    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only history of every override action (§11I). Separate from
-- audit_logs so "who gave ABC Stores Advanced Analytics, and when did it
-- lapse" is one query rather than a search through the generic trail.
CREATE TABLE IF NOT EXISTS feature_override_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  override_id    BIGINT UNSIGNED         DEFAULT NULL,
  shop_id        BIGINT UNSIGNED NOT NULL,
  admin_user_id  BIGINT UNSIGNED         DEFAULT NULL,
  feature_key    VARCHAR(60)     NOT NULL,
  action         ENUM('GRANTED','REVOKED','EXTENDED','EXPIRED','MODIFIED') NOT NULL,
  previous_state JSON                    DEFAULT NULL,
  new_state      JSON                    DEFAULT NULL,
  starts_at      DATETIME                DEFAULT NULL,
  expires_at     DATETIME                DEFAULT NULL,
  reason         VARCHAR(500)            DEFAULT NULL,
  actor_id       BIGINT UNSIGNED         DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_override_event_shop (shop_id, created_at),
  KEY idx_override_event_override (override_id, created_at),
  CONSTRAINT fk_override_event_shop  FOREIGN KEY (shop_id)  REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_override_event_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
