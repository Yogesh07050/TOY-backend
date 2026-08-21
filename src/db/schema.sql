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
  event_type ENUM('view','click','share') NOT NULL DEFAULT 'view',
  ip_address VARCHAR(64)             DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ov_offer (offer_id, event_type),
  KEY idx_ov_created (created_at),
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
--  V3 additions - subscriptions and the AI features (TOY.md)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Subscription plans (§3). The AI entitlements are columns rather than a
-- hardcoded lookup because TOY.md requires the Super Admin to be able to
-- change the limits without a deploy.
--
-- Limit columns: NULL means unlimited, 0 means the feature is off for the
-- plan even if the matching *_enabled flag is somehow set.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_plans (
  id                         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                       VARCHAR(40)     NOT NULL,
  name                       VARCHAR(120)    NOT NULL,
  description                VARCHAR(500)            DEFAULT NULL,
  price_monthly              DECIMAL(10,2)   NOT NULL DEFAULT 0,
  currency                   CHAR(3)         NOT NULL DEFAULT 'INR',

  ai_assistant_enabled       TINYINT(1)      NOT NULL DEFAULT 0,
  ai_content_enabled         TINYINT(1)      NOT NULL DEFAULT 0,
  ai_optimizer_enabled       TINYINT(1)      NOT NULL DEFAULT 0,

  -- Premium-only context the assistant may reason from (§11, §12, §13).
  historical_insights        TINYINT(1)      NOT NULL DEFAULT 0,
  location_insights          TINYINT(1)      NOT NULL DEFAULT 0,
  timing_insights            TINYINT(1)      NOT NULL DEFAULT 0,
  social_caption_enabled     TINYINT(1)      NOT NULL DEFAULT 0,

  ai_assistant_monthly_limit INT UNSIGNED            DEFAULT 0,
  ai_content_monthly_limit   INT UNSIGNED            DEFAULT 0,
  ai_optimizer_monthly_limit INT UNSIGNED            DEFAULT 0,

  display_order              INT             NOT NULL DEFAULT 0,
  is_system                  TINYINT(1)      NOT NULL DEFAULT 0,
  status                     ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at                 DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_code (code),
  KEY idx_plan_status (status, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One live plan per shop. A shop with no row is on the free plan.
CREATE TABLE IF NOT EXISTS shop_subscriptions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id     BIGINT UNSIGNED NOT NULL,
  plan_id     BIGINT UNSIGNED NOT NULL,
  status      ENUM('active','cancelled','expired') NOT NULL DEFAULT 'active',
  started_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME                DEFAULT NULL,
  notes       VARCHAR(500)            DEFAULT NULL,
  updated_by  BIGINT UNSIGNED         DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shop_subscription (shop_id),
  KEY idx_subscription_plan (plan_id),
  CONSTRAINT fk_subscription_shop       FOREIGN KEY (shop_id)    REFERENCES shops (id)              ON DELETE CASCADE,
  CONSTRAINT fk_subscription_plan       FOREIGN KEY (plan_id)    REFERENCES subscription_plans (id) ON DELETE RESTRICT,
  CONSTRAINT fk_subscription_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)              ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- AI usage metering (§32). Every attempt is recorded, successful or not,
-- because the failures are what explain a provider outage later. Only
-- successes count against a plan limit.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id           BIGINT UNSIGNED NOT NULL,
  user_id           BIGINT UNSIGNED         DEFAULT NULL,
  feature           VARCHAR(40)     NOT NULL,
  plan_code         VARCHAR(40)             DEFAULT NULL,
  provider          VARCHAR(40)             DEFAULT NULL,
  model             VARCHAR(80)             DEFAULT NULL,
  prompt_tokens     INT UNSIGNED    NOT NULL DEFAULT 0,
  completion_tokens INT UNSIGNED    NOT NULL DEFAULT 0,
  total_tokens      INT UNSIGNED    NOT NULL DEFAULT 0,
  status            ENUM('success','failure') NOT NULL DEFAULT 'success',
  error_code        VARCHAR(60)             DEFAULT NULL,
  duration_ms       INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The monthly quota check reads exactly this key.
  KEY idx_ai_usage_quota (shop_id, feature, status, created_at),
  KEY idx_ai_usage_user (user_id, created_at),
  CONSTRAINT fk_ai_usage_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- AI generation history (§33). `outcome` is how "Accepted / Rejected" is
-- answered: it flips to accepted when the admin actually uses the result.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_generations (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id          BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED         DEFAULT NULL,
  feature          VARCHAR(40)     NOT NULL,
  offer_id         BIGINT UNSIGNED         DEFAULT NULL,
  request_summary  VARCHAR(500)            DEFAULT NULL,
  result_summary   VARCHAR(500)            DEFAULT NULL,
  request_payload  JSON                    DEFAULT NULL,
  result_payload   JSON                    DEFAULT NULL,
  outcome          ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_gen_shop (shop_id, created_at),
  KEY idx_ai_gen_offer (offer_id),
  CONSTRAINT fk_ai_gen_shop  FOREIGN KEY (shop_id)  REFERENCES shops (id)  ON DELETE CASCADE,
  CONSTRAINT fk_ai_gen_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE SET NULL,
  CONSTRAINT fk_ai_gen_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
