"""
Middleware Module.

Contains ASGI/HTTP middleware registered on the FastAPI application in
``app.main.create_application``. Each middleware has a single, narrow
responsibility:

- ``request_id``       : generates/propagates a correlation ID per request
- ``logging_middleware``: logs request/response lifecycle with timing
- ``timing``            : adds a ``X-Process-Time`` response header

Middleware order matters (they wrap each other like an onion), so the
registration order is documented explicitly in ``app.main``.
"""
