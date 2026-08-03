"""
API v1.

Version 1 of the public API. Every route in this package is mounted under
``settings.API_V1_PREFIX`` (``/api/v1`` by default). Introducing a v2 later
means adding an ``app.api.v2`` package and mounting it alongside v1 in
``app.main`` -- v1 routes never change shape once clients depend on them.
"""
