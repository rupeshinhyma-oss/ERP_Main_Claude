"""phase6_organization_and_hr

Revision ID: c8f4a2b1e6d7
Revises: b7e2f1a9c3d4
Create Date: 2026-08-03 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'c8f4a2b1e6d7'
down_revision = 'b7e2f1a9c3d4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply this migration's schema changes."""
    # --- organizations (single-row company profile) ---------------------------
    op.create_table(
        'organizations',
        sa.Column('company_name', sa.String(length=200), nullable=False),
        sa.Column('legal_name', sa.String(length=200), nullable=True),
        sa.Column('logo_url', sa.String(length=500), nullable=True),
        sa.Column('gst_number', sa.String(length=50), nullable=True),
        sa.Column('pan_number', sa.String(length=50), nullable=True),
        sa.Column('email', sa.String(length=255), nullable=True),
        sa.Column('phone', sa.String(length=30), nullable=True),
        sa.Column('website', sa.String(length=255), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('city', sa.String(length=100), nullable=True),
        sa.Column('state', sa.String(length=100), nullable=True),
        sa.Column('country', sa.String(length=100), nullable=True),
        sa.Column('postal_code', sa.String(length=20), nullable=True),
        sa.Column('timezone', sa.String(length=50), nullable=False),
        sa.Column('currency', sa.String(length=10), nullable=False),
        sa.Column('business_hours', sa.String(length=255), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='organization_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- designations -----------------------------------------------------------
    op.create_table(
        'designations',
        sa.Column('code', sa.String(length=50), nullable=False),
        sa.Column('title', sa.String(length=150), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('level', sa.Integer(), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='designation_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_designations_code'), 'designations', ['code'], unique=True)
    op.create_index(op.f('ix_designations_title'), 'designations', ['title'], unique=False)
    op.create_index(op.f('ix_designations_status'), 'designations', ['status'], unique=False)

    # --- departments --------------------------------------------------------------
    # `manager_id` (-> employees.id) is added later via ALTER TABLE, once the
    # `employees` table exists, to break the departments<->employees create-order
    # cycle (see app.departments.models for the corresponding use_alter=True).
    op.create_table(
        'departments',
        sa.Column('code', sa.String(length=50), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('parent_department_id', app.database.base.GUID(), nullable=True),
        sa.Column('manager_id', app.database.base.GUID(), nullable=True),
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='department_status', native_enum=False, length=20),
            nullable=False,
        ),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['parent_department_id'], ['departments.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_departments_code'), 'departments', ['code'], unique=True)
    op.create_index(op.f('ix_departments_name'), 'departments', ['name'], unique=False)
    op.create_index(op.f('ix_departments_status'), 'departments', ['status'], unique=False)
    op.create_index(
        op.f('ix_departments_parent_department_id'), 'departments', ['parent_department_id'], unique=False
    )
    op.create_index(op.f('ix_departments_manager_id'), 'departments', ['manager_id'], unique=False)

    # --- employees ------------------------------------------------------------------
    op.create_table(
        'employees',
        sa.Column('employee_code', sa.String(length=50), nullable=False),
        sa.Column('first_name', sa.String(length=100), nullable=False),
        sa.Column('middle_name', sa.String(length=100), nullable=True),
        sa.Column('last_name', sa.String(length=100), nullable=False),
        sa.Column('display_name', sa.String(length=200), nullable=False),
        sa.Column('email', sa.String(length=255), nullable=False),
        sa.Column('phone', sa.String(length=30), nullable=True),
        sa.Column('emergency_contact', sa.String(length=255), nullable=True),
        sa.Column('date_of_birth', sa.Date(), nullable=True),
        sa.Column(
            'gender',
            sa.Enum('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY', name='employee_gender', native_enum=False, length=20),
            nullable=True,
        ),
        sa.Column('date_of_joining', sa.Date(), nullable=False),
        sa.Column('department_id', app.database.base.GUID(), nullable=True),
        sa.Column('designation_id', app.database.base.GUID(), nullable=True),
        sa.Column('manager_id', app.database.base.GUID(), nullable=True),
        sa.Column(
            'employment_type',
            sa.Enum(
                'FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY',
                name='employment_type', native_enum=False, length=20,
            ),
            nullable=False,
        ),
        sa.Column(
            'employment_status',
            sa.Enum(
                'ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED', 'RESIGNED',
                name='employment_status', native_enum=False, length=20,
            ),
            nullable=False,
        ),
        sa.Column('profile_picture_url', sa.String(length=500), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('city', sa.String(length=100), nullable=True),
        sa.Column('state', sa.String(length=100), nullable=True),
        sa.Column('country', sa.String(length=100), nullable=True),
        sa.Column('postal_code', sa.String(length=20), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('user_id', app.database.base.GUID(), nullable=True),
        sa.Column('created_by', app.database.base.GUID(), nullable=True),
        sa.Column('updated_by', app.database.base.GUID(), nullable=True),
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['designation_id'], ['designations.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['manager_id'], ['employees.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['updated_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_employees_employee_code'), 'employees', ['employee_code'], unique=True)
    op.create_index(op.f('ix_employees_display_name'), 'employees', ['display_name'], unique=False)
    op.create_index(op.f('ix_employees_email'), 'employees', ['email'], unique=True)
    op.create_index(op.f('ix_employees_phone'), 'employees', ['phone'], unique=True)
    op.create_index(op.f('ix_employees_department_id'), 'employees', ['department_id'], unique=False)
    op.create_index(op.f('ix_employees_designation_id'), 'employees', ['designation_id'], unique=False)
    op.create_index(op.f('ix_employees_manager_id'), 'employees', ['manager_id'], unique=False)
    op.create_index(op.f('ix_employees_employment_status'), 'employees', ['employment_status'], unique=False)
    op.create_index(op.f('ix_employees_user_id'), 'employees', ['user_id'], unique=True)

    # --- deferred FK: departments.manager_id -> employees.id ------------------------
    op.create_foreign_key(
        'fk_departments_manager_id',
        'departments', 'employees',
        ['manager_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    """Revert this migration's schema changes."""
    op.drop_constraint('fk_departments_manager_id', 'departments', type_='foreignkey')
    op.drop_index(op.f('ix_employees_phone'), table_name='employees')
    op.drop_table('employees')
    op.drop_index(op.f('ix_departments_manager_id'), table_name='departments')
    op.drop_index(op.f('ix_departments_parent_department_id'), table_name='departments')
    op.drop_index(op.f('ix_departments_status'), table_name='departments')
    op.drop_index(op.f('ix_departments_name'), table_name='departments')
    op.drop_index(op.f('ix_departments_code'), table_name='departments')
    op.drop_table('departments')
    op.drop_index(op.f('ix_designations_status'), table_name='designations')
    op.drop_index(op.f('ix_designations_title'), table_name='designations')
    op.drop_index(op.f('ix_designations_code'), table_name='designations')
    op.drop_table('designations')
    op.drop_table('organizations')
