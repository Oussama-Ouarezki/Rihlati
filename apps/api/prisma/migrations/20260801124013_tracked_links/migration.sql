-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "trackedLinkId" TEXT;

-- CreateTable
CREATE TABLE "tracked_links" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "offerId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "inquiryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tracked_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracked_links_code_key" ON "tracked_links"("code");

-- CreateIndex
CREATE INDEX "tracked_links_agencyId_deletedAt_idx" ON "tracked_links"("agencyId", "deletedAt");

-- CreateIndex
CREATE INDEX "leads_trackedLinkId_idx" ON "leads"("trackedLinkId");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "tracked_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
