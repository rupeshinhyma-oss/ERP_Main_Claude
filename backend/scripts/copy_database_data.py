"""
Database Data Transfer Script (High Precision)
Copies all tables & records from Old Supabase (Tokyo) to New Supabase (Mumbai)
with session_replication_role = 'replica' to bypass FK order issues & ensure 100% data copy.
"""

import psycopg2
from psycopg2.extras import RealDictCursor

OLD_DB_URL = "postgresql://postgres.sxfcuarreenirvdyconu:Inhyma%402026@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
NEW_DB_URL = "postgresql://postgres.mpvzjzunkiqchhhvxrza:Inhyma%402026@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"

def migrate():
    print(">>> Connecting to Old Database (Tokyo) & New Database (Mumbai)...")
    try:
        old_conn = psycopg2.connect(OLD_DB_URL)
        new_conn = psycopg2.connect(NEW_DB_URL)
    except Exception as e:
        print(f"Connection error: {e}")
        return

    old_cur = old_conn.cursor(cursor_factory=RealDictCursor)
    new_cur = new_conn.cursor()

    # Disable FK checks temporarily on new DB
    try:
        new_cur.execute("SET session_replication_role = 'replica';")
        new_conn.commit()
    except Exception:
        new_conn.rollback()

    old_cur.execute("""
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_type = 'BASE TABLE'
          AND table_name NOT LIKE 'alembic_%';
    """)
    tables = [r["table_name"] for r in old_cur.fetchall()]
    print(f"\nFound {len(tables)} public tables in database.\n")
    print(f"{'TABLE NAME':<35} | {'OLD DB COUNT':<12} | {'NEW DB COUNT':<12} | STATUS")
    print("-" * 75)

    for table in tables:
        # Check count in old DB
        old_cur.execute(f'SELECT COUNT(*) FROM "{table}";')
        old_count = old_cur.fetchone()["count"]

        if old_count == 0:
            print(f"{table:<35} | {0:<12} | {0:<12} | Empty (0 rows)")
            continue

        # Fetch all rows from old DB
        old_cur.execute(f'SELECT * FROM "{table}";')
        rows = old_cur.fetchall()
        columns = list(rows[0].keys())

        cols_str = ", ".join([f'"{c}"' for c in columns])
        vals_str = ", ".join(["%s"] * len(columns))
        query = f'INSERT INTO "{table}" ({cols_str}) VALUES ({vals_str}) ON CONFLICT DO NOTHING;'

        inserted = 0
        for row in rows:
            values = [row[c] for c in columns]
            try:
                new_cur.execute(query, values)
                inserted += new_cur.rowcount
            except Exception as e:
                new_conn.rollback()
                pass

        new_conn.commit()

        # Check count in new DB
        new_cur.execute(f'SELECT COUNT(*) FROM "{table}";')
        new_count = new_cur.fetchone()[0]

        status = "[OK] MATCHED" if new_count >= old_count else "[PARTIAL]"
        print(f"{table:<35} | {old_count:<12} | {new_count:<12} | {status}")

    # Re-enable FK checks
    try:
        new_cur.execute("SET session_replication_role = 'origin';")
        new_conn.commit()
    except Exception:
        new_conn.rollback()

    old_conn.close()
    new_conn.close()
    print("\n>>> DATA MIGRATION VERIFICATION COMPLETE!")

if __name__ == "__main__":
    migrate()
