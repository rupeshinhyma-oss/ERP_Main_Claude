"""
Database Module.

Owns everything related to the SQLAlchemy engine, session lifecycle, and
the declarative base that every ORM model in the codebase inherits from.

- ``engine``  : creates and owns the process-wide async SQLAlchemy engine
- ``session`` : provides the FastAPI dependency that yields a per-request
                ``AsyncSession`` with correct commit/rollback/close semantics
- ``base``    : the shared ``DeclarativeBase`` plus common mixins
                (timestamps, UUID primary keys) used by every model
"""
