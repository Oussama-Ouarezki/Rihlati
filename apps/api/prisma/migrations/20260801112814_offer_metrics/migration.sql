-- CreateTable
CREATE TABLE "offer_metrics_daily" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "whatsappClicks" INTEGER NOT NULL DEFAULT 0,
    "phoneClicks" INTEGER NOT NULL DEFAULT 0,
    "inquiries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "offer_metrics_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_metrics_daily_agencyId_date_idx" ON "offer_metrics_daily"("agencyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "offer_metrics_daily_offerId_date_key" ON "offer_metrics_daily"("offerId", "date");

-- AddForeignKey
ALTER TABLE "offer_metrics_daily" ADD CONSTRAINT "offer_metrics_daily_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
