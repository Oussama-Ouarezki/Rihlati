from django import forms

from apps.accounts.models import Agency
from apps.chat.models import AgencyAssistant
from apps.common.validators import (
    PHONE_HELP,
    validate_dz_phone,
    validate_time_of_day,
    validate_wilaya_code,
)
from apps.common.wilayas import WILAYA_CHOICES
from apps.leads.models import CONSENT_TEXT, Client, Lead
from apps.offers.models import MILESTONE_TITLE_MAX, Offer, OfferMilestone


class StyledFormMixin:
    """Django renders the widgets, so the styling hook goes on `attrs` once
    here rather than being repeated in every template."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            if isinstance(field.widget, forms.CheckboxInput):
                continue
            css = field.widget.attrs.get("class", "")
            field.widget.attrs["class"] = f"{css} field-input".strip()


class InquiryForm(StyledFormMixin, forms.ModelForm):
    """The traveler-facing form. Note what it does *not* contain: agency,
    offer, status, quality. Those are set by the view from data the server
    controls — the same list that is absent from `LeadIn` in the JSON API,
    because it is the same rule at a second door."""

    consent = forms.BooleanField(label=CONSENT_TEXT, required=True)

    class Meta:
        model = Lead
        fields = ["full_name", "phone_e164", "message"]
        labels = {
            "full_name": "Your name",
            "phone_e164": "Phone",
            "message": "Your question",
        }
        help_texts = {"phone_e164": PHONE_HELP}
        widgets = {
            "full_name": forms.TextInput(attrs={"placeholder": "First and last name"}),
            "phone_e164": forms.TextInput(attrs={"placeholder": "+213…"}),
            "message": forms.Textarea(attrs={"rows": 3, "placeholder": "Is the visa included?"}),
        }

    def clean_phone_e164(self):
        return validate_dz_phone(self.cleaned_data["phone_e164"])


class OfferForm(StyledFormMixin, forms.ModelForm):
    """Agency-side. `agency` is absent on purpose — the view sets it from the
    membership it already authorized, so a crafted POST can't reassign it. So
    are `quality_score`, `is_featured` and `duplicate_status`: server-owned."""

    price_dzd = forms.IntegerField(
        label="Price (DZD)",
        min_value=1,
        help_text="Entered in dinars, stored in centimes.",
    )
    departure_wilaya_code = forms.ChoiceField(
        label="Departure wilaya",
        choices=[("", "—")] + WILAYA_CHOICES,
        required=False,
    )

    class Meta:
        model = Offer
        fields = [
            "title_fr",
            "title_ar",
            "description",
            "kind",
            "departure_date",
            "return_date",
            "departure_wilaya_code",
            "destination_city",
            "seats_total",
            "seats_left",
            "status",
            "cover_image_url",
        ]
        labels = {
            "title_fr": "Title (French)",
            "title_ar": "Title (Arabic)",
            "description": "Description",
            "kind": "Type",
            "departure_date": "Departure date",
            "return_date": "Return date",
            "destination_city": "Destination city",
            "seats_total": "Seats total",
            "seats_left": "Seats left",
            "status": "Status",
            "cover_image_url": "Photo (URL)",
        }
        widgets = {
            "departure_date": forms.DateInput(attrs={"type": "date"}),
            "return_date": forms.DateInput(attrs={"type": "date"}),
            "description": forms.Textarea(attrs={"rows": 4}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Not `if self.instance.pk:` — a UUID default is assigned the moment the
        # object is constructed, so an *unsaved* Offer already has a pk. Ask
        # whether the row is new instead.
        if self.instance and not self.instance._state.adding:
            self.fields["price_dzd"].initial = self.instance.price_centimes // 100

    def clean_departure_wilaya_code(self):
        return validate_wilaya_code(self.cleaned_data["departure_wilaya_code"])

    def clean(self):
        cleaned = super().clean()
        total, left = cleaned.get("seats_total"), cleaned.get("seats_left")
        if total is not None and left is not None and left > total:
            self.add_error("seats_left", "Cannot exceed the total.")
        departure, back = cleaned.get("departure_date"), cleaned.get("return_date")
        if departure and back and back < departure:
            self.add_error("return_date", "The return date cannot be before the departure date.")
        return cleaned

    def save(self, commit=True):
        offer = super().save(commit=False)
        # Money crosses the boundary as an integer number of dinars and is
        # converted here. No float ever touches the price.
        offer.price_centimes = self.cleaned_data["price_dzd"] * 100
        if commit:
            offer.save()
        return offer


class MilestoneForm(StyledFormMixin, forms.ModelForm):
    """One step of the programme.

    `day_offset` rather than a date, and `time_of_day` as text: see
    OfferMilestone for why neither is what it first looks like.
    """

    class Meta:
        model = OfferMilestone
        fields = [
            "title",
            "kind",
            "day_offset",
            "time_of_day",
            "location_name",
            "meeting_point",
            "map_url",
            "description",
            "checkpoint_type",
        ]
        labels = {
            "title": "Step title",
            "kind": "Type",
            "day_offset": "Day (0 = departure day)",
            "time_of_day": "Time (HH:MM)",
            "location_name": "Location",
            "meeting_point": "Exact meeting point",
            "map_url": "Map link",
            "description": "Details",
            "checkpoint_type": "Checkpoint",
        }
        help_texts = {
            "meeting_point": "The sentence someone reads at 4am: “Terminal 1, gate 3”.",
            "time_of_day": "Local time on site. Never converted.",
        }
        widgets = {
            "description": forms.Textarea(attrs={"rows": 2}),
            "title": forms.TextInput(attrs={"maxlength": MILESTONE_TITLE_MAX}),
            "time_of_day": forms.TextInput(attrs={"placeholder": "04:30"}),
        }

    def clean_time_of_day(self):
        return validate_time_of_day(self.cleaned_data["time_of_day"])


class VerificationForm(StyledFormMixin, forms.ModelForm):
    """What an agency submits to get the badge.

    The badge is the only reason a traveler hands their phone number to a
    stranger, so the numbers below are the product, not paperwork.
    """

    class Meta:
        model = Agency
        fields = ["registre_commerce", "nif", "tourism_licence"]
        labels = {
            "registre_commerce": "Commercial registry number",
            "nif": "NIF",
            "tourism_licence": "Travel agency licence",
        }
        help_texts = {
            # VERIFY: the exact set of documents an Algerian travel agency must
            # hold is a legal question. Confirm with a lawyer before launch.
            "tourism_licence": "If you hold one. Check the exact format.",
        }

    def clean_registre_commerce(self):
        value = self.cleaned_data["registre_commerce"].strip()
        if len(value) < 3:
            raise forms.ValidationError("Number is too short.")
        return value


class AgencyProfileForm(StyledFormMixin, forms.ModelForm):
    """Everything an agency may change about itself.

    `status`, `plan` and `credit_balance_centimes` are absent, and that absence
    is the security: a ModelForm writes exactly the fields it lists.
    """

    wilaya_code = forms.ChoiceField(
        label="Wilaya", choices=[("", "—")] + WILAYA_CHOICES, required=False
    )

    class Meta:
        model = Agency
        fields = [
            "name",
            "description",
            "city",
            "wilaya_code",
            "phone",
            "whatsapp",
            "email",
            "website_url",
            "logo_url",
        ]
        labels = {
            "name": "Agency name",
            "description": "About",
            "city": "City",
            "phone": "Phone",
            "whatsapp": "WhatsApp",
            "email": "Email",
            "website_url": "Website",
            "logo_url": "Logo (URL)",
        }
        widgets = {"description": forms.Textarea(attrs={"rows": 4})}

    def clean_phone(self):
        value = self.cleaned_data["phone"]
        return validate_dz_phone(value) if value else value

    def clean_whatsapp(self):
        value = self.cleaned_data["whatsapp"]
        return validate_dz_phone(value) if value else value


class AssistantForm(StyledFormMixin, forms.ModelForm):
    """The agency's own reservation policy, for its assistant.

    `agency` is absent on purpose, like every other agency-side form: the view
    sets it from the membership it already authorized. `instructions` is capped
    by the model field, and stripping it here means a textarea full of spaces
    does not become a prompt block full of blank lines.
    """

    class Meta:
        model = AgencyAssistant
        fields = ["is_enabled", "instructions"]
        labels = {"is_enabled": "Enable the assistant", "instructions": "Agency instructions"}
        help_texts = {
            "instructions": (
                "Added to the assistant after Rihlati's own rules. Describe the "
                "deposit, documents and cancellation terms — not prices, which "
                "always come from the offer. 2,000 characters maximum."
            )
        }
        widgets = {
            "is_enabled": forms.CheckboxInput(
                attrs={"class": "mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600"}
            ),
            "instructions": forms.Textarea(
                attrs={
                    "rows": 9,
                    "placeholder": (
                        "Booking: 30% deposit on confirmation, balance due 7 days "
                        "before departure. Passport valid for 6 months after "
                        "return. Free cancellation up to 14 days before departure; "
                        "after that the deposit is retained."
                    ),
                }
            ),
        }

    def clean_instructions(self):
        return self.cleaned_data["instructions"].strip()


class ClientForm(StyledFormMixin, forms.ModelForm):
    """Agency-side. `agency` is passed in, never posted: the view sets it from
    the membership it already authorized, so a crafted POST cannot create a
    client in another tenant."""

    note = forms.CharField(
        label="First note",
        required=False,
        widget=forms.Textarea(attrs={"rows": 2, "placeholder": "Prefers an evening call."}),
    )

    class Meta:
        model = Client
        fields = ["full_name", "phone_e164"]
        labels = {"full_name": "Name", "phone_e164": "Phone"}
        help_texts = {"phone_e164": PHONE_HELP}
        widgets = {
            "full_name": forms.TextInput(attrs={"placeholder": "First and last name"}),
            "phone_e164": forms.TextInput(attrs={"placeholder": "+213…"}),
        }

    def __init__(self, *args, agency, include_note=False, **kwargs):
        super().__init__(*args, **kwargs)
        self.agency = agency
        if not include_note:
            self.fields.pop("note")

    def clean_phone_e164(self):
        phone = validate_dz_phone(self.cleaned_data["phone_e164"])
        # The unique constraint would raise a 500 on save. An error next to the
        # field is the same rule with a sentence a person can act on.
        existing = Client.objects.filter(agency=self.agency, phone_e164=phone)
        if not self.instance._state.adding:
            existing = existing.exclude(pk=self.instance.pk)
        if existing.exists():
            raise forms.ValidationError("A client already has this number.")
        return phone


class ReservationForm(StyledFormMixin, forms.Form):
    """Not a ModelForm: `agency` and `offer` come from the authorized URL, and
    a ModelForm listing them would put them in the POST body."""

    full_name = forms.CharField(label="Traveller name", max_length=150)
    phone_e164 = forms.CharField(label="Phone", max_length=20, help_text=PHONE_HELP)
    party_size = forms.IntegerField(label="Number of people", min_value=1, initial=1)
    note = forms.CharField(label="Note", required=False, widget=forms.Textarea(attrs={"rows": 2}))

    def clean_phone_e164(self):
        return validate_dz_phone(self.cleaned_data["phone_e164"])


class TrackedLinkForm(StyledFormMixin, forms.Form):
    """Not a ModelForm, for the same reason as ReservationForm: `agency` and
    `code` are server-owned. A form field for `code` would let an agency choose
    a code already belonging to someone else's campaign."""

    label = forms.CharField(
        label="Campaign name",
        max_length=80,
        help_text=(
            "For you only. “Facebook post — 12 March” still makes sense in six "
            "months; “link 3” does not."
        ),
    )
    # Optional: a link can point at the catalogue rather than one departure —
    # an agency advertising its page, not a specific trip.
    offer = forms.ModelChoiceField(
        label="Offer",
        queryset=Offer.objects.none(),
        required=False,
        empty_label="All offers",
    )

    def __init__(self, *args, agency=None, **kwargs):
        super().__init__(*args, **kwargs)
        # Scoped in the form itself, not just in the template. An unscoped
        # queryset here would accept another agency's offer id from a crafted
        # POST — the field would validate it, and the tenant check would never
        # run because nothing else looks at this value.
        self.fields["offer"].queryset = Offer.objects.filter(agency=agency)
