"""add trgm search indexes

Revision ID: be1d2de6b659
Revises: z0a1b2c3d4e6
Create Date: 2026-08-14 00:00:00.000000

Adds PostgreSQL `pg_trgm` GIN trigram indexes on every column used by a
repository's `searchable_fields` (see app.common.base_repository's
`_apply_search`), so `ILIKE '%term%'` search stays fast once these tables
have 100k-1M+ rows.

WHY THIS IS NEEDED:
A standard B-tree index cannot accelerate a LEADING-WILDCARD ILIKE query
(`col ILIKE '%term%'`) -- B-tree indexes only help when the match starts
at the beginning of the string. Without this, every search keystroke on a
large table forces PostgreSQL to sequentially scan the entire table. A GIN
index built with `gin_trgm_ops` breaks each value into overlapping
3-character sequences ("trigrams") and CAN accelerate arbitrary substring
matching, including leading wildcards -- Postgres's query planner picks
it up automatically for existing ILIKE queries with zero application code
changes.

SCOPE:
Only tables realistically expected to reach large row counts are indexed
here (products, employees, buyers, suppliers, audit log, queue jobs).
Small, slow-growing master tables (currencies, uom, countries, etc.) are
intentionally skipped -- a GIN index has write overhead, and a sequential
scan over a few hundred rows is already effectively instant, so indexing
them would cost more (slower inserts/updates, more disk/vacuum work) than
it could ever save on reads.

For `products`, two indexes per searched column are added: one plain
trigram index (backs the base ILIKE branch) and one expression trigram
index over the same space/hyphen-normalized lowercase expression the
repository's overridden `_apply_search` actually queries (see
app.masters.products.repository.ProductRepository._apply_search) --
Postgres can only use a trigram index that matches the exact expression
in the query, so the normalized search needed its own expression index.
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = 'be1d2de6b659'
down_revision = 'z0a1b2c3d4e6'
branch_labels = None
depends_on = None


# (table, column) pairs needing a plain trigram index on the raw column.
_PLAIN_TRGM_TARGETS: list[tuple[str, str]] = [
    # Products (also gets normalized expression indexes below)
    ("products", "product_code"),
    ("products", "product_name"),
    ("products", "product_name_tally"),
    ("products", "product_name_invoice"),
    ("products", "barcode"),
    # Employees
    ("employees", "employee_code"),
    ("employees", "display_name"),
    ("employees", "first_name"),
    ("employees", "last_name"),
    ("employees", "email"),
    ("employees", "phone"),
    # Buyers / Suppliers
    ("buyers", "company_name"),
    ("suppliers", "company_name"),
    # Audit log (grows unboundedly with usage -- a strong candidate for 1M+ rows)
    ("audit_logs", "module"),
    ("audit_logs", "entity_type"),
    ("audit_logs", "endpoint"),
    ("audit_logs", "description"),
    # Background job queue
    ("queue_jobs", "job_name"),
    ("queue_jobs", "module"),
    ("queue_jobs", "error_message"),
]

# Product columns that also need a trigram index on the normalized
# (lower, spaces/hyphens stripped) expression, matching
# ProductRepository._apply_search's second condition per field.
_PRODUCT_NORMALIZED_TARGETS: list[str] = [
    "product_code",
    "product_name",
    "product_name_tally",
    "product_name_invoice",
    "barcode",
]


def upgrade() -> None:
    # pg_trgm ships with PostgreSQL's "contrib" extensions -- this just
    # turns it on for this database if it isn't already.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")

    for table, column in _PLAIN_TRGM_TARGETS:
        index_name = f"ix_{table}_{column}_trgm"
        op.execute(
            f'CREATE INDEX IF NOT EXISTS "{index_name}" '
            f'ON "{table}" USING gin ("{column}" gin_trgm_ops);'
        )

    for column in _PRODUCT_NORMALIZED_TARGETS:
        index_name = f"ix_products_{column}_normalized_trgm"
        # Must match ProductRepository._apply_search's normalized_col
        # expression EXACTLY (same functions, same argument order) or
        # Postgres will not recognize this index as usable for that query.
        op.execute(
            f'CREATE INDEX IF NOT EXISTS "{index_name}" '
            f"ON \"products\" USING gin (lower(replace(replace(\"{column}\", ' ', ''), '-', '')) gin_trgm_ops);"
        )


def downgrade() -> None:
    for column in _PRODUCT_NORMALIZED_TARGETS:
        op.execute(f'DROP INDEX IF EXISTS "ix_products_{column}_normalized_trgm";')

    for table, column in _PLAIN_TRGM_TARGETS:
        op.execute(f'DROP INDEX IF EXISTS "ix_{table}_{column}_trgm";')

    # Deliberately NOT dropping the pg_trgm extension itself on downgrade --
    # other code/extensions in the database may depend on it, and
    # re-creating it is cheap/idempotent if it's ever needed again.
