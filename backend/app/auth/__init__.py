"""
Auth Module.

Owns *how* a user is currently (or was previously) logged in: JWT
issuance/verification, refresh-token rotation, session tracking, the token
blacklist, and password change/reset flows.

    models.py       - Session, TokenBlacklist, PasswordHistory ORM models
    schemas.py      - LoginRequest, TokenResponse, ProfileResponse, etc.
    security.py     - password hashing (Argon2id), JWT encode/decode, password-strength validation
    repository.py   - SessionRepository, TokenBlacklistRepository, PasswordHistoryRepository
    service.py      - AuthService: login/refresh/logout/change-password business logic
    dependencies.py - get_current_user, get_auth_service, get_login_context
    routes.py       - POST /api/v1/auth/{login,refresh,logout,change-password,forgot-password}, GET /profile

See :mod:`app.rbac` for role/permission management and :mod:`app.users` for
user-account management.
"""
