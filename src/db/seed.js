'use strict';

/**
 * Seeds reference data (permissions, system roles, categories) and, when
 * SEED_DEMO_DATA is on, a small demo tenant that mirrors the worked example in
 * section 44 of the requirements: Zara with two branches, a store manager, and
 * a "Buy 3 Get 3 Free" offer.
 *
 * Safe to run repeatedly - every insert is an upsert.
 */

const { pool, query, queryOne, execute } = require('./pool');
const env = require('../config/env');
const password = require('../utils/password');
const { PERMISSIONS, SYSTEM_ROLES } = require('../config/permissions');
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
      `INSERT INTO roles (name, description, is_system, status) VALUES (?, ?, 1, 'active')
       ON DUPLICATE KEY UPDATE description = VALUES(description), is_system = 1`,
      [name, config.description],
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

  console.log('  demo shops: %s', Object.keys(shops).join(', '));
  console.log('  demo users: john@zara.com / ShopAdmin@123, priya@example.com / Customer@123');
}

async function main() {
  console.log('Seeding %s ...', env.db.database);
  await seedPermissions();
  await seedRoles();
  await seedCategories();
  const superAdmin = await seedSuperAdmin();

  if (env.seed.demoData) {
    await seedDemoData(superAdmin);
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
