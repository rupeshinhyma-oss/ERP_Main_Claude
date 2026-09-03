"""create department hierarchy table

Revision ID: e8f9a0b1c2d3
Revises: d4h5p6q7r8s9
Create Date: 2026-09-03 15:30:00.000000

Supports many-to-many department hierarchies (multiple parents and multiple children).
Preserves existing roles.parent_department_id for backward compatibility while populating
initial entries in department_hierarchy.
"""

from typing import Sequence, Union
import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
import app.database.base

# revision identifiers, used by Alembic.
revision: str = "e8f9a0b1c2d3"
down_revision: Union[str, None] = "d4h5p6q7r8s9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create department_hierarchy table
    op.create_table(
        "department_hierarchy",
        sa.Column("id", app.database.base.GUID(), primary_key=True, default=uuid.uuid4),
        sa.Column("parent_department_id", app.database.base.GUID(), nullable=False),
        sa.Column("child_department_id", app.database.base.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["parent_department_id"],
            ["roles.id"],
            name="fk_dept_hierarchy_parent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["child_department_id"],
            ["roles.id"],
            name="fk_dept_hierarchy_child",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "parent_department_id",
            "child_department_id",
            name="uq_department_hierarchy",
        ),
        sa.CheckConstraint(
            "parent_department_id != child_department_id",
            name="ck_department_hierarchy_no_self",
        ),
    )

    op.create_index(
        "ix_dept_hierarchy_parent",
        "department_hierarchy",
        ["parent_department_id"],
        unique=False,
    )
    op.create_index(
        "ix_dept_hierarchy_child",
        "department_hierarchy",
        ["child_department_id"],
        unique=False,
    )

    # 2. Backfill existing parent-child assignments from roles table
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            INSERT INTO department_hierarchy (id, parent_department_id, child_department_id, created_at)
            SELECT gen_random_uuid(), parent_department_id, id, NOW()
            FROM roles
            WHERE parent_department_id IS NOT NULL
              AND deleted_at IS NULL
            ON CONFLICT DO NOTHING
            """
        )
    )


def downgrade() -> None:
    op.drop_index("ix_dept_hierarchy_child", table_name="department_hierarchy")
    op.drop_index("ix_dept_hierarchy_parent", table_name="department_hierarchy")
    op.drop_table("department_hierarchy")
