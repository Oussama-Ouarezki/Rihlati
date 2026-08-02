import { describe, expect, it } from 'vitest';
import { AGENCY_PLANS } from './enums';
import {
  PLAN_LIMITS,
  canPublishAnotherOffer,
  cheapestPlanWith,
  hasFeature,
  planLimitsSchema,
  resolvePublishedOfferLimit,
} from './plans';

describe('PLAN_LIMITS', () => {
  it('defines limits for every plan', () => {
    for (const plan of AGENCY_PLANS) {
      expect(planLimitsSchema.safeParse(PLAN_LIMITS[plan]).success, plan).toBe(true);
    }
  });

  it('never caps leads on any plan', () => {
    // Capping leads caps the value the agency pays for, and strands the
    // traveler whose inquiry goes nowhere. Sell capacity, not fewer customers.
    for (const plan of AGENCY_PLANS) {
      expect(PLAN_LIMITS[plan].maxLeadsPerMonth, plan).toBeNull();
    }
  });

  it('gets more permissive as the plan gets more expensive', () => {
    expect(PLAN_LIMITS.free.maxPublishedOffers).toBeLessThan(
      PLAN_LIMITS.pro.maxPublishedOffers ?? Infinity,
    );
    expect(PLAN_LIMITS.business.maxPublishedOffers).toBeNull(); // unlimited
  });
});

describe('resolvePublishedOfferLimit', () => {
  it('uses the plan default when there is no override', () => {
    expect(resolvePublishedOfferLimit('free')).toBe(5);
    expect(resolvePublishedOfferLimit('free', null)).toBe(5);
    expect(resolvePublishedOfferLimit('free', undefined)).toBe(5);
  });

  it('lets an override raise the cap for a negotiated deal', () => {
    expect(resolvePublishedOfferLimit('free', 50)).toBe(50);
  });

  it('lets an override of 0 actually mean zero, not "falsy so use the default"', () => {
    // The bug this guards against: `override || PLAN_LIMITS[plan].max` would
    // treat 0 as "not set" and hand a suspended agency the full free quota.
    expect(resolvePublishedOfferLimit('pro', 0)).toBe(0);
  });
});

describe('canPublishAnotherOffer', () => {
  it('allows publishing below the limit', () => {
    expect(canPublishAnotherOffer(4, 5)).toBe(true);
  });

  it('blocks publishing AT the limit', () => {
    // Off-by-one check: 5 published against a limit of 5 means full.
    expect(canPublishAnotherOffer(5, 5)).toBe(false);
    expect(canPublishAnotherOffer(6, 5)).toBe(false);
  });

  it('always allows when the limit is unlimited', () => {
    expect(canPublishAnotherOffer(9999, null)).toBe(true);
  });

  it('blocks everything at a limit of zero', () => {
    expect(canPublishAnotherOffer(0, 0)).toBe(false);
  });
});

describe('feature gates', () => {
  it('reflects the premium CRM tier', () => {
    expect(hasFeature('free', 'crmPipelineBoard')).toBe(false);
    expect(hasFeature('pro', 'crmPipelineBoard')).toBe(true);
  });

  it('names the cheapest plan that unlocks a feature, for upgrade prompts', () => {
    expect(cheapestPlanWith('crmPipelineBoard')).toBe('pro');
    expect(cheapestPlanWith('leadExport')).toBe('pro');
  });
});
