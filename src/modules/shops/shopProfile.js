'use strict';

/**
 * What a shop still has to fill in (V3 §17, §18).
 *
 * Two questions are answered here, and they are deliberately different:
 *
 *   - *May this shop be published?* - the §18 required list, and nothing else.
 *     Every plan has the same answer, Free included: location is a core
 *     feature, not something sold back to a merchant (§29).
 *   - *How complete does the profile look?* - the progress bar in §17, which
 *     counts the optional profile fields too so there is something to aim at
 *     after publishing.
 *
 * Kept out of shop.service.js because both clients render this list and the
 * wording of each row is part of the answer, not presentation.
 */

const REQUIRED = [
  { key: 'name', label: 'Shop name' },
  { key: 'category', label: 'Category' },
  { key: 'address', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'pincode', label: 'Pincode' },
  { key: 'coordinates', label: 'Location on the map' },
];

const OPTIONAL = [
  { key: 'logo', label: 'Shop picture / logo' },
  { key: 'description', label: 'Description' },
  { key: 'phone', label: 'Phone number' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'website', label: 'Website' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'openingHours', label: 'Opening hours' },
];

const filled = (value) => value !== null && value !== undefined && String(value).trim() !== '';

const hasHours = (hours) => Boolean(hours) && Object.keys(hours).length > 0;

/**
 * `shop` is a mapped shop, `branch` its primary location (or null).
 *
 * A required item missing is a blocker; an optional one only moves the bar.
 */
function checklist(shop, branch) {
  const links = shop.socialLinks || {};

  const done = {
    name: filled(shop.name),
    category: (shop.categories?.length ?? 0) > 0,
    address: Boolean(branch) && filled(branch.address),
    city: Boolean(branch) && filled(branch.city),
    pincode: Boolean(branch) && filled(branch.pincode),
    coordinates:
      Boolean(branch) && branch.latitude !== null && branch.longitude !== null,

    logo: filled(shop.logoUrl),
    description: filled(shop.description),
    phone: filled(shop.contactNumber) || Boolean(branch && filled(branch.contactNumber)),
    whatsapp: filled(links.whatsapp),
    website: filled(shop.websiteUrl),
    instagram: filled(links.instagram),
    openingHours: hasHours(shop.openingHours) || Boolean(branch && hasHours(branch.openingHours)),
  };

  const rows = (items, required) =>
    items.map((item) => ({ ...item, required, done: Boolean(done[item.key]) }));

  return [...rows(REQUIRED, true), ...rows(OPTIONAL, false)];
}

/**
 * Progress bar percentage.
 *
 * Required items count double so a shop that is genuinely ready to publish
 * never reads as half finished - the bar is there to encourage the optional
 * extras, not to imply a live shop is broken.
 */
function percentComplete(items) {
  const weight = (item) => (item.required ? 2 : 1);
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  const earned = items.reduce((sum, item) => sum + (item.done ? weight(item) : 0), 0);
  return total === 0 ? 0 : Math.round((earned / total) * 100);
}

/** The §17 panel, and the §18 verdict, in one object for both clients. */
function summarise(shop, branch) {
  const items = checklist(shop, branch);
  const missingRequired = items.filter((item) => item.required && !item.done);

  return {
    percent: percentComplete(items),
    canPublish: missingRequired.length === 0,
    missingRequired: missingRequired.map((item) => item.label),
    items,
  };
}

module.exports = { REQUIRED, OPTIONAL, checklist, percentComplete, summarise };
