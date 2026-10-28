"""The delivery roadmap, as data.

`obsidian/Roadmap.md` is the argument: why these phases, what gates each one,
what would make us stop. This module is the same plan in the shape a template
can draw — one stop per milestone, each with an emoji, a one-line note and a
status.

Two rules, both learned the hard way elsewhere in this codebase:

* **One list, one order.** The map, the counters and the page's phase bands all
  come from `PHASES` below. A second list of milestones in the template would
  drift on the first edit, and a roadmap that lies is worse than no roadmap.
* **No dates.** Sequence and gates only, exactly as the note says. A date
  invented in a data file is still a promise the code cannot keep.

The geometry is computed, not hand-placed: rows are a fixed height and the road
is a cubic curve through the pin centres, alternating sides. Add a stop and the
road grows; nothing needs re-coordinating.
"""

from itertools import pairwise

# Pixels per stop. The template hard-codes the same number as `h-[116px]`;
# changing one without the other bends the road off its pins, so they are
# deliberately adjacent in the reader's mind.
ROW_HEIGHT = 116

# The road is drawn in a 1000-unit-wide viewBox that is stretched to the column
# width. 80 units is ~8% of the width — enough to read as a winding road,
# little enough that the cards on either side never touch it.
ROAD_WIDTH = 1000
AMPLITUDE = 80

STATUSES = {
    "done": ("Built", "#10b981"),
    "next": ("Next", "#2563eb"),
    "blocked": ("Blocked on a decision", "#d97706"),
    "later": ("Later", "#94a3b8"),
}

PHASES = [
    {
        "emoji": "🟢",
        "label": "0 · Preview",
        "gate": "Built, tested and reachable from a browser.",
        "colour": "#10b981",
        "tint": "#ecfdf5",
        "border": "#a7f3d0",
        "stops": [
            ("🏪", "Marketplace, console, auth", "Search, offer pages, CRM, clients, API", "done"),
            (
                "🚌",
                "Manifest, tracked links, analytics",
                "Trips, tracked links, daily counters",
                "done",
            ),
            ("🤖", "Chat v1", "Per-offer assistant, agency-editable", "done"),
        ],
    },
    {
        "emoji": "🔵",
        "label": "1 · Pilot-ready",
        "gate": "Gate: 5–15 hand-picked agencies, no payments.",
        "colour": "#2563eb",
        "tint": "#eff6ff",
        "border": "#bfdbfe",
        "stops": [
            ("🧪", "M1 · End-to-end tests", "Five pages, real browser", "next"),
            ("🌍", "M2 · Interface translation", "Arabic + French, RTL, one switch", "next"),
            ("🧱", "G1 · Attributes schema", "Both entry points reject unknown keys", "next"),
            ("📸", "M5 · Image uploads", "Validated, EXIF stripped, off-process", "next"),
            ("🚀", "M7 · Deploy + restore", "Production path, rehearsed backup", "next"),
            ("🤝", "Onboarding runbook", "Documents → verification → first inquiry", "later"),
            ("⚖️", "Legal basics", "Terms, privacy, Law 18-07 consent", "blocked"),
            ("📊", "Pilot measurement", "Leads, response time, chat quality", "later"),
            ("🎧", "Support channel", "One named channel, one promise", "later"),
        ],
    },
    {
        "emoji": "🟠",
        "label": "2 · Public launch",
        "gate": "Gate: open traffic + first paying agency.",
        "colour": "#d97706",
        "tint": "#fffbeb",
        "border": "#fde68a",
        "stops": [
            ("🔐", "M3 · Phone/email login", "One identifier, identical error text", "next"),
            ("🚩", "M4 · Report queue", "Staff decision, audit row, counters drop", "next"),
            ("📋", "M6 · CRM redesign", "“What do I do right now”", "next"),
            ("⭐", "Reviews UI", "A real lead, a reply, both sides render", "next"),
            ("🪪", "G4 · Self-signup", "A second agency, created in-product", "blocked"),
            ("🔎", "G5 · Single-offer read", "GET one offer + isolation test", "next"),
            ("💳", "Billing model", "Credits, subscription or per-lead", "blocked"),
            ("🪙", "Credits + plan gate", "Manual top-up, has_feature()", "blocked"),
            ("⏰", "Cron", "purge_chat, rating reconcile, expiries", "next"),
            ("🧠", "Shared cache (G6)", "Login limit correct with N workers", "next"),
            ("📈", "Monitoring", "Errors and downtime reach a human", "later"),
        ],
    },
    {
        "emoji": "🟣",
        "label": "3 · Growth",
        "gate": "After paying agencies — pointers only.",
        "colour": "#7c3aed",
        "tint": "#f5f3ff",
        "border": "#ddd6fe",
        "stops": [
            ("📣", "Promoted listings", "Labelled, capped, never overrides trust", "later"),
            ("💬", "WhatsApp Business API", "Same bot, a second transport", "later"),
            ("📱", "Mobile app", "The API is already the hard part", "later"),
            ("🛠", "Chat v2", "Tools, FAQ mining, hosted-model call", "later"),
            ("🌐", "Cross-agency reputation", "Lawyer first — it is personal data", "later"),
            ("📚", "Retire one vault", "Two descriptions of one product drift", "later"),
        ],
    },
]


def _road_path(points):
    """A cubic through every pin, vertical at each one.

    Control points share the pin's x and sit a third of the way along the
    segment, so the curve leaves and enters each stop straight down — which is
    what makes it read as a road rather than a scribble.
    """
    (x, y) = points[0]
    d = f"M {x:.1f} {y:.1f}"
    for (x0, y0), (x1, y1) in pairwise(points):
        third = (y1 - y0) / 3
        d += f" C {x0:.1f} {y0 + third:.1f} {x1:.1f} {y1 - third:.1f} {x1:.1f} {y1:.1f}"
    return d


def build_phases():
    """Template-ready phases. Recomputed per request: the lists are 29 tuples,
    and mutating module state to cache them is how a page doubles its stops on
    the second visit."""
    phases = []
    for phase in PHASES:
        height = len(phase["stops"]) * ROW_HEIGHT
        pins = []
        road = []
        for index, (emoji, title, note, status) in enumerate(phase["stops"]):
            # Alternating sides, not a sine: a pin and its card belong on the
            # same side, and an odd number of stops would otherwise leave the
            # last card stranded across the road from its pin.
            x = ROAD_WIDTH / 2 + (AMPLITUDE if index % 2 == 0 else -AMPLITUDE)
            label, colour = STATUSES[status]
            pins.append(
                {
                    "emoji": emoji,
                    "title": title,
                    "note": note,
                    "x": f"{x / ROAD_WIDTH * 100:.1f}",
                    "side": "right" if index % 2 == 0 else "left",
                    "status": status,
                    "status_label": label,
                    "status_colour": colour,
                }
            )
            road.append((x, (index + 0.5) * ROW_HEIGHT))
        # The road enters and leaves the band, so a phase never looks like a
        # line that forgot where it came from.
        points = [(road[0][0], 0), *road, (road[-1][0], height)]
        phases.append(
            {
                "emoji": phase["emoji"],
                "label": phase["label"],
                "gate": phase["gate"],
                "colour": phase["colour"],
                "tint": phase["tint"],
                "border": phase["border"],
                "stops": pins,
                "height": height,
                "path": _road_path(points),
                "done": sum(1 for p in pins if p["status"] == "done"),
                "total": len(pins),
            }
        )
    return phases
