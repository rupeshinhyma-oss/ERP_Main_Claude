"""require unique phone on users (enables phone-number login)

Revision ID: k5l6m7n8o9p0
Revises: f9a8c7b6e5d4
Create Date: 2026-08-08 00:00:00.000000

Makes ``users.phone`` NOT NULL + UNIQUE + indexed, so it can be used
interchangeably with username/email as a login identifier.

Any existing rows with a NULL phone are backfilled with a clearly-fake
placeholder value (``UNSET-<short-id>``) before the NOT NULL constraint is
applied, so the migration never fails on legacy data. Replace those
placeholders with real phone numbers via the Users admin screen after
this migration runs.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'k5l6m7n8o9p0'
down_revision = 'f9a8c7b6e5d4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Backfill any NULL phone values with a unique placeholder so the
    #    NOT NULL + UNIQUE constraints below can be applied safely.
    op.execute(
        """
        UPDATE users
        SET phone = 'UNSET-' || substring(id::text, 1, 8)
        WHERE phone IS NULL;
        """
    )

    # 2. Enforce NOT NULL.
    op.execute("ALTER TABLE users ALTER COLUMN phone SET NOT NULL;")

    # 3. Enforce UNIQUE + index (mirrors how `username`/`email` are declared).
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'uq_users_phone'
            ) THEN
                ALTER TABLE users ADD CONSTRAINT uq_users_phone UNIQUE (phone);
            END IF;
        END $$;
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_users_phone ON users (phone);")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_users_phone;")
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_phone;")
    op.execute("ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;")
