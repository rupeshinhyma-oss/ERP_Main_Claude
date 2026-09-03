"""create employees table

Revision ID: a1e2m3p4l5y6
Revises: t1u2v3w4x5y6
Create Date: 2026-09-02 00:00:00.000000

Organization, Employee, Identity & Access Management upgrade -- Part 1.

Adds the ``employees`` table as a NEW, purely additive table. Does not
touch the ``users`` table at all: every existing column, constraint, and
index on ``users`` (including its own ``employee_code``/``manager_id``/HR
columns) is left exactly as-is, so nothing that already reads from
``users`` can break. See ``app/employees/models.py`` for the full
rationale on why this is a fresh table rather than a revival of the old
one-to-one Employee<->User shape this codebase already tried once
(``j4k5l6m7n8o9_merge_employees_into_users``).
"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'a1e2m3p4l5y6'
down_revision = 't1u2v3w4x5y6'

branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'employees',
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('user_id', app.database.base.GUID(), nullable=True),
        sa.Column('employee_code', sa.String(length=50), nullable=False),
        sa.Column('first_name', sa.String(length=100), nullable=False),
        sa.Column('middle_name', sa.String(length=100), nullable=True),
        sa.Column('last_name', sa.String(length=100), nullable=True),
        sa.Column('display_name', sa.String(length=200), nullable=True),
        sa.Column('email', sa.String(length=255), nullable=True),
        sa.Column('phone', sa.String(length=30), nullable=True),
        sa.Column('date_of_birth', sa.Date(), nullable=True),
        sa.Column('gender', sa.Enum('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY', name='employee_gender', native_enum=False, length=20), nullable=True),
        sa.Column('date_of_joining', sa.Date(), nullable=True),
        sa.Column('employment_type', sa.Enum('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY', name='employee_employment_type', native_enum=False, length=20), nullable=True, server_default='FULL_TIME'),
        sa.Column('employment_status', sa.Enum('ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED', 'RESIGNED', name='employee_employment_status', native_enum=False, length=20), nullable=True, server_default='ACTIVE'),
        sa.Column('profile_picture_url', sa.String(length=500), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('city', sa.String(length=100), nullable=True),
        sa.Column('state', sa.String(length=100), nullable=True),
        sa.Column('country', sa.String(length=100), nullable=True),
        sa.Column('postal_code', sa.String(length=20), nullable=True),
        sa.Column('emergency_contact', sa.String(length=255), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by', app.database.base.GUID(), nullable=True),
        sa.Column('updated_by', app.database.base.GUID(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['updated_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('employee_code'),
        sa.UniqueConstraint('user_id', name='uq_employees_user_id'),
    )
    op.create_index('ix_employees_employee_code', 'employees', ['employee_code'], unique=True)
    op.create_index('ix_employees_user_id', 'employees', ['user_id'], unique=False)
    op.create_index('ix_employees_display_name', 'employees', ['display_name'], unique=False)
    op.create_index('ix_employees_email', 'employees', ['email'], unique=False)
    op.create_index('ix_employees_phone', 'employees', ['phone'], unique=False)
    op.create_index('ix_employees_employment_status', 'employees', ['employment_status'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_employees_employment_status', table_name='employees')
    op.drop_index('ix_employees_phone', table_name='employees')
    op.drop_index('ix_employees_email', table_name='employees')
    op.drop_index('ix_employees_display_name', table_name='employees')
    op.drop_index('ix_employees_user_id', table_name='employees')
    op.drop_index('ix_employees_employee_code', table_name='employees')
    op.drop_table('employees')
