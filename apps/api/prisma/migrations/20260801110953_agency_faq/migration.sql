-- CreateTable
CREATE TABLE "agency_faqs" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "locale" "Locale" NOT NULL DEFAULT 'fr',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_faqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_faqs_agencyId_isEnabled_sortOrder_idx" ON "agency_faqs"("agencyId", "isEnabled", "sortOrder");

-- AddForeignKey
ALTER TABLE "agency_faqs" ADD CONSTRAINT "agency_faqs_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
