"""
Users Module.

Owns *who* a user is: the ``User`` ORM model and account/security state
(status, lockout, timestamps), plus the admin-facing user-management API
(create, list/get, update, reset password, activate/deactivate/unlock, role
assignment, session viewing, force-logout).

    models.py     - User ORM model, UserStatus enum
    schemas.py    - UserCreate, UserRead, UserUpdate, AssignRoleRequest, etc.
    repository.py - UserRepository (lookups by username/email/identifier)
    service.py    - UserService: admin user-management business logic
    routes.py     - the /api/v1/users/* admin API

Login/session/token concerns are owned by :mod:`app.auth`; role/permission
definitions are owned by :mod:`app.rbac`.
"""
