from django.contrib.auth import views as auth_views
from django.urls import path

from apps.pages import views

urlpatterns = [
    # --- traveler ---------------------------------------------------------
    path("", views.search, name="search"),
    # The chat is its own page, not a modal over the filters: one input, a few
    # suggestions, and results that stay out of the middle of the page.
    path("discover/", views.discover, name="discover"),
    # Public on purpose: the preview's most honest page is the one that says
    # what is not built yet.
    path("roadmap/", views.roadmap, name="roadmap"),
    path("offers/<uuid:offer_id>/", views.offer_detail, name="offer-detail"),
    # The full-page assistant for one offer. Same visibility rule as the offer;
    # the widget on the offer page links here.
    path("offers/<uuid:offer_id>/assistant/", views.offer_assistant, name="offer-assistant"),
    # A capability URL. The 32-hex code IS the credential — see views.my_trip.
    path("mon-voyage/<str:code>/", views.my_trip, name="my-trip"),
    # Deliberately short and at the root: this gets pasted under a Facebook
    # post, and every extra segment is a reason not to tap it.
    path("l/<str:code>/", views.tracked_link_redirect, name="tracked-link"),
    # --- agency -----------------------------------------------------------
    path("dashboard/", views.dashboard, name="dashboard"),
    path("a/<uuid:agency_id>/offers/", views.agency_offers, name="agency-offers"),
    path("a/<uuid:agency_id>/offers/new/", views.agency_offer_edit, name="agency-offer-new"),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/",
        views.agency_offer_edit,
        name="agency-offer-edit",
    ),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/assistant/",
        views.agency_offer_assistant,
        name="agency-offer-assistant",
    ),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/programme/",
        views.agency_programme,
        name="agency-programme",
    ),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/programme/copy/",
        views.agency_programme_copy,
        name="agency-programme-copy",
    ),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/programme/duplicate-day/",
        views.agency_day_duplicate,
        name="agency-day-duplicate",
    ),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/programme/<uuid:milestone_id>/delete/",
        views.agency_milestone_delete,
        name="agency-milestone-delete",
    ),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/programme/<uuid:milestone_id>/toggle/",
        views.agency_milestone_toggle,
        name="agency-milestone-toggle",
    ),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/manifest/",
        views.agency_manifest,
        name="agency-manifest",
    ),
    path(
        "a/<uuid:agency_id>/offers/<uuid:offer_id>/checkpoint/<uuid:milestone_id>/",
        views.agency_checkpoint,
        name="agency-checkpoint",
    ),
    path("a/<uuid:agency_id>/links/", views.agency_links, name="agency-links"),
    path("a/<uuid:agency_id>/leads/", views.agency_leads, name="agency-leads"),
    path(
        "a/<uuid:agency_id>/leads/<uuid:lead_id>/",
        views.agency_lead_detail,
        name="agency-lead-detail",
    ),
    path(
        "a/<uuid:agency_id>/leads/<uuid:lead_id>/status/",
        views.agency_lead_status,
        name="agency-lead-status",
    ),
    path("a/<uuid:agency_id>/clients/", views.agency_clients, name="agency-clients"),
    path(
        "a/<uuid:agency_id>/clients/<uuid:client_id>/",
        views.agency_client_detail,
        name="agency-client-detail",
    ),
    path("a/<uuid:agency_id>/settings/", views.agency_settings, name="agency-settings"),
    path("a/<uuid:agency_id>/assistant/", views.agency_assistant, name="agency-assistant"),
    path(
        "a/<uuid:agency_id>/assistant/faqs/<uuid:faq_id>/",
        views.agency_faq_edit,
        name="agency-faq-edit",
    ),
    path(
        "a/<uuid:agency_id>/assistant/faqs/<uuid:faq_id>/delete/",
        views.agency_faq_delete,
        name="agency-faq-delete",
    ),
    # --- staff ------------------------------------------------------------
    path("verification/", views.verification_queue, name="verification-queue"),
    # --- auth -------------------------------------------------------------
    path(
        "login/",
        auth_views.LoginView.as_view(template_name="pages/login.html"),
        name="login",
    ),
    path("logout/", auth_views.LogoutView.as_view(next_page="search"), name="logout"),
]
