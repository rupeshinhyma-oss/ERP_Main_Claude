"""
ERP Backend Application Package.

This is the root package of the ERP backend. The application follows a
Modular Monolith architecture: every business capability (auth, users,
departments, organizations, audit, notifications, reports, etc.) lives in
its own isolated module under ``app/``, each exposing a clean boundary of
``models``, ``schemas``, ``repository``, ``service`` and ``routes``.

Cross-cutting concerns (configuration, logging, database session
management, middleware, standard response envelopes, base classes) live in
``app.core``, ``app.database``, ``app.middleware`` and ``app.common`` so
that every feature module can depend on them without depending on each
other, keeping coupling low and cohesion high.
"""
