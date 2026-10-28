"""Migrations run against a database that already has rows in it.

The rest of the suite never catches a migration bug, because every test starts
from an empty database — and an empty table accepts any migration at all. The
one that shipped broken added `Offer.slug` as `unique=True` in a single step:
fine on a fresh install, and on the preview database it gave all five existing
offers the same default `''` and died on the second one with

    IntegrityError: UNIQUE constraint failed: new__offers_offer.slug

`makemigrations --check` does not see this either; it only asks whether a
migration is *missing*, never whether one *works*. So the check has to be a
test, and the test has to put rows in the table first.
"""

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class MigrationTestCase(TransactionTestCase):
    """Rewind to `migrate_from`, let a subclass insert rows, then roll forward.

    `TransactionTestCase` rather than `TestCase`: schema changes cannot happen
    inside the outer transaction `TestCase` wraps every test in.
    """

    migrate_from: list[tuple[str, str]] = []
    migrate_to: list[tuple[str, str]] = []
    available_apps = None

    def setUp(self):
        executor = MigrationExecutor(connection)
        executor.migrate(self.migrate_from)
        executor.loader.build_graph()
        self.seed(executor.loader.project_state(self.migrate_from).apps)

        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(self.migrate_to)
        self.apps = executor.loader.project_state(self.migrate_to).apps

    def tearDown(self):
        # Leave the database at the latest migration, or every test that runs
        # after this one inherits a half-rewound schema.
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    def seed(self, apps):
        raise NotImplementedError


class OfferSlugBackfillTests(MigrationTestCase):
    # `accounts` is pinned as well as `offers`. Naming only the offers node
    # rewinds the *state* of every app to that point in the graph while leaving
    # the accounts *tables* where they are, and the seed below then writes an
    # `Agency.is_verified` column that accounts 0002 already dropped.
    migrate_from = [
        ("accounts", "0002_auditlog_refreshtoken_remove_agency_is_verified_and_more"),
        ("offers", "0002_offer_cover_image_url"),
    ]
    migrate_to = [("offers", "0003_offerdailymetric_offermilestone_offerreport_and_more")]

    def seed(self, apps):
        Agency = apps.get_model("accounts", "Agency")
        Offer = apps.get_model("offers", "Offer")
        agency = Agency.objects.create(name="Wahran Tours", slug="wahran-tours", city="Oran")
        # Same title, same city, on purpose: two rows whose natural slug
        # collides is the case a naive backfill also gets wrong.
        for _ in range(3):
            Offer.objects.create(
                agency=agency,
                title_fr="Omra Ramadan 15 jours",
                title_ar="عمرة رمضان",
                kind="omra",
                price_centimes=25_000_000,
                departure_date="2027-03-01",
                seats_total=40,
                seats_left=40,
                status="published",
            )

    def test_existing_offers_each_get_a_distinct_slug(self):
        Offer = self.apps.get_model("offers", "Offer")
        slugs = list(Offer.objects.values_list("slug", flat=True))

        self.assertEqual(len(slugs), 3)
        self.assertEqual(len(set(slugs)), 3, f"slugs collided: {slugs}")
        self.assertNotIn("", slugs)

    def test_the_slug_is_readable_and_not_just_unique(self):
        """A uuid in every slug would pass the test above and defeat the point:
        the slug exists so the URL says what the page is."""
        Offer = self.apps.get_model("offers", "Offer")
        first = Offer.objects.order_by("created_at").first()

        self.assertEqual(first.slug, "omra-ramadan-15-jours-oran")
