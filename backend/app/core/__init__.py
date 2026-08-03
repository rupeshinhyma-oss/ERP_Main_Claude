"""
Core Module.

Houses application-wide, framework-level concerns that every other module
depends on but that do not themselves depend on any feature module:

- ``config``     : environment-driven settings (Pydantic Settings)
- ``logging``    : structured logging configuration
- ``exceptions`` : the application exception hierarchy
- ``responses``  : the standard API response envelope
- ``constants``  : shared enums/constants used across modules

Nothing in ``app.core`` may import from a feature module (``app.users``,
``app.auth``, etc.). This keeps ``core`` reusable and prevents circular
imports.
"""
