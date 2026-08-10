"""
Declarative Base and Shared Model Mixins.

Every ORM model in every feature module inherits from :class:`Base`. Common
columns that nearly every table needs (a UUID primary key, creation and
update timestamps) are factored into mixins here rather than repeated in
every model, following the DRY principle.

All timestamps are stored in UTC. PostgreSQL's ``TIMESTAMP WITH TIME ZONE``
(``DateTime(timezone=True)`` in SQLAlchemy) is used everywhere so that the
database itself is timezone-aware; the application never stores naive
datetimes.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator, CHAR


class GUID(TypeDecorator):
    """
    Platform-independent UUID column type.

    Stores as PostgreSQL's native ``UUID`` type when available, and falls
    back to a ``CHAR(36)`` on other backends (e.g. SQLite in unit tests),
    so the same model definitions can run against a lightweight test
    database without requiring PostgreSQL-specific types everywhere.
    """

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        """Use the native UUID type on PostgreSQL, CHAR(36) elsewhere."""
        if dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import UUID as PG_UUID

            return dialect.type_descriptor(PG_UUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value, dialect):
        """Normalize the Python value before sending it to the DB driver."""
        if value is None:
            return value
        if dialect.name == "postgresql":
            return str(value)
        if not isinstance(value, uuid.UUID):
            return str(uuid.UUID(str(value)))
        return str(value)

    def process_result_value(self, value, dialect):
        """Coerce the raw DB value back into a ``uuid.UUID`` in Python."""
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return value
        return uuid.UUID(str(value))


def _utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    """
    Shared declarative base class for all ORM models.

    Using a single ``Base`` across every feature module ensures Alembic's
    autogenerate can see every table when building the combined metadata,
    and lets modules reference each other's tables via foreign keys when
    genuinely needed (e.g. ``departments.organization_id -> organizations.id``).
    """


class UUIDPrimaryKeyMixin:
    """
    Mixin providing a UUID v4 primary key column named ``id``.

    UUIDs (rather than auto-incrementing integers) are used for primary
    keys so that IDs are globally unique and non-guessable, and so that
    records can be created client-side or by future distributed services
    without needing a round-trip to the database first.
    """

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )


class VersionMixin:
    """
    Mixin providing an integer ``version`` column for Optimistic Concurrency Control (OCC).

    Starts at 1 on insert and increments on every successful mutation.
    """

    version: Mapped[int] = mapped_column(
        Integer,
        default=1,
        server_default="1",
        nullable=False,
    )


class TimestampMixin:
    """
    Mixin providing ``created_at`` / ``updated_at`` UTC timestamp columns.

    ``created_at`` is set once on insert. ``updated_at`` is set on insert
    and refreshed on every update via ``onupdate``, so callers never need
    to manage these fields manually in service code.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=_utcnow,
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=_utcnow,
        onupdate=_utcnow,
        nullable=False,
    )


class SoftDeleteMixin:
    """
    Mixin providing soft-delete support via a nullable ``deleted_at`` column.

    Repositories built on :class:`app.common.base_repository.BaseRepository`
    filter out rows where ``deleted_at IS NOT NULL`` by default, so business
    modules get audit-friendly, recoverable deletes for free instead of
    hard-deleting rows.
    """

    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        default=None,
        nullable=True,
    )

    @property
    def is_deleted(self) -> bool:
        """Return True if this record has been soft-deleted."""
        return self.deleted_at is not None

