"""
API Module.

Contains only versioned route wiring (``app.api.v1``, and future
``app.api.v2``). Route handlers here delegate to feature-module services;
they never implement business logic themselves.
"""
