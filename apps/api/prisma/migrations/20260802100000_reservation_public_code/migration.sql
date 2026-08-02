-- The capability code behind /mon-voyage/{code}.
--
-- Additive and reversible: a nullable column plus a unique index. Existing
-- reservations keep NULL and simply have no shareable link yet — Postgres
-- allows any number of NULLs under a unique index, so no backfill is needed
-- and nothing has to invent random values inside a migration.

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "publicCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "reservations_publicCode_key" ON "reservations"("publicCode");
