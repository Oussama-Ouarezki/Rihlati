from django import template

register = template.Library()

# One emoji per `MilestoneKind`, keyed by the stored value. This lives here
# rather than on the model because it is presentation, and because the pin on
# the road and the pill in the card must agree — a test asserts the keys cover
# `MilestoneKind` exactly, so a tenth kind cannot ship without an icon.
KIND_EMOJI = {
    "meeting": "🤝",
    "transport": "🚌",
    "flight": "✈️",
    "hotel": "🏨",
    "ritual": "🕋",
    "ziyara": "🕌",
    "meal": "🍽️",
    "free_time": "🕒",
    "other": "📍",
}


@register.filter
def kind_emoji(kind):
    """The pin icon for a milestone kind. Falls back to a pin marker rather
    than an empty circle: an unknown kind should still be findable on the road."""
    return KIND_EMOJI.get(kind, "📍")
