"""
Alembic Migration Environment.

Wires Alembic to the application's own configuration and ORM metadata so
there is exactly one source of truth for both:

1. The database URL       -> sourced from ``app.core.config.settings``
   (via ``settings.sync_database_url``, since Alembic migrations run
   synchronously even though the application itself is fully async).
2. The table metadata      -> sourced from ``app.database.base.Base.metadata``,
   after importing every feature module's ``models`` submodule so that
   ``--autogenerate`` can see every table when generating a migration.

This file is largely Alembic boilerplate with two customizations: the
``sqlalchemy.url`` injection and the ``target_metadata`` wiring, both
clearly marked below.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import settings
from app.database.base import Base

# -----------------------------------------------------------------------
# Import every feature module's ORM models here so Base.metadata is fully
# populated before Alembic inspects it for autogenerate. Future phases
# append to this list, e.g.:
#
#   import app.organizations.models  # noqa: F401
#   import app.departments.models    # noqa: F401
# -----------------------------------------------------------------------
import app.users.models  # noqa: F401,E402
import app.rbac.models  # noqa: F401,E402
import app.auth.models  # noqa: F401,E402
import app.queue.models  # noqa: F401,E402 - was missing; autogenerate couldn't see queue_jobs
import app.audit.models  # noqa: F401,E402
import app.organizations.models  # noqa: F401,E402 - Phase 6
import app.designations.models  # noqa: F401,E402 - Phase 6 (imported before departments: no FK dependency)
import app.departments.models  # noqa: F401,E402 - Phase 6
import app.employees.models  # noqa: F401,E402 - Phase 6
import app.masters.countries.models  # noqa: F401,E402 - Phase 7
import app.masters.states.models  # noqa: F401,E402 - Phase 7
import app.masters.cities.models  # noqa: F401,E402 - Phase 7
import app.masters.currencies.models  # noqa: F401,E402 - Phase 7
import app.masters.uom.models  # noqa: F401,E402 - Phase 7
import app.masters.hsn.models  # noqa: F401,E402 - Phase 7
import app.masters.brands.models  # noqa: F401,E402 - Phase 7
import app.masters.product_categories.models  # noqa: F401,E402 - Phase 7
import app.masters.product_sub_categories.models  # noqa: F401,E402 - Phase 7
import app.masters.products.models  # noqa: F401,E402 - Phase 7
import app.suppliers.models  # noqa: F401,E402 - Phase 8

# This is the Alembic Config object, providing access to the values within
# the .ini file in use.
config = context.config

# Inject our single source of truth for the DB URL (see module docstring).
#
# configparser (which backs alembic.ini / this Config object) treats "%" as
# its interpolation-syntax marker (e.g. "%(foo)s"), so a raw "%" in the URL
# -- e.g. from a URL-encoded password character like "%40" for "@" -- raises
# "invalid interpolation syntax" here unless doubled to "%%" first. This
# doubling is undone by configparser itself when the value is later read
# back, so the URL SQLAlchemy actually receives is unescaped/correct.
config.set_main_option("sqlalchemy.url", settings.sync_database_url.replace("%", "%%"))

# Interpret the config file for Python logging, unless it's disabled.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Point Alembic's autogenerate support at our combined ORM metadata.
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """
    Run migrations in 'offline' mode.

    Configures the context with just a URL and not an Engine, so no
    DBAPI connection is required. Calls to ``context.execute()`` emit the
    given string to the script output, which is useful for generating SQL
    scripts to hand to a DBA rather than running migrations directly.
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """
    Run migrations in 'online' mode.

    Creates a synchronous Engine (via ``psycopg2``, per
    ``settings.sync_database_url``) and associates a connection with the
    migration context, so migrations run as real DDL against the target
    database.
    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()