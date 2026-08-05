-- AlterTable
ALTER TABLE "agencies" ADD COLUMN     "submittedForReviewAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "agencies_status_submittedForReviewAt_idx" ON "agencies"("status", "submittedForReviewAt");
