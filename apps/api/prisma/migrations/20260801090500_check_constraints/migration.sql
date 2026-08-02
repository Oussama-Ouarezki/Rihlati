-- CHECK CONSTRAINTS
--
-- Written by hand: Prisma's schema language cannot express these, and they are
-- the guarantees that survive a bug in the API, a bad seed script, a psql
-- session at 2am, and every future import job.
--
-- Validation in Zod stops bad data at the door. A CHECK constraint means the
-- door is not the only lock. Money is the clearest case: a negative price is
-- not a validation failure to be reported, it is a state the database should
-- refuse to hold.

-- ---------------------------------------------------------------------------
-- Reviews: the rating scale is 1..5, and the schema comment has always said so.
-- ---------------------------------------------------------------------------
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- ---------------------------------------------------------------------------
-- Denormalized rating counters must stay internally consistent, or the average
-- shown next to an agency's name is a lie. ratingSum <= 5 * ratingCount is the
-- strongest statement that holds for any set of 1..5 ratings.
-- ---------------------------------------------------------------------------
ALTER TABLE "agencies"
  ADD CONSTRAINT "agencies_rating_counters" CHECK (
    "ratingCount" >= 0
    AND "ratingSum" >= "ratingCount"
    AND "ratingSum" <= 5 * "ratingCount"
  );

ALTER TABLE "agencies"
  ADD CONSTRAINT "agencies_moderation_counters" CHECK (
    "suspectedDuplicateCount" >= 0 AND "openReportCount" >= 0
  );

-- A plan override of 0 is meaningful ("this agency may publish nothing");
-- a negative one is not.
ALTER TABLE "agencies"
  ADD CONSTRAINT "agencies_offer_limit_override_non_negative" CHECK (
    "publishedOfferLimitOverride" IS NULL OR "publishedOfferLimitOverride" >= 0
  );

ALTER TABLE "agencies"
  ADD CONSTRAINT "agencies_credit_non_negative" CHECK ("creditBalanceCentimes" >= 0);

-- ---------------------------------------------------------------------------
-- Offers. Money is integer centimes and can never be negative (CLAUDE.md).
-- ---------------------------------------------------------------------------
ALTER TABLE "offers"
  ADD CONSTRAINT "offers_price_non_negative" CHECK (
    "priceFromCentimes" >= 0
    AND ("priceToCentimes" IS NULL OR "priceToCentimes" >= 0)
  );

-- A "from 300 000, to 200 000" price range is not a typo to display, it is
-- nonsense. Rejected at the database.
ALTER TABLE "offers"
  ADD CONSTRAINT "offers_price_range_ordered" CHECK (
    "priceToCentimes" IS NULL OR "priceToCentimes" >= "priceFromCentimes"
  );

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_dates_ordered" CHECK (
    "departureDate" IS NULL OR "returnDate" IS NULL OR "returnDate" >= "departureDate"
  );

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_seats_coherent" CHECK (
    ("seatsTotal" IS NULL OR "seatsTotal" >= 0)
    AND ("seatsLeft" IS NULL OR "seatsLeft" >= 0)
    AND ("seatsTotal" IS NULL OR "seatsLeft" IS NULL OR "seatsLeft" <= "seatsTotal")
  );

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_quality_score_range" CHECK ("qualityScore" BETWEEN 0 AND 100);

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_report_count_non_negative" CHECK ("reportCount" >= 0);

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_duration_positive" CHECK (
    "durationDays" IS NULL OR "durationDays" > 0
  );

-- An offer cannot be a duplicate of itself. Cheap to state, and it closes a
-- self-referencing loop that would make the moderation queue recurse.
ALTER TABLE "offers"
  ADD CONSTRAINT "offers_not_own_duplicate" CHECK (
    "duplicateOfOfferId" IS NULL OR "duplicateOfOfferId" <> "id"
  );

-- ---------------------------------------------------------------------------
-- Duplicate candidates: an ordered pair of two DIFFERENT offers. The ordering
-- is what makes the unique index catch (A,B) and (B,A) as the same pair.
-- ---------------------------------------------------------------------------
ALTER TABLE "offer_duplicate_candidates"
  ADD CONSTRAINT "duplicate_candidates_distinct_ordered" CHECK (
    "leftOfferId" < "rightOfferId"
  );

ALTER TABLE "offer_duplicate_candidates"
  ADD CONSTRAINT "duplicate_candidates_similarity_range" CHECK (
    "similarity" >= 0 AND "similarity" <= 1
  );

-- ---------------------------------------------------------------------------
-- Leads. These hold real people's phone numbers and real money figures.
-- ---------------------------------------------------------------------------
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_money_non_negative" CHECK (
    ("budgetCentimes" IS NULL OR "budgetCentimes" >= 0)
    AND ("estimatedValueCentimes" IS NULL OR "estimatedValueCentimes" >= 0)
    AND ("actualValueCentimes" IS NULL OR "actualValueCentimes" >= 0)
  );

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_people_count_positive" CHECK (
    "peopleCount" IS NULL OR "peopleCount" > 0
  );

-- Phone numbers are E.164, always. This is the constraint that makes
-- "+213551234567" the only representation that can exist in the column —
-- without it, one forgotten normalization call reintroduces "0551234567" and
-- the same client silently becomes two clients.
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_phone_e164" CHECK ("contactPhone" ~ '^\+[1-9][0-9]{6,14}$');

ALTER TABLE "users"
  ADD CONSTRAINT "users_phone_e164" CHECK (
    "phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$'
  );

-- A user must be reachable somehow, or the account can never be recovered and
-- can never be logged into.
ALTER TABLE "users"
  ADD CONSTRAINT "users_has_identifier" CHECK (
    "email" IS NOT NULL OR "phone" IS NOT NULL
  );
