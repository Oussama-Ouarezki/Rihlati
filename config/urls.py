from django.contrib import admin
from django.urls import include, path

from config.api import api

urlpatterns = [
    path("admin/", admin.site.urls),
    # One JSON API, one OpenAPI document at /api/docs. A mobile app or a
    # Next.js frontend consumes this; the pages below consume the same models.
    path("api/", api.urls),
    # Server-rendered pages over the *same* models: the "PWA-first" shape.
    path("", include("apps.pages.urls")),
]
