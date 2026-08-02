-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('expected', 'checked_in', 'no_show', 'cancelled');

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "peopleCount" INTEGER NOT NULL DEFAULT 1,
    "status" "ReservationStatus" NOT NULL DEFAULT 'expected',
    "checkedInAt" TIMESTAMP(3),
    "checkedInByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservations_leadId_key" ON "reservations"("leadId");

-- CreateIndex
CREATE INDEX "reservations_agencyId_offerId_status_idx" ON "reservations"("agencyId", "offerId", "status");

-- CreateIndex
CREATE INDEX "reservations_offerId_status_idx" ON "reservations"("offerId", "status");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-added CHECKs (Prisma cannot express them; same policy as
-- 20260801090500_check_constraints — the database refuses states that are
-- nonsense, whatever code produced them).

-- A reservation for zero people is not a reservation.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_people_count_positive" CHECK ("peopleCount" > 0);

-- Phones are E.164 everywhere, or dedup against leads breaks silently.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_phone_e164" CHECK ("contactPhone" ~ '^\+[1-9][0-9]{6,14}$');
