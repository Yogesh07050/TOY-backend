-- =====================================================================
--  Offers App - MySQL schema
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
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  token_hash  CHAR(64)        NOT NULL,
  expires_at  DATETIME        NOT NULL,
  revoked_at  DATETIME                DEFAULT NULL,
  user_agent  VARCHAR(255)            DEFAULT NULL,
  ip_address  VARCHAR(64)             DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY idx_refresh_user (user_id),
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
  status         ENUM('active','past_due','cancelled','expired') NOT NULL DEFAULT 'active',
  billing_cycle  ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  price_amount   DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  currency       CHAR(3)         NOT NULL DEFAULT 'INR',
  payment_status ENUM('not_required','pending','paid','failed') NOT NULL DEFAULT 'not_required',
  started_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  renews_at      DATETIME                DEFAULT NULL,
  cancelled_at   DATETIME                DEFAULT NULL,
  provider       VARCHAR(40)             DEFAULT NULL,
  provider_ref   VARCHAR(120)            DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- A shop has exactly one subscription; upgrades mutate this row.
  UNIQUE KEY uq_subscription_shop (shop_id),
  KEY idx_subscription_plan (plan, status),
  CONSTRAINT fk_subscription_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Plan change history. Kept separate from audit_logs so billing can be
-- reconstructed without trawling the generic trail.
CREATE TABLE IF NOT EXISTS subscription_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id    BIGINT UNSIGNED NOT NULL,
  from_plan  ENUM('FREE','BUSINESS','PREMIUM')         DEFAULT NULL,
  to_plan    ENUM('FREE','BUSINESS','PREMIUM') NOT NULL,
  action     ENUM('created','upgraded','downgraded','renewed','cancelled','reactivated') NOT NULL,
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
