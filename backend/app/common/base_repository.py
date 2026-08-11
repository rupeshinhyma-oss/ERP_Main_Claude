"""
Base Repository.

Implements the Repository pattern: the only layer in the application
allowed to construct SQLAlchemy queries and talk to the ``AsyncSession``
directly. Services depend on repositories through this generic interface,
never on SQLAlchemy constructs directly, which keeps persistence concerns
out of business logic and makes services trivially unit-testable with a
fake/in-memory repository if desired.

:class:`BaseRepository` is generic over the ORM model type, so a concrete
repository for, say, ``Department`` is typically just:

    class DepartmentRepository(BaseRepository[Department]):
        def __init__(self, session: AsyncSession) -> None:
            super().__init__(session, Department)

...and gets ``get_by_id``, ``list``, ``create``, ``update``, ``delete``, and
``count`` for free, while remaining free to add department-specific query
methods (e.g. ``get_by_code``).

To opt into the generic search/sort/dynamic-filter framework (see
:mod:`app.common.list_query`), a concrete repository declares which columns
are eligible for each, as class attributes:

    class DepartmentRepository(BaseRepository[Department]):
        searchable_fields = ("name", "code")      # ?search=...  -> ILIKE across these
        sortable_fields = ("name", "created_at")  # ?sort_by=...  -> must be one of these
        filterable_fields = ("status", "organization_id")  # ?status=...  -> exact match

...and then calls :meth:`paginated_list` with a
:class:`~app.common.list_query.ListQueryParams` instead of hand-rolling
search/sort/filter logic per module.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any, Generic, TypeVar

from sqlalchemy import Select, String, Text, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestException, ConflictException
from app.database.base import Base, SoftDeleteMixin

if TYPE_CHECKING:
    from app.common.list_query import ListQueryParams

ModelT = TypeVar("ModelT", bound=Base)


class BaseRepository(Generic[ModelT]):
    """
    Generic async CRUD repository over a single SQLAlchemy ORM model.

    Attributes:
        session: The per-request ``AsyncSession`` (injected, never created
            here -- session lifecycle is owned by
            :func:`app.database.session.get_db_session`).
        model: The concrete ORM model class this repository operates on.
    """

    # Opt-in declarations for the generic search/sort/dynamic-filter
    # framework (see :mod:`app.common.list_query`). Empty by default --
    # a concrete repository lists exactly the columns it wants exposed
    # through ``?search=``/``?sort_by=``/``?<field>=`` query params.
    searchable_fields: tuple[str, ...] = ()
    sortable_fields: tuple[str, ...] = ()
    filterable_fields: tuple[str, ...] = ()

    def __init__(self, session: AsyncSession, model: type[ModelT]) -> None:
        """Bind this repository instance to a session and a model class."""
        self.session = session
        self.model = model

    def _base_select(self) -> Select:
        """
        Build the base SELECT for this model.

        Automatically excludes soft-deleted rows when the model supports
        soft delete, so callers never need to remember to add that filter
        themselves.
        """
        stmt = select(self.model)
        if issubclass(self.model, SoftDeleteMixin):
            stmt = stmt.where(self.model.deleted_at.is_(None))  # type: ignore[attr-defined]
        return stmt

    async def get_by_id(self, id_: uuid.UUID) -> ModelT | None:
        """Fetch a single row by primary key, or None if not found/soft-deleted."""
        stmt = self._base_select().where(self.model.id == id_)  # type: ignore[attr-defined]
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_ids(self, ids: list[uuid.UUID]) -> dict[uuid.UUID, ModelT]:
        """
        Fetch many rows by primary key in ONE query, keyed by id.

        Exists specifically so callers that need N records (e.g. Shipment
        Planning resolving every row's linked Product Master record for a
        LINKED_LOOKUP column) can do it in a single round trip instead of
        N sequential ``get_by_id`` calls -- the latter is the exact
        pattern that turned "load the grid" into a multi-second-or-worse
        hang once a sheet had 50+ rows each individually linked to a
        record. Missing/soft-deleted ids are simply absent from the
        returned dict rather than raising, mirroring ``get_by_id``'s
        "None if not found" contract.
        """
        if not ids:
            return {}
        stmt = self._base_select().where(self.model.id.in_(ids))  # type: ignore[attr-defined]
        result = await self.session.execute(stmt)
        return {row.id: row for row in result.scalars().all()}

    async def list(
        self,
        *,
        offset: int = 0,
        limit: int | None = 20,
        filters: dict[str, Any] | None = None,
        order_by: Any | None = None,
    ) -> list[ModelT]:
        """
        Fetch a page of rows, optionally filtered by exact-match column values.

        Args:
            offset: Number of rows to skip.
            limit: Maximum number of rows to return. Pass ``None`` to fetch every matching row (no LIMIT clause).
            filters: Mapping of column name -> exact value to filter on.
            order_by: A SQLAlchemy ordering expression, e.g. ``Model.created_at.desc()``.
        """
        stmt = self._base_select()
        stmt = self._apply_filters(stmt, filters)
        if order_by is not None:
            stmt = stmt.order_by(order_by)
        stmt = stmt.offset(offset)
        if limit is not None:
            stmt = stmt.limit(limit)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def count(self, *, filters: dict[str, Any] | None = None) -> int:
        """Count rows matching the given filters (respecting soft-delete exclusion)."""
        stmt = select(func.count()).select_from(self.model)
        if issubclass(self.model, SoftDeleteMixin):
            stmt = stmt.where(self.model.deleted_at.is_(None))  # type: ignore[attr-defined]
        stmt = self._apply_filters(stmt, filters)
        result = await self.session.execute(stmt)
        return int(result.scalar_one())

    def _apply_filters(self, stmt: Select, filters: dict[str, Any] | None) -> Select:
        """Apply a simple mapping of column-name -> exact-match value onto a statement."""
        if not filters:
            return stmt
        for column_name, value in filters.items():
            column = getattr(self.model, column_name)
            is_uuid_col = False
            try:
                if hasattr(column.type, "python_type") and column.type.python_type is uuid.UUID:
                    is_uuid_col = True
            except (NotImplementedError, AttributeError):
                is_uuid_col = False

            if isinstance(value, str) and isinstance(column.type, (String, Text)):
                stmt = stmt.where(func.lower(column) == value.lower())
            elif isinstance(value, str) and is_uuid_col:
                try:
                    stmt = stmt.where(column == uuid.UUID(value))
                except ValueError:
                    stmt = stmt.where(column == value)
            else:
                stmt = stmt.where(column == value)
        return stmt

    async def paginated_list(self, query: "ListQueryParams") -> tuple[list[ModelT], int]:
        """
        Fetch one page of rows plus the total matching count, applying search/sort/filters.

        This is the single entry point concrete repositories call from a
        "list" service method once they've declared ``searchable_fields``/
        ``sortable_fields``/``filterable_fields``, instead of hand-rolling
        the same search+sort+filter+paginate logic per module. Unknown
        filter keys (i.e. not in ``filterable_fields``) are silently
        ignored rather than erroring, matching
        :mod:`app.common.filtering`'s documented behavior.

        Args:
            query: The combined pagination + search + sort + filter
                parameters for one request (see
                :func:`app.common.list_query.get_list_query_params`).

        Returns:
            ``(items, total_count)`` -- ``items`` is the current page,
            ``total_count`` is the number of rows matching search/filters
            across ALL pages (for building :class:`~app.common.pagination.PageMeta`).
        """
        base_stmt = self._base_select()
        base_stmt = self._apply_search(base_stmt, query.search.normalized)
        base_stmt = self._apply_dynamic_filters(base_stmt, query.filters)

        count_stmt = select(func.count()).select_from(base_stmt.subquery())
        total = int((await self.session.execute(count_stmt)).scalar_one())

        list_stmt = self._apply_sort(base_stmt, query.sort)
        list_stmt = list_stmt.offset(query.page.offset).limit(query.page.limit)
        result = await self.session.execute(list_stmt)
        items = list(result.scalars().all())

        return items, total

    def _apply_search(self, stmt: Select, term: str | None) -> Select:
        """Apply an ``OR``-ed, case-insensitive ``ILIKE`` search across ``searchable_fields``."""
        if not term or not self.searchable_fields:
            return stmt
        pattern = f"%{term}%"
        conditions = [getattr(self.model, field).ilike(pattern) for field in self.searchable_fields]
        return stmt.where(or_(*conditions))

    def _apply_dynamic_filters(self, stmt: Select, filters: Any) -> Select:
        """Apply exact-match and date-range dynamic filters, restricted to ``filterable_fields``."""
        for column_name, value in filters.exact.items():
            if column_name not in self.filterable_fields or not hasattr(self.model, column_name):
                continue
            column = getattr(self.model, column_name)
            is_uuid_col = False
            try:
                if hasattr(column.type, "python_type") and column.type.python_type is uuid.UUID:
                    is_uuid_col = True
            except (NotImplementedError, AttributeError):
                is_uuid_col = False

            if isinstance(value, str) and isinstance(column.type, (String, Text)):
                stmt = stmt.where(func.lower(column) == value.lower())
            elif isinstance(value, str) and is_uuid_col:
                try:
                    stmt = stmt.where(column == uuid.UUID(value))
                except ValueError:
                    stmt = stmt.where(column == value)
            else:
                stmt = stmt.where(column == value)

        for column_name, bounds in filters.ranges.items():
            if not hasattr(self.model, column_name):
                continue
            column = getattr(self.model, column_name)
            if "gte" in bounds:
                stmt = stmt.where(column >= bounds["gte"])
            if "lte" in bounds:
                stmt = stmt.where(column <= bounds["lte"])

        return stmt

    def _apply_sort(self, stmt: Select, sort: Any) -> Select:
        """Apply ``?sort_by=&sort_order=``, validated against ``sortable_fields``."""
        if not sort.is_active:
            return stmt
        if sort.sort_by not in self.sortable_fields:
            raise BadRequestException(
                f"Cannot sort by {sort.sort_by!r}. Allowed fields: {', '.join(self.sortable_fields)}."
            )
        column = getattr(self.model, sort.sort_by)
        return stmt.order_by(column.desc() if sort.sort_order.value == "desc" else column.asc())

    async def create(self, **field_values: Any) -> ModelT:
        """Instantiate and persist a new row, returning the created instance."""
        instance = self.model(**field_values)
        self.session.add(instance)
        await self.session.flush()  # populate defaults (id, timestamps) without ending the transaction
        return instance

    async def update(self, instance: ModelT, expected_version: int | None = None, **field_values: Any) -> ModelT:
        """Apply the given field updates to an existing instance and flush, enforcing OCC if expected_version is provided."""
        # Extract version from field_values if present
        if expected_version is None and "version" in field_values:
            version_val = field_values.pop("version")
            if isinstance(version_val, int):
                expected_version = version_val

        current_ver = getattr(instance, "version", None)
        if expected_version is not None and current_ver is not None:
            if current_ver != expected_version:
                raise ConflictException(
                    "This record was updated by another user before you saved. "
                    "Your changes were not saved. Please refresh the record and review the latest data."
                )

        for field_name, value in field_values.items():
            if field_name != "version":
                setattr(instance, field_name, value)

        if current_ver is not None:
            setattr(instance, "version", current_ver + 1)

        await self.session.flush()
        return instance

    async def delete(self, instance: ModelT) -> None:
        """
        Delete a row.

        Performs a soft delete (sets ``deleted_at``) for models that support
        it, and a hard delete otherwise. This is decided per-model via
        ``isinstance`` rather than by the caller, so callers cannot
        accidentally bypass an intended soft-delete policy.
        """
        if isinstance(instance, SoftDeleteMixin):
            from datetime import datetime, timezone

            instance.deleted_at = datetime.now(timezone.utc)
            await self.session.flush()
        else:
            await self.session.delete(instance)
            await self.session.flush()