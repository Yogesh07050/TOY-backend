'use strict';

const service = require('./premium.service');

/**
 * Report definitions for the Reports dashboard (V3 §26).
 *
 * Each report reuses the dashboard query that produces the same numbers on
 * screen, then flattens the result into columns. That is deliberate: an export
 * that disagrees with the dashboard it was taken from is worse than no export.
 */

const percent = (value) => (value === null || value === undefined ? '' : `${value}%`);

const REPORT_TYPES = [
  {
    key: 'offer-performance',
    label: 'Offer Performance',
    description: 'Views, saves, claims, redemptions and conversion for every offer.',
    columns: [
      { key: 'title', label: 'Offer' },
      { key: 'category', label: 'Category' },
      { key: 'status', label: 'Status' },
      { key: 'impressions', label: 'Impressions' },
      { key: 'views', label: 'Views' },
      { key: 'saves', label: 'Saves' },
      { key: 'shares', label: 'Shares' },
      { key: 'claims', label: 'Claims' },
      { key: 'redemptions', label: 'Redemptions' },
      { key: 'conversionRate', label: 'View to claim' },
      { key: 'redemptionRate', label: 'Claim to redemption' },
      { key: 'endDate', label: 'Ends' },
    ],
    build: async (context) => {
      const data = await service.offerPerformance(context, { limit: 200 });
      return data.offers.map((offer) => ({
        title: offer.title,
        category: offer.category ?? '',
        status: offer.status,
        impressions: offer.impressions,
        views: offer.views,
        saves: offer.saves,
        shares: offer.shares,
        claims: offer.claims,
        redemptions: offer.redemptions,
        conversionRate: percent(offer.rates.viewToClaim),
        redemptionRate: percent(offer.rates.claimToRedemption),
        endDate: offer.endDate,
      }));
    },
  },

  {
    key: 'customer-engagement',
    label: 'Customer Engagement',
    description: 'Reach, new and returning customers, segments and interests.',
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value' },
      { key: 'share', label: 'Share' },
    ],
    build: async (context) => {
      const data = await service.customerInsights(context);
      return [
        { metric: 'Total reach', value: data.totals.reach, share: '' },
        { metric: 'New customers', value: data.totals.newCustomers, share: percent(data.split.newPercent) },
        {
          metric: 'Returning customers',
          value: data.totals.returningCustomers,
          share: percent(data.split.returningPercent),
        },
        { metric: 'Customers who saved', value: data.totals.savingCustomers, share: '' },
        { metric: 'Customers who claimed', value: data.totals.claimingCustomers, share: '' },
        { metric: 'Customers who redeemed', value: data.totals.redeemingCustomers, share: '' },
        ...data.segments.map((segment) => ({
          metric: `Segment: ${segment.label}`,
          value: segment.customers,
          share: '',
        })),
        ...data.interests.map((interest) => ({
          metric: `Interest: ${interest.category}`,
          value: interest.interactions,
          share: percent(interest.percent),
        })),
      ];
    },
  },

  {
    key: 'location-performance',
    label: 'Location Performance',
    description: 'Views, claims and redemptions by customer location.',
    columns: [
      { key: 'city', label: 'Location' },
      { key: 'views', label: 'Views' },
      { key: 'claims', label: 'Claims' },
      { key: 'redemptions', label: 'Redemptions' },
      { key: 'customers', label: 'Customers' },
      { key: 'conversion', label: 'Conversion' },
    ],
    build: async (context) => {
      const data = await service.locationInsights(context);
      return data.locations.map((location) => ({
        city: location.city,
        views: location.views,
        claims: location.claims,
        redemptions: location.redemptions,
        customers: location.customers,
        conversion: percent(location.conversion),
      }));
    },
  },

  {
    key: 'branch-performance',
    label: 'Branch Performance',
    description: 'Per-branch views, claims, redemptions and top offer.',
    columns: [
      { key: 'branchName', label: 'Branch' },
      { key: 'city', label: 'City' },
      { key: 'activeOffers', label: 'Active offers' },
      { key: 'views', label: 'Views' },
      { key: 'customers', label: 'Customer reach' },
      { key: 'claims', label: 'Claims' },
      { key: 'redemptions', label: 'Redemptions' },
      { key: 'conversion', label: 'Conversion' },
      { key: 'topOffer', label: 'Top offer' },
    ],
    build: async (context) => {
      const data = await service.branchPerformance(context);
      return data.branches.map((branch) => ({
        branchName: branch.branchName,
        city: branch.city ?? '',
        activeOffers: branch.activeOffers,
        views: branch.views,
        customers: branch.customers,
        claims: branch.claims,
        redemptions: branch.redemptions,
        conversion: percent(branch.conversion),
        topOffer: branch.topOffer?.title ?? '',
      }));
    },
  },

  {
    key: 'campaign-performance',
    label: 'Campaign Performance',
    description: 'Banner and campaign impressions, clicks, CTR and attributed offer activity.',
    columns: [
      { key: 'title', label: 'Banner' },
      { key: 'campaignName', label: 'Campaign' },
      { key: 'status', label: 'Status' },
      { key: 'impressions', label: 'Impressions' },
      { key: 'clicks', label: 'Clicks' },
      { key: 'ctr', label: 'CTR' },
      { key: 'offerViews', label: 'Offer views' },
      { key: 'offerClaims', label: 'Offer claims' },
      { key: 'offerRedemptions', label: 'Offer redemptions' },
    ],
    build: async (context) => {
      const data = await service.campaignPerformance(context);
      return data.banners.map((banner) => ({
        title: banner.title,
        campaignName: banner.campaignName ?? '',
        status: banner.status,
        impressions: banner.impressions,
        clicks: banner.clicks,
        ctr: percent(banner.ctr),
        offerViews: banner.offerViews,
        offerClaims: banner.offerClaims,
        offerRedemptions: banner.offerRedemptions,
      }));
    },
  },

  {
    key: 'customer-trends',
    label: 'Customer Trends',
    description: 'Acquisition and retention over the selected period.',
    columns: [
      { key: 'period', label: 'Period' },
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value' },
    ],
    build: async (context) => {
      const [acquisition, retention] = await Promise.all([
        service.acquisition(context),
        service.retention(context),
      ]);

      return [
        ...acquisition.timeline.map((point) => ({
          period: point.day,
          metric: 'New customers',
          value: point.customers,
        })),
        ...retention.timeline.map((point) => ({
          period: point.month,
          metric: 'Returning customer rate',
          value: percent(point.returningRate),
        })),
        { period: 'Summary', metric: 'Returning customer rate', value: percent(retention.returningRate) },
        { period: 'Summary', metric: 'Repeat claim rate', value: percent(retention.repeatClaimRate) },
        {
          period: 'Summary',
          metric: 'Repeat redemption rate',
          value: percent(retention.repeatRedemptionRate),
        },
        {
          period: 'Summary',
          metric: 'Average visits per customer',
          value: retention.averageVisitsPerCustomer,
        },
      ];
    },
  },

  {
    key: 'claims-redemptions',
    label: 'Claims & Redemptions',
    description: 'Claim and redemption counts and rates per offer.',
    columns: [
      { key: 'title', label: 'Offer' },
      { key: 'status', label: 'Status' },
      { key: 'claims', label: 'Claims' },
      { key: 'redemptions', label: 'Redemptions' },
      { key: 'outstanding', label: 'Unredeemed' },
      { key: 'redemptionRate', label: 'Redemption rate' },
    ],
    build: async (context) => {
      const data = await service.offerPerformance(context, { limit: 200, sort: 'claims' });
      return data.offers
        .filter((offer) => offer.claims > 0)
        .map((offer) => ({
          title: offer.title,
          status: offer.status,
          claims: offer.claims,
          redemptions: offer.redemptions,
          outstanding: offer.claims - offer.redemptions,
          redemptionRate: percent(offer.rates.claimToRedemption),
        }));
    },
  },
];

const BY_KEY = new Map(REPORT_TYPES.map((type) => [type.key, type]));

async function build(key, context) {
  const type = BY_KEY.get(key);
  if (!type) throw new Error(`Unknown report type: ${key}`);
  return { columns: type.columns, rows: await type.build(context), label: type.label };
}

module.exports = { REPORT_TYPES, build };
