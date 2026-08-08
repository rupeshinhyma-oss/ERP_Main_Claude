"""
One-time data fix: normalize stray uppercase enum values in Shipment
Planning tables back to lowercase.

Root cause: an earlier version of app/planning/models.py (before the
values_callable fix) wrote the Python enum MEMBER NAME (e.g.
"BOOLEAN_YN") into the database instead of its VALUE (e.g. "boolean_yn").
Any row written while that version was running now has the wrong case
baked in, and every read of it crashes with a LookupError. The code side
is already fixed (values_callable=_enum_values in models.py) -- this
script corrects the data that older code already wrote.

Usage (from the backend/ directory, with your venv active):

    python fix_planning_enum_data.py

Safe to run more than once: every UPDATE only touches rows that don't
already match the correct lowercase value, and no blanket lower() is
used anywhere, so a value that was never a valid enum member is left
untouched rather than silently "corrected" into something wrong.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings

# (table, column, {WRONG_UPPERCASE: correct_lowercase})
FIXES: list[tuple[str, str, dict[str, str]]] = [
    (
        "planning_columns",
        "data_type",
        {"TEXT": "text", "NUMBER": "number", "DATE": "date", "BOOLEAN_YN": "boolean_yn"},
    ),
    (
        "planning_columns",
        "source_type",
        {
            "MANUAL": "manual",
            "LINKED_LOOKUP": "linked_lookup",
            "AGGREGATE": "aggregate",
            "FORMULA": "formula",
        },
    ),
    (
        "planning_cells",
        "status_color",
        {
            "RED_REQUIREMENT": "red_requirement",
            "BLUE_ORDERED": "blue_ordered",
            "GREEN_PURCHASED": "green_purchased",
            "CUSTOM": "custom",
        },
    ),
]


async def main() -> None:
    engine = create_async_engine(str(settings.DATABASE_URL))
    total_fixed = 0

    async with engine.begin() as conn:
        for table, column, mapping in FIXES:
            for wrong_value, correct_value in mapping.items():
                result = await conn.execute(
                    text(f"UPDATE {table} SET {column} = :correct WHERE {column} = :wrong"),
                    {"correct": correct_value, "wrong": wrong_value},
                )
                if result.rowcount:
                    print(f"Fixed {result.rowcount} row(s) in {table}.{column}: {wrong_value!r} -> {correct_value!r}")
                    total_fixed += result.rowcount

    await engine.dispose()

    if total_fixed == 0:
        print("No stray uppercase values found -- nothing to fix.")
    else:
        print(f"\nDone. Fixed {total_fixed} row(s) total.")


if __name__ == "__main__":
    asyncio.run(main())
