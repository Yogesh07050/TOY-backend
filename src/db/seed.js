'use strict';

/**
 * Seeds reference data (permissions, system roles, categories) and, when
 * SEED_DEMO_DATA is on, a small demo tenant that mirrors the worked example in
 * section 44 of the requirements: Zara with two branches, a store manager, and
 * a "Buy 3 Get 3 Free" offer.
 *
 * Safe to run repeatedly - every insert is an upsert.
 */

const { pool, query, queryOne, execute, rawQuery } = require('./pool');
const env = require('../config/env');
const password = require('../utils/password');
const { PERMISSIONS, SYSTEM_ROLES } = require('../config/permissions');
const { PLANS } = require('../config/plans');
const { DEFAULT_PLANS } = require('../config/aiFeatures');
const { slugify } = require('../utils/slug');

const CATEGORIES = [
  ['Food', 'Snacks, sweets and everyday food deals'],
  ['Clothing', 'Menswear, womenswear and kidswear'],
  ['Footwear', 'Shoes, sandals and sports footwear'],
  ['Makeup & Beauty', 'Cosmetics, skincare and grooming'],
  ['Electronics', 'Phones, laptops and gadgets'],
  ['Grocery', 'Daily essentials and supermarket offers'],
  ['Restaurants', 'Dine-in and takeaway offers'],
  ['Travel', 'Flights, stays and holiday packages'],
  ['Home & Furniture', 'Furnishing, decor and appliances'],
  ['Sports', 'Fitness gear and sportswear'],
  ['Accessories', 'Bags, watches and jewellery'],
  // ---- V4: shared with services (§9, §37) - categories are one flat tree for
  // both listing types, not a separate service_categories table.
  ['Beauty & Salon', 'Haircuts, spa and grooming services'],
  ['Home Services', 'Cleaning, repair and home maintenance'],
  ['Automotive', 'Car wash, servicing and repair'],
  ['Education', 'Tuition, coaching and training'],
  ['Professional Services', 'Legal, consulting and business services'],
  ['Health & Wellness', 'Clinics, therapy and wellness services'],
  ['Repair & Maintenance', 'Appliance and device repair'],
  ['Photography', 'Photo and video services'],
  ['Events', 'Event planning and management'],
  ['Fitness', 'Gyms, trainers and fitness classes'],
  ['Cleaning', 'Home and office cleaning services'],
  ['Technology', 'IT support and tech services'],
  ['Other', 'Everything else'],
];

async function seedPermissions() {
  for (const [name, meta] of Object.entries(PERMISSIONS)) {
    await execute(
      `INSERT INTO permissions (name, description, category) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE description = VALUES(description), category = VALUES(category)`,
      [name, meta.description, meta.category],
    );
  }
  console.log('  permissions: %d', Object.keys(PERMISSIONS).length);
}

async function seedRoles() {
  for (const [name, config] of Object.entries(SYSTEM_ROLES)) {
    await execute(
      `INSERT INTO roles (name, description, scope, is_system, status)
       VALUES (?, ?, ?, 1, 'active')
       ON DUPLICATE KEY UPDATE description = VALUES(description), scope = VALUES(scope), is_system = 1`,
      [name, config.description, config.scope],
    );
    const role = await queryOne('SELECT id FROM roles WHERE name = ?', [name]);

    for (const permissionName of config.permissions) {
      await execute(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT ?, id FROM permissions WHERE name = ?`,
        [role.id, permissionName],
      );
    }
  }
  console.log('  roles: %s', Object.keys(SYSTEM_ROLES).join(', '));
}

/** Default expiry-reminder windows (§25): 24h on by default, 6h off. */
async function seedNotificationThresholds() {
  const defaults = [
    [24, '1 day before', 1],
    [6, '6 hours before', 0],
  ];
  for (const [hoursBefore, label, isActive] of defaults) {
    await execute(
      `INSERT INTO notification_thresholds (hours_before, label, is_active) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE label = VALUES(label)`,
      [hoursBefore, label, isActive],
    );
  }
  console.log('  notification thresholds: %s', defaults.map(([h]) => `${h}h`).join(', '));
}

async function seedCategories() {
  for (const [name, description] of CATEGORIES) {
    await execute(
      `INSERT INTO categories (name, slug, description, status) VALUES (?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE description = VALUES(description)`,
      [name, slugify(name), description],
    );
  }
  console.log('  categories: %d', CATEGORIES.length);
}

/**
 * Subscription plans (§3). Re-running the seeder refreshes the descriptive
 * columns but deliberately leaves the AI limits alone: those are the Super
 * Admin's to tune, and a re-seed must not quietly reset them.
 */
async function seedPlans() {
  for (const plan of DEFAULT_PLANS) {
    await execute(
      `INSERT INTO subscription_plans
         (code, name, description, price_monthly,
          ai_assistant_enabled, ai_content_enabled, ai_optimizer_enabled,
          historical_insights, location_insights, timing_insights, social_caption_enabled,
          ai_assistant_monthly_limit, ai_content_monthly_limit, ai_optimizer_monthly_limit,
          display_order, is_system, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active')
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         description = VALUES(description),
         display_order = VALUES(display_order),
         is_system = 1`,
      [
        plan.code,
        plan.name,
        plan.description,
        plan.priceMonthly,
        plan.aiAssistantEnabled ? 1 : 0,
        plan.aiContentEnabled ? 1 : 0,
        plan.aiOptimizerEnabled ? 1 : 0,
        plan.historicalInsights ? 1 : 0,
        plan.locationInsights ? 1 : 0,
        plan.timingInsights ? 1 : 0,
        plan.socialCaptionEnabled ? 1 : 0,
        plan.aiAssistantMonthlyLimit,
        plan.aiContentMonthlyLimit,
        plan.aiOptimizerMonthlyLimit,
        plan.displayOrder,
      ],
    );
  }
  console.log('  subscription plans: %s', DEFAULT_PLANS.map((plan) => plan.code).join(', '));
}

async function ensureUser({ name, email, plainPassword, roles = [], verified = true }) {
  let user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    const hash = await password.hash(plainPassword);
    const result = await execute(
      'INSERT INTO users (name, email, password_hash, email_verified) VALUES (?, ?, ?, ?)',
      [name, email, hash, verified ? 1 : 0],
    );
    await execute('INSERT IGNORE INTO notification_preferences (user_id) VALUES (?)', [result.insertId]);
    user = await queryOne('SELECT * FROM users WHERE id = ?', [result.insertId]);
  }

  for (const roleName of roles) {
    await execute(
      `INSERT IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = ?`,
      [user.id, roleName],
    );
  }
  return user;
}

async function seedSuperAdmin() {
  const user = await ensureUser({
    name: 'Super Admin',
    email: env.seed.superAdminEmail,
    plainPassword: env.seed.superAdminPassword,
    roles: ['SUPER_ADMIN'],
  });
  console.log('  super admin: %s', user.email);
  return user;
}

// ---------------------------------------------------------------------------
// Demo tenant
// ---------------------------------------------------------------------------

async function ensureShop(superAdminId, { name, description, categories, branches }) {
  let shop = await queryOne('SELECT * FROM shops WHERE slug = ?', [slugify(name)]);
  if (!shop) {
    const result = await execute(
      `INSERT INTO shops (name, slug, description, status, created_by, updated_by)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      [name, slugify(name), description, superAdminId, superAdminId],
    );
    shop = await queryOne('SELECT * FROM shops WHERE id = ?', [result.insertId]);
  }

  for (const categoryName of categories) {
    await execute(
      `INSERT IGNORE INTO shop_categories (shop_id, category_id)
       SELECT ?, id FROM categories WHERE name = ?`,
      [shop.id, categoryName],
    );
  }

  for (const branch of branches) {
    const existing = await queryOne(
      'SELECT id FROM shop_branches WHERE shop_id = ? AND branch_name = ?',
      [shop.id, branch.branchName],
    );
    if (!existing) {
      await execute(
        `INSERT INTO shop_branches (shop_id, branch_name, address, city, state, country, pincode,
                                    latitude, longitude, contact_number, is_primary, status)
         VALUES (?, ?, ?, ?, ?, 'India', ?, ?, ?, ?, ?, 'active')`,
        [
          shop.id,
          branch.branchName,
          branch.address,
          branch.city,
          branch.state,
          branch.pincode,
          branch.latitude,
          branch.longitude,
          branch.contactNumber ?? null,
          branch.isPrimary ? 1 : 0,
        ],
      );
    }
  }

  return shop;
}

const DEMO_SHOPS = [
  {
    name: 'Zara',
    description: 'Contemporary fashion for men, women and kids.',
    categories: ['Clothing', 'Footwear', 'Accessories'],
    branches: [
      {
        branchName: 'Zara - Avinashi Road',
        address: '123 Avinashi Road, Peelamedu',
        city: 'Coimbatore',
        state: 'Tamil Nadu',
        pincode: '641004',
        latitude: 11.0168,
        longitude: 76.9558,
        contactNumber: '+91 422 400 1234',
        isPrimary: true,
      },
      {
        branchName: 'Zara - Phoenix Mall',
        address: 'Phoenix Marketcity, Velachery',
        city: 'Chennai',
        state: 'Tamil Nadu',
        pincode: '600042',
        latitude: 12.9911,
        longitude: 80.2178,
        contactNumber: '+91 44 400 5678',
      },
    ],
  },
  {
    name: 'FreshMart',
    description: 'Neighbourhood supermarket with daily essentials.',
    categories: ['Grocery', 'Food'],
    branches: [
      {
        branchName: 'FreshMart - RS Puram',
        address: '45 DB Road, RS Puram',
        city: 'Coimbatore',
        state: 'Tamil Nadu',
        pincode: '641002',
        latitude: 11.0043,
        longitude: 76.9497,
        isPrimary: true,
      },
    ],
  },
  {
    name: 'TechNova',
    description: 'Consumer electronics and accessories.',
    categories: ['Electronics', 'Accessories'],
    branches: [
      {
        branchName: 'TechNova - Brookefields',
        address: 'Brookefields Mall, Brookebond Road',
        city: 'Coimbatore',
        state: 'Tamil Nadu',
        pincode: '641001',
        latitude: 10.9985,
        longitude: 76.9629,
        isPrimary: true,
      },
    ],
  },
];

const daysFromNow = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
};

async function seedDemoOffer(shop, createdBy, offer) {
  const existing = await queryOne('SELECT id FROM offers WHERE shop_id = ? AND title = ?', [
    shop.id,
    offer.title,
  ]);
  if (existing) return existing.id;

  const category = await queryOne('SELECT id FROM categories WHERE name = ?', [offer.category]);
  const result = await execute(
    `INSERT INTO offers (shop_id, category_id, title, product_name, description, offer_text,
                         offer_type, discount_type, discount_value, original_price, discounted_price,
                         buy_quantity, get_quantity, terms_conditions, start_date, end_date,
                         status, applicability_type, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shop_wide', ?, ?)`,
    [
      shop.id,
      category?.id ?? null,
      offer.title,
      offer.productName,
      offer.description,
      offer.offerText,
      offer.offerType,
      offer.discountType,
      offer.discountValue,
      offer.originalPrice ?? null,
      offer.discountedPrice ?? null,
      offer.buyQuantity ?? null,
      offer.getQuantity ?? null,
      offer.terms,
      offer.startDate,
      offer.endDate,
      offer.status,
      createdBy,
      createdBy,
    ],
  );
  return result.insertId;
}

async function seedDemoData(superAdmin) {
  const shops = {};
  for (const definition of DEMO_SHOPS) {
    shops[definition.name] = await ensureShop(superAdmin.id, definition);
  }

  // John manages the Coimbatore branch of Zara (§44 steps 3-5).
  const john = await ensureUser({
    name: 'John Mathew',
    email: 'john@zara.com',
    plainPassword: 'ShopAdmin@123',
    roles: ['CUSTOMER'],
  });
  const zara = shops.Zara;
  const coimbatoreBranch = await queryOne(
    'SELECT id FROM shop_branches WHERE shop_id = ? AND city = ? LIMIT 1',
    [zara.id, 'Coimbatore'],
  );
  const adminRole = await queryOne("SELECT id FROM roles WHERE name = 'ADMIN'");
  await execute(
    `INSERT INTO shop_members (shop_id, branch_id, user_id, role_id, designation, status)
     VALUES (?, ?, ?, ?, 'Store Manager', 'active')
     ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), branch_id = VALUES(branch_id)`,
    [zara.id, coimbatoreBranch.id, john.id, adminRole.id],
  );

  const priya = await ensureUser({
    name: 'Priya Raman',
    email: 'priya@example.com',
    plainPassword: 'Customer@123',
    roles: ['CUSTOMER'],
  });
  await execute(
    'UPDATE users SET pref_city = ?, pref_latitude = ?, pref_longitude = ? WHERE id = ?',
    ['Coimbatore', 11.0168, 76.9558, priya.id],
  );

  const offers = [
    [
      zara,
      john.id,
      {
        title: 'Buy 3 Get 3 Free on shirts',
        productName: 'Shirts',
        description: 'Pick any three shirts from the new season range and take three more home free.',
        offerText: 'Buy 3 Get 3 Free',
        offerType: 'buy_x_get_y',
        discountType: 'none',
        discountValue: null,
        buyQuantity: 3,
        getQuantity: 3,
        category: 'Clothing',
        terms: 'Free items are the lowest priced of the six. Not valid with other promotions.',
        startDate: daysFromNow(-2),
        endDate: daysFromNow(10),
        status: 'active',
      },
    ],
    [
      zara,
      john.id,
      {
        title: 'Flat 40% off footwear',
        productName: 'Footwear',
        description: 'Season-end clearance across sneakers, loafers and sandals.',
        offerText: 'Flat 40% OFF',
        offerType: 'percentage',
        discountType: 'percentage',
        discountValue: 40,
        category: 'Footwear',
        terms: 'Applicable on marked styles only while stocks last.',
        startDate: daysFromNow(-5),
        endDate: daysFromNow(3),
        status: 'active',
      },
    ],
    [
      shops.FreshMart,
      superAdmin.id,
      {
        title: '₹500 off on purchases above ₹2,000',
        productName: 'Groceries',
        description: 'Stock up on weekly essentials and save on the bill.',
        offerText: '₹500 OFF above ₹2,000',
        offerType: 'flat',
        discountType: 'flat',
        discountValue: 500,
        category: 'Grocery',
        terms: 'Minimum bill value ₹2,000. One redemption per customer per day.',
        startDate: daysFromNow(-1),
        endDate: daysFromNow(20),
        status: 'active',
      },
    ],
    [
      shops.TechNova,
      superAdmin.id,
      {
        title: 'Up to 70% off on accessories',
        productName: 'Headphones and chargers',
        description: 'Clearance on last-season audio and charging accessories.',
        offerText: 'Up to 70% OFF',
        offerType: 'up_to',
        discountType: 'percentage',
        discountValue: 70,
        category: 'Electronics',
        terms: 'Discount varies by product. No exchanges on clearance items.',
        startDate: daysFromNow(-3),
        endDate: daysFromNow(7),
        status: 'active',
      },
    ],
    [
      shops.TechNova,
      superAdmin.id,
      {
        title: 'Wireless earbuds at ₹1,999 instead of ₹3,499',
        productName: 'TechNova Buds Air',
        description: 'Launch pricing on the new true-wireless earbuds.',
        offerText: '₹1,999 instead of ₹3,499',
        offerType: 'price_drop',
        discountType: 'flat',
        discountValue: 1500,
        originalPrice: 3499,
        discountedPrice: 1999,
        category: 'Electronics',
        terms: 'Launch pricing, limited to 100 units per branch.',
        startDate: daysFromNow(2),
        endDate: daysFromNow(30),
        status: 'scheduled',
      },
    ],
  ];

  for (const [shop, createdBy, offer] of offers) {
    await seedDemoOffer(shop, createdBy, offer);
  }

  await execute('INSERT IGNORE INTO followed_shops (user_id, shop_id) VALUES (?, ?)', [priya.id, zara.id]);
  await execute(
    `INSERT IGNORE INTO followed_categories (user_id, category_id)
     SELECT ?, id FROM categories WHERE name = 'Electronics'`,
    [priya.id],
  );

  // Demo shops are put on their plans by `seedSubscriptions`, which also writes
  // the billing state the v3 subscription model needs. It already spreads the
  // demo shops across Premium, Business and Free, so the AI gating is visible
  // without a second assignment here - and a second writer is exactly what
  // would let the billing row and the AI view disagree.

  console.log('  demo shops: %s', Object.keys(shops).join(', '));
  console.log('  demo plans: Zara = PREMIUM, TechNova = BUSINESS, FreshMart = FREE');
  console.log('  demo users: john@zara.com / ShopAdmin@123, priya@example.com / Customer@123');
}


// ---------------------------------------------------------------------------
// V3 - subscriptions, campaigns and enough analytics history to demo with
// ---------------------------------------------------------------------------

/** The plan each demo shop sits on, so all three tiers are visible at once. */
const DEMO_PLANS = {
  Zara: 'PREMIUM',
  FreshMart: 'BUSINESS',
  TechNova: 'FREE',
};

async function seedSubscriptions() {
  // Every shop needs a row; the demo shops then get their headline plan.
  await execute(
    `INSERT INTO shop_subscriptions (shop_id, plan, status, price_amount, payment_status)
     SELECT s.id, 'FREE', 'active', 0.00, 'not_required' FROM shops s
      WHERE NOT EXISTS (SELECT 1 FROM shop_subscriptions sub WHERE sub.shop_id = s.id)`,
  );

  for (const [shopName, planKey] of Object.entries(DEMO_PLANS)) {
    const shop = await queryOne('SELECT id FROM shops WHERE slug = ?', [slugify(shopName)]);
    if (!shop) continue;

    const plan = PLANS[planKey];
    await execute(
      `UPDATE shop_subscriptions
          SET plan = ?, status = 'active', price_amount = ?, billing_cycle = 'monthly',
              payment_status = ?, started_at = DATE_SUB(NOW(), INTERVAL 45 DAY),
              renews_at = DATE_ADD(NOW(), INTERVAL 15 DAY)
        WHERE shop_id = ?`,
      [plan.key, plan.price, plan.price > 0 ? 'paid' : 'not_required', shop.id],
    );

    // One history row so the Billing screen is not empty on a fresh install.
    const existing = await queryOne('SELECT id FROM subscription_events WHERE shop_id = ?', [shop.id]);
    if (!existing && plan.price > 0) {
      await execute(
        `INSERT INTO subscription_events (shop_id, from_plan, to_plan, action, amount, created_at)
         VALUES (?, 'FREE', ?, 'upgraded', ?, DATE_SUB(NOW(), INTERVAL 45 DAY))`,
        [shop.id, plan.key, plan.price],
      );
    }
  }

  console.log('  subscriptions: %s', Object.entries(DEMO_PLANS).map(([k, v]) => `${k}=${v}`).join(', '));
}

/**
 * Generates ~60 days of engagement for the Premium demo shop.
 *
 * Real dashboards are meaningless against an empty database, and §34 asks for
 * honest empty states rather than fabricated charts - so this exists only under
 * SEED_DEMO_DATA, and only for the demo tenant.
 *
 * The generator is deterministic (a seeded PRNG) so two runs produce the same
 * numbers, and it is skipped entirely once history already exists.
 */
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

async function seedAnalyticsHistory() {
  const shop = await queryOne('SELECT id FROM shops WHERE slug = ?', [slugify('Zara')]);
  if (!shop) return;

  // Look far enough back that ordinary demo browsing cannot be mistaken for a
  // previous run of this generator - it is the only thing that writes events
  // older than a month.
  const already = await queryOne(
    `SELECT COUNT(*) AS count FROM offer_views v JOIN offers o ON o.id = v.offer_id
      WHERE o.shop_id = ? AND v.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    [shop.id],
  );
  if (Number(already.count) > 0) {
    console.log('  analytics history: already present, skipped');
    return;
  }

  const offers = await query("SELECT id FROM offers WHERE shop_id = ? AND status = 'active'", [shop.id]);
  const branches = await query('SELECT id, city FROM shop_branches WHERE shop_id = ?', [shop.id]);
  const customers = await query(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id AND r.name = 'CUSTOMER' LIMIT 25`,
  );
  if (!offers.length || !branches.length || !customers.length) return;

  const random = makeRandom(20260812);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const DAYS = 60;

  const viewRows = [];
  const claimRows = [];
  const seen = new Set();

  for (let dayOffset = DAYS; dayOffset >= 1; dayOffset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - dayOffset);
    // Weekends carry more traffic, which is what makes the "best day to post"
    // dashboard show a real pattern rather than noise.
    const weekendBoost = [0, 6].includes(date.getDay()) ? 1.8 : 1;
    const impressions = Math.round((12 + random() * 20) * weekendBoost);

    for (let index = 0; index < impressions; index += 1) {
      const offer = pick(offers);
      const branch = pick(branches);
      const customer = pick(customers);
      const at = new Date(date);
      // Evenings skew busier, so §18's "best time" has something to find.
      at.setHours(random() < 0.45 ? 18 + Math.floor(random() * 3) : Math.floor(random() * 24));
      at.setMinutes(Math.floor(random() * 60));

      viewRows.push([offer.id, customer.id, branch.id, 'impression', branch.city, at]);
      if (random() < 0.42) {
        viewRows.push([offer.id, customer.id, branch.id, 'view', branch.city, at]);

        if (random() < 0.07) {
          const key = `${customer.id}:${offer.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            claimRows.push([offer.id, customer.id, branch.id, at, random() < 0.46]);
          }
        }
      }
    }
  }

  // Inserted in batches: a row-at-a-time loop over a couple of thousand events
  // turns a two-second seed into a two-minute one.
  for (let index = 0; index < viewRows.length; index += 200) {
    const chunk = viewRows.slice(index, index + 200);
    await rawQuery(
      `INSERT INTO offer_views (offer_id, user_id, branch_id, event_type, city, created_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      chunk.flat(),
    );
  }

  for (const [offerId, userId, branchId, at, redeemed] of claimRows) {
    await execute(
      `INSERT IGNORE INTO offer_claims (offer_id, user_id, branch_id, code, status, claimed_at, redeemed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        offerId,
        userId,
        branchId,
        `DEMO${String(offerId).padStart(3, '0')}${String(userId).padStart(3, '0')}`.slice(0, 24),
        redeemed ? 'redeemed' : 'claimed',
        at,
        redeemed ? at : null,
      ],
    );
  }

  // Rebuild the customer roll-up from the events just generated, so the
  // new-vs-returning split matches the history rather than today's date.
  await execute(
    `INSERT INTO shop_customers (shop_id, user_id, first_seen_at, last_seen_at, visit_count)
     SELECT o.shop_id, v.user_id, MIN(v.created_at), MAX(v.created_at), COUNT(*)
       FROM offer_views v JOIN offers o ON o.id = v.offer_id
      WHERE v.user_id IS NOT NULL AND o.shop_id = ?
      GROUP BY o.shop_id, v.user_id
     ON DUPLICATE KEY UPDATE first_seen_at = VALUES(first_seen_at),
                             last_seen_at  = VALUES(last_seen_at),
                             visit_count   = VALUES(visit_count)`,
    [shop.id],
  );
  await execute(
    `UPDATE shop_customers sc
        SET sc.claim_count = (SELECT COUNT(*) FROM offer_claims c JOIN offers o ON o.id = c.offer_id
                               WHERE o.shop_id = sc.shop_id AND c.user_id = sc.user_id),
            sc.redeem_count = (SELECT COUNT(*) FROM offer_claims c JOIN offers o ON o.id = c.offer_id
                                WHERE o.shop_id = sc.shop_id AND c.user_id = sc.user_id
                                  AND c.status = 'redeemed'),
            sc.save_count = (SELECT COUNT(*) FROM favorites f JOIN offers o ON o.id = f.offer_id
                              WHERE o.shop_id = sc.shop_id AND f.user_id = sc.user_id)
      WHERE sc.shop_id = ?`,
    [shop.id],
  );

  console.log('  analytics history: %d events, %d claims', viewRows.length, claimRows.length);
}

async function seedCampaign() {
  const shop = await queryOne('SELECT id FROM shops WHERE slug = ?', [slugify('Zara')]);
  if (!shop) return;

  const existing = await queryOne('SELECT id FROM campaigns WHERE shop_id = ?', [shop.id]);
  if (existing) return;

  const result = await execute(
    `INSERT INTO campaigns (shop_id, name, description, start_date, end_date, cost,
                            avg_order_value, avg_margin_percent, status)
     VALUES (?, 'Season End Sale', 'Season-end promotion across clothing and footwear.',
             DATE_SUB(NOW(), INTERVAL 30 DAY), DATE_ADD(NOW(), INTERVAL 15 DAY),
             5000.00, 1800.00, 35.00, 'running')`,
    [shop.id],
  );

  // Attaching the shop's live offers is what gives the ROI dashboard (§25)
  // something to attribute redemptions to.
  await execute(
    `INSERT IGNORE INTO campaign_offers (campaign_id, offer_id)
     SELECT ?, id FROM offers WHERE shop_id = ? AND status = 'active'`,
    [result.insertId, shop.id],
  );
  await execute(
    `UPDATE banners b JOIN offers o ON o.id = b.offer_id
        SET b.campaign_id = ? WHERE o.shop_id = ? AND b.campaign_id IS NULL`,
    [result.insertId, shop.id],
  );

  console.log('  campaign: Season End Sale');
}

async function main() {
  console.log('Seeding %s ...', env.db.database);
  await seedPermissions();
  await seedRoles();
  await seedCategories();
  await seedNotificationThresholds();
  // AI entitlements per plan code. Independent of `shop_subscriptions`, which
  // v3 seeds with the plan a shop is actually paying for.
  await seedPlans();
  const superAdmin = await seedSuperAdmin();

  if (env.seed.demoData) {
    await seedDemoData(superAdmin);
  }

  // ---- V3 ----
  await seedSubscriptions();
  if (env.seed.demoData) {
    await seedAnalyticsHistory();
    await seedCampaign();
  }

  const counts = await query(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM shops) AS shops,
            (SELECT COUNT(*) FROM offers) AS offers`,
  );
  console.log('Done. %d users, %d shops, %d offers.', counts[0].users, counts[0].shops, counts[0].offers);
  await pool.end();
}

main().catch(async (error) => {
  console.error('Seed failed:', error);
  await pool.end().catch(() => {});
  process.exit(1);
});
