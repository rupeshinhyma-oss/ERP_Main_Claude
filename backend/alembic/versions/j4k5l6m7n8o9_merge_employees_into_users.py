"""merge_employees_into_users

Revision ID: j4k5l6m7n8o9
Revises: i3j4k5l6m7n8
Create Date: 2026-08-05 16:45:00.000000

"""
from alembic import op
import sqlalchemy as sa
import app.database.base


revision = 'j4k5l6m7n8o9'
down_revision = 'i3j4k5l6m7n8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Apply schema changes to merge Employee columns into Users and drop employees table."""
    bind = op.get_bind()
    insp = sa.inspect(bind)

    user_cols = {c['name'] for c in insp.get_columns('users')}

    # Add profile columns to users table if missing
    if 'first_name' not in user_cols:
        op.add_column('users', sa.Column('first_name', sa.String(length=100), nullable=True))
    if 'middle_name' not in user_cols:
        op.add_column('users', sa.Column('middle_name', sa.String(length=100), nullable=True))
    if 'last_name' not in user_cols:
        op.add_column('users', sa.Column('last_name', sa.String(length=100), nullable=True))
    if 'display_name' not in user_cols:
        op.add_column('users', sa.Column('display_name', sa.String(length=200), nullable=True))
    if 'department_id' not in user_cols:
        op.add_column('users', sa.Column('department_id', app.database.base.GUID(), nullable=True))
        op.create_foreign_key('fk_users_department_id', 'users', 'departments', ['department_id'], ['id'], ondelete='SET NULL')
    if 'designation_id' not in user_cols:
        op.add_column('users', sa.Column('designation_id', app.database.base.GUID(), nullable=True))
        op.create_foreign_key('fk_users_designation_id', 'users', 'designations', ['designation_id'], ['id'], ondelete='SET NULL')
    if 'manager_id' not in user_cols:
        op.add_column('users', sa.Column('manager_id', app.database.base.GUID(), nullable=True))
        op.create_foreign_key('fk_users_manager_id', 'users', 'users', ['manager_id'], ['id'], ondelete='SET NULL')
    if 'date_of_birth' not in user_cols:
        op.add_column('users', sa.Column('date_of_birth', sa.Date(), nullable=True))
    if 'gender' not in user_cols:
        op.add_column('users', sa.Column('gender', sa.Enum('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY', name='user_gender', native_enum=False, length=20), nullable=True))
    if 'date_of_joining' not in user_cols:
        op.add_column('users', sa.Column('date_of_joining', sa.Date(), nullable=True))
    if 'employment_type' not in user_cols:
        op.add_column('users', sa.Column('employment_type', sa.Enum('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY', name='user_employment_type', native_enum=False, length=20), nullable=True, server_default='FULL_TIME'))
    if 'employment_status' not in user_cols:
        op.add_column('users', sa.Column('employment_status', sa.Enum('ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED', 'RESIGNED', name='user_employment_status', native_enum=False, length=20), nullable=True, server_default='ACTIVE'))
    if 'profile_picture_url' not in user_cols:
        op.add_column('users', sa.Column('profile_picture_url', sa.String(length=500), nullable=True))
    if 'address' not in user_cols:
        op.add_column('users', sa.Column('address', sa.Text(), nullable=True))
    if 'city' not in user_cols:
        op.add_column('users', sa.Column('city', sa.String(length=100), nullable=True))
    if 'state' not in user_cols:
        op.add_column('users', sa.Column('state', sa.String(length=100), nullable=True))
    if 'country' not in user_cols:
        op.add_column('users', sa.Column('country', sa.String(length=100), nullable=True))
    if 'postal_code' not in user_cols:
        op.add_column('users', sa.Column('postal_code', sa.String(length=20), nullable=True))
    if 'emergency_contact' not in user_cols:
        op.add_column('users', sa.Column('emergency_contact', sa.String(length=255), nullable=True))
    if 'notes' not in user_cols:
        op.add_column('users', sa.Column('notes', sa.Text(), nullable=True))

    # Update departments manager foreign key if needed
    if insp.has_table('departments'):
        try:
            op.drop_constraint('fk_departments_manager_id', 'departments', type_='foreignkey')
        except Exception:
            pass
        # Clean up any orphaned manager_id references that do not exist in users table
        op.execute("UPDATE departments SET manager_id = NULL WHERE manager_id IS NOT NULL AND manager_id NOT IN (SELECT id FROM users)")
        op.create_foreign_key('fk_departments_manager_id', 'departments', 'users', ['manager_id'], ['id'], ondelete='SET NULL', use_alter=True)

    # Safely drop employees table if it exists
    if insp.has_table('employees'):
        op.drop_table('employees')


def downgrade() -> None:
    """Revert schema changes."""
    pass
