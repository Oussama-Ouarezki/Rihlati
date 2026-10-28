"""Delete assistant conversations past their expiry date.

A conversation holds whatever a traveler typed, which can include a phone
number. Keeping it forever has no product value — the unanswered-question queue
needs days — and a table nobody deletes from is a data-retention problem waiting
for a lawyer to find it.

Run daily:

    python manage.py purge_chat

There is nowhere to run cron yet (Milestone Plan M7), so today this is a command
an operator remembers. The expiry is still written on every row from day one:
adding it later would mean deciding retroactively which old conversations to
keep, and the honest answer would be "all of them".
"""

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.chat.models import ChatConversation


class Command(BaseCommand):
    help = "Delete assistant conversations whose expiry date has passed."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Count what would be deleted, change nothing.",
        )

    def handle(self, *args, **options):
        expired = ChatConversation.objects.filter(expires_at__lt=timezone.now())
        count = expired.count()
        if options["dry_run"]:
            self.stdout.write(f"{count} conversation(s) expired, nothing deleted.")
            return
        expired.delete()
        if options["verbosity"]:
            self.stdout.write(self.style.SUCCESS(f"{count} conversation(s) deleted."))
