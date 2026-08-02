import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { hash as argonHash } from '@node-rs/argon2';
import { normalizeAlgerianPhone, offerFingerprintSource } from '@rihlati/shared';
import { createHash } from 'node:crypto';

/**
 * DEVELOPMENT SEED DATA
 *
 * Gives you something to look at: two verified agencies, one unverified, a
 * handful of offers across kinds, and a few leads in different pipeline stages.
 *
 * Everything here is FAKE. The phone numbers are in Algeria's reserved test
 * ranges and belong to nobody; the RC and NIF values are structurally shaped
 * but invalid. Never seed real agency details, and never seed a real phone
 * number — a dev database gets copied around, and a copy is a leak
 * (CLAUDE.md rule #4).
 */

try {
  process.loadEnvFile(path.resolve(__dirname, '../../../.env'));
} catch {
  // Real environment variables in CI.
}

const prisma = new PrismaClient();

/** The dev password for every seeded account. Local only, and printed below. */
const DEV_PASSWORD = 'rihlati-dev-password';

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  console.log('Seeding…');

  const passwordHash = await argonHash(DEV_PASSWORD, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  // --- people ------------------------------------------------------------
  const admin = await prisma.user.upsert({
    where: { email: 'admin@rihlati.test' },
    update: {},
    create: {
      email: 'admin@rihlati.test',
      passwordHash,
      displayName: 'Rihlati Admin',
      isPlatformAdmin: true,
      emailVerifiedAt: new Date(),
      locale: 'fr',
    },
  });

  const ownerA = await prisma.user.upsert({
    where: { email: 'baraka@rihlati.test' },
    update: {},
    create: {
      email: 'baraka@rihlati.test',
      phone: normalizeAlgerianPhone('0551000001'),
      passwordHash,
      displayName: 'Karim B.',
      emailVerifiedAt: new Date(),
      locale: 'fr',
    },
  });

  const ownerB = await prisma.user.upsert({
    where: { email: 'nour@rihlati.test' },
    update: {},
    create: {
      email: 'nour@rihlati.test',
      phone: normalizeAlgerianPhone('0551000002'),
      passwordHash,
      displayName: 'Nour H.',
      emailVerifiedAt: new Date(),
      locale: 'ar',
    },
  });

  const agentA = await prisma.user.upsert({
    where: { email: 'agent@rihlati.test' },
    update: {},
    create: {
      email: 'agent@rihlati.test',
      passwordHash,
      displayName: 'Sara M.',
      locale: 'fr',
    },
  });

  const traveler = await prisma.user.upsert({
    where: { email: 'voyageur@rihlati.test' },
    update: {},
    create: {
      email: 'voyageur@rihlati.test',
      phone: normalizeAlgerianPhone('0551000003'),
      passwordHash,
      displayName: 'Yacine T.',
      locale: 'fr',
    },
  });

  // --- agencies ----------------------------------------------------------
  const agencyA = await prisma.agency.upsert({
    where: { slug: 'voyages-el-baraka' },
    update: {},
    create: {
      slug: 'voyages-el-baraka',
      name: 'Voyages El Baraka',
      legalName: 'SARL Voyages El Baraka',
      description:
        "Agence de voyages spécialisée Omra et Hajj, basée à Alger. Données de démonstration.",
      status: 'verified',
      verifiedAt: new Date(),
      verifiedByUserId: admin.id,
      registreCommerce: '16/00-0000001B00',
      nif: '000016000000001',
      tourismLicence: 'ATV-16-0001',
      phone: normalizeAlgerianPhone('021000001'),
      whatsapp: normalizeAlgerianPhone('0551000001'),
      email: 'contact@baraka.test',
      city: 'Alger',
      wilayaCode: '16',
      plan: 'free',
      memberships: {
        create: [
          { userId: ownerA.id, role: 'owner', acceptedAt: new Date() },
          { userId: agentA.id, role: 'agent', acceptedAt: new Date() },
        ],
      },
    },
  });

  const agencyB = await prisma.agency.upsert({
    where: { slug: 'nour-travel' },
    update: {},
    create: {
      slug: 'nour-travel',
      name: 'Nour Travel',
      status: 'verified',
      verifiedAt: new Date(),
      verifiedByUserId: admin.id,
      registreCommerce: '31/00-0000002B00',
      nif: '000031000000002',
      city: 'Oran',
      wilayaCode: '31',
      // On `pro` so you can see the paid-tier limits in the UI without
      // pretending to take a payment.
      plan: 'pro',
      memberships: { create: [{ userId: ownerB.id, role: 'owner', acceptedAt: new Date() }] },
    },
  });

  // Deliberately left unverified: the whole point of the badge is that some
  // agencies do not have it, and the search filter needs something to exclude.
  await prisma.agency.upsert({
    where: { slug: 'agence-en-attente' },
    update: {},
    create: {
      slug: 'agence-en-attente',
      name: 'Agence En Attente',
      status: 'pending_review',
      registreCommerce: '09/00-0000003B00',
      nif: '000009000000003',
      city: 'Blida',
      wilayaCode: '09',
      memberships: { create: [{ userId: traveler.id, role: 'owner', acceptedAt: new Date() }] },
    },
  });

  // --- offers ------------------------------------------------------------
  const offers = [
    {
      agencyId: agencyA.id,
      kind: 'omra' as const,
      title: 'Omra Ramadan 2027 — 15 jours depuis Alger',
      slug: 'omra-ramadan-2027-15-jours-alger',
      summary: 'Hôtel 4★ à 400 m du Haram, vol direct Air Algérie, visa inclus.',
      description:
        'Programme complet de 15 jours : 9 nuits à La Mecque et 5 nuits à Médine. ' +
        'Encadrement par un guide francophone et arabophone. Transferts inclus. ' +
        'Données de démonstration.',
      priceFromCentimes: 32_000_000,
      priceToCentimes: 41_000_000,
      departureDate: new Date('2027-02-10T00:00:00Z'),
      returnDate: new Date('2027-02-25T00:00:00Z'),
      durationDays: 15,
      departureWilayaCode: '16',
      destinationCountry: 'SA',
      destinationCity: 'Makkah',
      seatsTotal: 40,
      seatsLeft: 12,
      attributes: {
        makkahHotelName: 'Hôtel Démo Makkah',
        makkahHotelStars: 4,
        makkahDistanceToHaramMeters: 400,
        nightsInMakkah: 9,
        madinahHotelStars: 4,
        madinahDistanceToHaramMeters: 250,
        nightsInMadinah: 5,
        roomOccupancy: 'quad',
        mealPlan: 'half_board',
        transportMode: 'flight_direct',
        visaIncluded: true,
        guideIncluded: true,
        ziyaratIncluded: true,
        groupLanguage: 'both',
      },
    },
    {
      agencyId: agencyA.id,
      kind: 'package' as const,
      title: 'Séjour Istanbul 7 nuits — départ Alger',
      slug: 'sejour-istanbul-7-nuits-alger',
      summary: 'Hôtel 4★ à Sultanahmet, petit-déjeuner inclus, excursions en option.',
      priceFromCentimes: 12_500_000,
      departureDate: new Date('2027-04-05T00:00:00Z'),
      returnDate: new Date('2027-04-12T00:00:00Z'),
      durationDays: 8,
      departureWilayaCode: '16',
      destinationCountry: 'TR',
      destinationCity: 'Istanbul',
      seatsTotal: 25,
      seatsLeft: 25,
      attributes: {
        hotelStars: 4,
        mealPlan: 'breakfast',
        transportMode: 'flight_direct',
        visaAssistance: true,
      },
    },
    {
      agencyId: agencyB.id,
      kind: 'omra' as const,
      title: 'Omra Chaabane 2027 — départ Oran',
      slug: 'omra-chaabane-2027-oran',
      summary: 'Hôtel 3★, 12 jours, groupe encadré au départ d’Oran.',
      priceFromCentimes: 27_500_000,
      departureDate: new Date('2027-01-15T00:00:00Z'),
      returnDate: new Date('2027-01-27T00:00:00Z'),
      durationDays: 12,
      departureWilayaCode: '31',
      destinationCountry: 'SA',
      destinationCity: 'Makkah',
      seatsTotal: 30,
      seatsLeft: 4,
      attributes: {
        makkahHotelStars: 3,
        makkahDistanceToHaramMeters: 1200,
        nightsInMakkah: 7,
        madinahHotelStars: 3,
        nightsInMadinah: 5,
        roomOccupancy: 'quint',
        mealPlan: 'full_board',
        transportMode: 'flight_connecting',
        visaIncluded: true,
      },
    },
    {
      agencyId: agencyB.id,
      kind: 'visa' as const,
      title: 'Assistance visa Schengen — dossier complet',
      slug: 'assistance-visa-schengen-dossier-complet',
      summary: 'Préparation du dossier, prise de rendez-vous, relecture des pièces.',
      priceFromCentimes: 1_800_000,
      destinationCountry: 'FR',
      attributes: {
        visaType: 'schengen',
        targetCountry: 'FR',
        processingDays: 21,
        consulateCity: 'Alger',
        appointmentIncluded: true,
        documentReviewIncluded: true,
      },
    },
  ];

  for (const offer of offers) {
    const fingerprint = createHash('sha256')
      .update(
        offerFingerprintSource({
          agencyId: offer.agencyId,
          kind: offer.kind,
          title: offer.title,
          departureDate: offer.departureDate?.toISOString().slice(0, 10) ?? null,
          destinationCountry: offer.destinationCountry ?? null,
          destinationCity: offer.destinationCity ?? null,
          departureWilayaCode: offer.departureWilayaCode ?? null,
        }),
      )
      .digest('hex');

    await prisma.offer.upsert({
      where: { slug: offer.slug },
      update: {},
      create: {
        ...offer,
        status: 'published',
        publishedAt: new Date(),
        qualityScore: 75,
        fingerprint,
        media: [
          {
            url: 'https://placehold.co/1200x800/png',
            kind: 'image',
            order: 0,
            alt: 'Image de démonstration',
          },
        ],
      },
    });
  }

  // --- leads: a pipeline with something in most stages --------------------
  const omra = await prisma.offer.findUniqueOrThrow({
    where: { slug: 'omra-ramadan-2027-15-jours-alger' },
  });

  const leads = [
    { name: 'Mohamed A.', phone: '0551000010', stage: 'new' as const, quality: 'unrated' as const },
    { name: 'Fatima Z.', phone: '0551000011', stage: 'contacted' as const, quality: 'warm' as const },
    { name: 'Ahmed K.', phone: '0551000012', stage: 'quoted' as const, quality: 'serious' as const },
    { name: 'Leila M.', phone: '0551000013', stage: 'booked' as const, quality: 'vip' as const },
    { name: 'Inconnu', phone: '0551000014', stage: 'lost' as const, quality: 'troll' as const },
  ];

  for (const lead of leads) {
    const phone = normalizeAlgerianPhone(lead.phone);
    if (!phone) continue;

    const exists = await prisma.lead.findFirst({
      where: { agencyId: agencyA.id, contactPhone: phone },
      select: { id: true },
    });
    if (exists) continue;

    await prisma.lead.create({
      data: {
        agencyId: agencyA.id,
        offerId: omra.id,
        contactName: lead.name,
        contactPhone: phone,
        message: 'Bonjour, je souhaite plus d’informations sur ce programme. (démonstration)',
        peopleCount: 2,
        stage: lead.stage,
        quality: lead.quality,
        source: 'marketplace_inquiry',
        assignedToUserId: agentA.id,
        consentGivenAt: new Date(),
        consentTextVersion: 'inquiry-consent-v1',
        firstRespondedAt: lead.stage === 'new' ? null : new Date(),
        activities: {
          create: {
            agencyId: agencyA.id,
            type: 'lead_created',
            payload: { source: 'seed' },
          },
        },
      },
    });
  }

  // --- the trip programme: what the map on the offer page renders ----------
  // A real Omra shape — the 4am rendez-vous, the flight, the rituals, the
  // Médine leg — so the programme map has something honest to draw and the
  // day colours have enough days to cycle through.
  const programme = [
    { dayOffset: 0, title: 'Réunion d’information', kind: 'meeting' as const, timeOfDay: '18:00',
      locationName: 'Agence, Alger-Centre',
      meetingPoint: '12 rue Didouche Mourad, 2e étage',
      description: 'Remise des documents, rappel du bagage autorisé et des consignes d’ihram.' },
    { dayOffset: 1, title: 'Départ vers l’aéroport', kind: 'transport' as const, timeOfDay: '04:30',
      locationName: 'Parking de l’agence',
      meetingPoint: 'Parking de l’agence, devant l’entrée principale. Le bus part à 04h45 précises.' },
    { dayOffset: 1, title: 'Vol Alger → Djeddah', kind: 'flight' as const, timeOfDay: '07:15',
      locationName: 'Aéroport Houari Boumediene',
      meetingPoint: 'Terminal 1, porte 3, à côté du café' },
    { dayOffset: 1, title: 'Installation à Makkah', kind: 'hotel' as const, timeOfDay: '16:00',
      locationName: 'Hôtel Démo Makkah — 400 m du Haram' },
    { dayOffset: 2, title: 'Omra : tawaf et sa’i', kind: 'ritual' as const,
      description: 'Accompagnés par le guide, après Fajr. Prévoir de l’eau et des chaussures faciles à retirer.' },
    { dayOffset: 4, title: 'Ziyarat de Makkah', kind: 'ziyara' as const, timeOfDay: '09:00',
      locationName: 'Mont Arafat, Mina, grotte de Hira' },
    { dayOffset: 8, title: 'Transfert vers Médine', kind: 'transport' as const, timeOfDay: '08:00',
      meetingPoint: 'Hall de l’hôtel, bagages descendus à 07h30' },
    { dayOffset: 9, title: 'Ziyarat de Médine', kind: 'ziyara' as const, timeOfDay: '09:30',
      locationName: 'Mosquée du Prophète, Quba, Uhud' },
    { dayOffset: 13, title: 'Vol Djeddah → Alger', kind: 'flight' as const, timeOfDay: '09:00',
      locationName: 'Aéroport de Djeddah',
      meetingPoint: 'Départ de l’hôtel à 04h00. Contrôle des passeports en groupe.' },
  ];

  const existingMilestones = await prisma.offerMilestone.count({ where: { offerId: omra.id } });
  if (existingMilestones === 0) {
    await prisma.offerMilestone.createMany({
      data: programme.map((step, index) => ({
        agencyId: agencyA.id,
        offerId: omra.id,
        sortOrder: index,
        // The stops where a guide actually counts heads. Everything else stays
        // `none` — see Trip Programme.md §6.
        checkpointType:
          step.kind === 'flight' || step.kind === 'transport'
            ? ('mandatory' as const)
            : step.kind === 'ziyara'
              ? ('optional' as const)
              : ('none' as const),
        // The first two are ticked off so the seeded trip has a believable
        // "you are here" position instead of sitting at step one forever.
        completedAt: index < 2 ? new Date() : null,
        ...step,
      })),
    });
  }

  // A family on that departure, so /mon-voyage has something to open.
  const demoPhone = normalizeAlgerianPhone('0551000020');
  if (demoPhone) {
    const existingReservation = await prisma.reservation.findFirst({
      where: { agencyId: agencyA.id, contactPhone: demoPhone },
      select: { id: true },
    });
    if (!existingReservation) {
      await prisma.reservation.create({
        data: {
          agencyId: agencyA.id,
          offerId: omra.id,
          contactName: 'Famille Amrani',
          contactPhone: demoPhone,
          peopleCount: 4,
          // Fixed rather than random so the demo link survives a re-seed and
          // can be pasted into the README. A real code is 128 random bits.
          publicCode: 'demo-voyage-amrani-0001',
        },
      });
    }
  }

  console.log(`
Seed complete.

  Traveler trip page  /mon-voyage/demo-voyage-amrani-0001


  Platform admin   admin@rihlati.test
  Agency owner     baraka@rihlati.test    (Voyages El Baraka, free plan)
  Agency owner     nour@rihlati.test      (Nour Travel, pro plan)
  Agency agent     agent@rihlati.test     (Voyages El Baraka)
  Traveler         voyageur@rihlati.test

  Password for all of them: ${DEV_PASSWORD}

All data is fictional. Do not seed real agencies or real phone numbers.
`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
