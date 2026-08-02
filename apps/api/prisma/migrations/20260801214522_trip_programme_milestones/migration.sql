-- CreateEnum
CREATE TYPE "MilestoneKind" AS ENUM ('meeting', 'transport', 'flight', 'hotel', 'ritual', 'ziyara', 'meal', 'free_time', 'other');

-- CreateEnum
CREATE TYPE "CheckpointType" AS ENUM ('none', 'mandatory', 'optional');

-- CreateTable
CREATE TABLE "offer_milestones" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" "MilestoneKind" NOT NULL DEFAULT 'other',
    "dayOffset" INTEGER NOT NULL DEFAULT 0,
    "timeOfDay" TEXT,
    "locationName" TEXT,
    "meetingPoint" TEXT,
    "mapUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "checkpointType" "CheckpointType" NOT NULL DEFAULT 'none',
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "offer_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_check_ins" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'expected',
    "checkedInAt" TIMESTAMP(3),
    "checkedInByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "milestone_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_milestones_offerId_dayOffset_sortOrder_idx" ON "offer_milestones"("offerId", "dayOffset", "sortOrder");

-- CreateIndex
CREATE INDEX "offer_milestones_agencyId_idx" ON "offer_milestones"("agencyId");

-- CreateIndex
CREATE INDEX "milestone_check_ins_agencyId_idx" ON "milestone_check_ins"("agencyId");

-- CreateIndex
CREATE INDEX "milestone_check_ins_reservationId_idx" ON "milestone_check_ins"("reservationId");

-- CreateIndex
CREATE INDEX "milestone_check_ins_milestoneId_status_idx" ON "milestone_check_ins"("milestoneId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "milestone_check_ins_milestoneId_reservationId_key" ON "milestone_check_ins"("milestoneId", "reservationId");

-- AddForeignKey
ALTER TABLE "offer_milestones" ADD CONSTRAINT "offer_milestones_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_check_ins" ADD CONSTRAINT "milestone_check_ins_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "offer_milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_check_ins" ADD CONSTRAINT "milestone_check_ins_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
