-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('ar', 'fr', 'en');

-- CreateEnum
CREATE TYPE "AgencyStatus" AS ENUM ('draft', 'pending_review', 'verified', 'rejected', 'suspended');

-- CreateEnum
CREATE TYPE "AgencyPlan" AS ENUM ('free', 'pro', 'business');

-- CreateEnum
CREATE TYPE "AgencyRole" AS ENUM ('owner', 'manager', 'agent');

-- CreateEnum
CREATE TYPE "OfferKind" AS ENUM ('omra', 'hajj', 'package', 'visa', 'flight', 'hotel', 'transport');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('draft', 'pending_review', 'published', 'paused', 'archived', 'rejected');

-- CreateEnum
CREATE TYPE "DuplicateStatus" AS ENUM ('none', 'suspected', 'confirmed', 'dismissed');

-- CreateEnum
CREATE TYPE "DuplicateVerdict" AS ENUM ('pending', 'confirmed_duplicate', 'not_duplicate');

-- CreateEnum
CREATE TYPE "OfferReportReason" AS ENUM ('duplicate_spam', 'misleading_price', 'scam_suspicion', 'wrong_information', 'expired', 'inappropriate', 'other');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('pending', 'actioned', 'dismissed');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('new', 'contacted', 'quoted', 'negotiating', 'booked', 'paid', 'travelled', 'lost');

-- CreateEnum
CREATE TYPE "LeadQuality" AS ENUM ('unrated', 'spam', 'troll', 'cold', 'warm', 'serious', 'vip');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('marketplace_inquiry', 'direct_call', 'walk_in', 'whatsapp', 'referral', 'import');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'published', 'rejected');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT,
    "displayName" TEXT NOT NULL,
    "locale" "Locale" NOT NULL DEFAULT 'fr',
    "avatarUrl" TEXT,
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "phoneVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agencies" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "description" TEXT,
    "logoUrl" TEXT,
    "status" "AgencyStatus" NOT NULL DEFAULT 'draft',
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "rejectionReason" TEXT,
    "registreCommerce" TEXT,
    "nif" TEXT,
    "tourismLicence" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "websiteUrl" TEXT,
    "addressLine" TEXT,
    "city" TEXT,
    "wilayaCode" TEXT,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "plan" "AgencyPlan" NOT NULL DEFAULT 'free',
    "publishedOfferLimitOverride" INTEGER,
    "creditBalanceCentimes" INTEGER NOT NULL DEFAULT 0,
    "suspectedDuplicateCount" INTEGER NOT NULL DEFAULT 0,
    "openReportCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "role" "AgencyRole" NOT NULL DEFAULT 'agent',
    "invitedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "kind" "OfferKind" NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "summary" TEXT,
    "description" TEXT,
    "priceFromCentimes" INTEGER NOT NULL,
    "priceToCentimes" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'DZD',
    "departureDate" DATE,
    "returnDate" DATE,
    "durationDays" INTEGER,
    "isFlexibleDates" BOOLEAN NOT NULL DEFAULT false,
    "departureWilayaCode" TEXT,
    "destinationCountry" TEXT,
    "destinationCity" TEXT,
    "seatsTotal" INTEGER,
    "seatsLeft" INTEGER,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "media" JSONB NOT NULL DEFAULT '[]',
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "featuredUntil" TIMESTAMP(3),
    "qualityScore" INTEGER NOT NULL DEFAULT 0,
    "fingerprint" CHAR(64),
    "duplicateStatus" "DuplicateStatus" NOT NULL DEFAULT 'none',
    "duplicateOfOfferId" TEXT,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_duplicate_candidates" (
    "id" TEXT NOT NULL,
    "leftOfferId" TEXT NOT NULL,
    "rightOfferId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "verdict" "DuplicateVerdict" NOT NULL DEFAULT 'pending',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_duplicate_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_reports" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "reporterUserId" TEXT,
    "reporterIpHash" TEXT,
    "reason" "OfferReportReason" NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'pending',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_offers" (
    "userId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_offers_pkey" PRIMARY KEY ("userId","offerId")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "offerId" TEXT,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactEmail" TEXT,
    "travelerUserId" TEXT,
    "message" TEXT,
    "peopleCount" INTEGER,
    "preferredDepartureDate" DATE,
    "budgetCentimes" INTEGER,
    "consentGivenAt" TIMESTAMP(3) NOT NULL,
    "consentTextVersion" TEXT NOT NULL,
    "consentIpHash" TEXT,
    "consentUserAgent" TEXT,
    "stage" "LeadStage" NOT NULL DEFAULT 'new',
    "quality" "LeadQuality" NOT NULL DEFAULT 'unrated',
    "source" "LeadSource" NOT NULL DEFAULT 'marketplace_inquiry',
    "assignedToUserId" TEXT,
    "estimatedValueCentimes" INTEGER,
    "actualValueCentimes" INTEGER,
    "lostReason" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "firstRespondedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_notes" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "lead_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorUserId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_tags" (
    "leadId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("leadId","tagId")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "leadId" TEXT,
    "authorUserId" TEXT,
    "authorName" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "isVerifiedTraveller" BOOLEAN NOT NULL DEFAULT false,
    "agencyReply" TEXT,
    "agencyRepliedAt" TIMESTAMP(3),
    "moderatedByUserId" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "agencyId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipHash" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "agencies_slug_key" ON "agencies"("slug");

-- CreateIndex
CREATE INDEX "agencies_status_idx" ON "agencies"("status");

-- CreateIndex
CREATE INDEX "agencies_wilayaCode_status_idx" ON "agencies"("wilayaCode", "status");

-- CreateIndex
CREATE INDEX "memberships_agencyId_idx" ON "memberships"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_agencyId_key" ON "memberships"("userId", "agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "offers_slug_key" ON "offers"("slug");

-- CreateIndex
CREATE INDEX "offers_status_duplicateStatus_kind_departureDate_idx" ON "offers"("status", "duplicateStatus", "kind", "departureDate");

-- CreateIndex
CREATE INDEX "offers_status_duplicateStatus_destinationCountry_priceFromC_idx" ON "offers"("status", "duplicateStatus", "destinationCountry", "priceFromCentimes");

-- CreateIndex
CREATE INDEX "offers_status_duplicateStatus_departureWilayaCode_departure_idx" ON "offers"("status", "duplicateStatus", "departureWilayaCode", "departureDate");

-- CreateIndex
CREATE INDEX "offers_agencyId_status_updatedAt_idx" ON "offers"("agencyId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "offers_agencyId_fingerprint_idx" ON "offers"("agencyId", "fingerprint");

-- CreateIndex
CREATE INDEX "offer_duplicate_candidates_verdict_similarity_idx" ON "offer_duplicate_candidates"("verdict", "similarity");

-- CreateIndex
CREATE UNIQUE INDEX "offer_duplicate_candidates_leftOfferId_rightOfferId_key" ON "offer_duplicate_candidates"("leftOfferId", "rightOfferId");

-- CreateIndex
CREATE INDEX "offer_reports_status_createdAt_idx" ON "offer_reports"("status", "createdAt");

-- CreateIndex
CREATE INDEX "offer_reports_offerId_status_idx" ON "offer_reports"("offerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "offer_reports_offerId_reporterUserId_key" ON "offer_reports"("offerId", "reporterUserId");

-- CreateIndex
CREATE INDEX "saved_offers_offerId_idx" ON "saved_offers"("offerId");

-- CreateIndex
CREATE INDEX "leads_agencyId_stage_createdAt_idx" ON "leads"("agencyId", "stage", "createdAt");

-- CreateIndex
CREATE INDEX "leads_agencyId_quality_idx" ON "leads"("agencyId", "quality");

-- CreateIndex
CREATE INDEX "leads_agencyId_assignedToUserId_nextActionAt_idx" ON "leads"("agencyId", "assignedToUserId", "nextActionAt");

-- CreateIndex
CREATE INDEX "leads_agencyId_contactPhone_idx" ON "leads"("agencyId", "contactPhone");

-- CreateIndex
CREATE INDEX "leads_offerId_idx" ON "leads"("offerId");

-- CreateIndex
CREATE INDEX "lead_notes_leadId_createdAt_idx" ON "lead_notes"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_notes_agencyId_idx" ON "lead_notes"("agencyId");

-- CreateIndex
CREATE INDEX "lead_activities_leadId_createdAt_idx" ON "lead_activities"("leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tags_agencyId_name_key" ON "tags"("agencyId", "name");

-- CreateIndex
CREATE INDEX "lead_tags_tagId_idx" ON "lead_tags"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_leadId_key" ON "reviews"("leadId");

-- CreateIndex
CREATE INDEX "reviews_agencyId_status_createdAt_idx" ON "reviews"("agencyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_createdAt_idx" ON "audit_logs"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_agencyId_createdAt_idx" ON "audit_logs"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_duplicateOfOfferId_fkey" FOREIGN KEY ("duplicateOfOfferId") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_duplicate_candidates" ADD CONSTRAINT "offer_duplicate_candidates_leftOfferId_fkey" FOREIGN KEY ("leftOfferId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_duplicate_candidates" ADD CONSTRAINT "offer_duplicate_candidates_rightOfferId_fkey" FOREIGN KEY ("rightOfferId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_reports" ADD CONSTRAINT "offer_reports_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_reports" ADD CONSTRAINT "offer_reports_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_offers" ADD CONSTRAINT "saved_offers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_offers" ADD CONSTRAINT "saved_offers_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_travelerUserId_fkey" FOREIGN KEY ("travelerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
