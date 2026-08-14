"""add soft delete to designations and roles

Revision ID: 974db96ce762
Revises: b1c2d3e4f5a8
Create Date: 2026-08-14 00:00:00.000000

Adds the ``deleted_at`` column (from ``SoftDeleteMixin``) to
``designations`` and ``roles`` -- these were the two models in the
codebase with an actual DELETE endpoint but no soft-delete support, so
deleting either one was a real, unrecoverable hard delete. This closes
that gap: deleting a designation or role now sets ``deleted_at`` instead
of removing the row, exactly like every other module (see
``app.common.base_repository.BaseRepository.delete``), and both become
visible in Trash / eligible for restore and the 4-year auto-purge (see
``app.trash.service.MODEL_MAP`` and ``app.trash.purge_worker``).

Existing rows all get ``deleted_at = NULL`` (i.e. "not deleted" --
correct, since nothing was ever soft-deleted before this column existed).
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '974db96ce762'
down_revision = 'b1c2d3e4f5a8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    designation_cols = [c["name"] for c in inspector.get_columns("designations")]
    if "deleted_at" not in designation_cols:
        op.add_column(
            "designations",
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )

    role_cols = [c["name"] for c in inspector.get_columns("roles")]
    if "deleted_at" not in role_cols:
        op.add_column(
            "roles",
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )

    # Index deleted_at on both tables -- every list/lookup query filters
    # on "deleted_at IS NULL" (see BaseRepository._base_select), so this
    # keeps that filter cheap as either table grows.
    existing_indexes_designations = {ix["name"] for ix in inspector.get_indexes("designations")}
    if "ix_designations_deleted_at" not in existing_indexes_designations:
        op.create_index("ix_designations_deleted_at", "designations", ["deleted_at"])

    existing_indexes_roles = {ix["name"] for ix in inspector.get_indexes("roles")}
    if "ix_roles_deleted_at" not in existing_indexes_roles:
        op.create_index("ix_roles_deleted_at", "roles", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_roles_deleted_at", table_name="roles")
    op.drop_index("ix_designations_deleted_at", table_name="designations")
    op.drop_column("roles", "deleted_at")
    op.drop_column("designations", "deleted_at")