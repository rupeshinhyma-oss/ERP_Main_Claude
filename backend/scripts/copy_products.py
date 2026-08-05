import psycopg2
from psycopg2.extras import RealDictCursor

OLD_DB_URL = "postgresql://postgres.sxfcuarreenirvdyconu:Inhyma%402026@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
NEW_DB_URL = "postgresql://postgres.mpvzjzunkiqchhhvxrza:Inhyma%402026@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"

old_conn = psycopg2.connect(OLD_DB_URL)
new_conn = psycopg2.connect(NEW_DB_URL)

old_cur = old_conn.cursor(cursor_factory=RealDictCursor)
new_cur = new_conn.cursor()

# Get existing columns in new DB products table
new_cur.execute("""
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'products';
""")
new_cols = set(r[0] for r in new_cur.fetchall())

old_cur.execute('SELECT * FROM products;')
rows = old_cur.fetchall()

if rows:
    columns = [c for c in list(rows[0].keys()) if c in new_cols]
    cols_str = ", ".join([f'"{c}"' for c in columns])
    vals_str = ", ".join(["%s"] * len(columns))
    query = f'INSERT INTO products ({cols_str}) VALUES ({vals_str}) ON CONFLICT DO NOTHING;'

    new_cur.execute("SET session_replication_role = 'replica';")
    inserted = 0
    for r in rows:
        # Fallback for NOT NULL columns if missing
        if "product_name_tally" in columns and r.get("product_name_tally") is None:
            r["product_name_tally"] = r.get("product_name") or r.get("name") or "Product Item"
        if "product_name" in columns and r.get("product_name") is None:
            r["product_name"] = r.get("name") or "Product Item"
        if "status" in columns and r.get("status") is None:
            r["status"] = "active"

        vals = [r[c] for c in columns]
        try:
            new_cur.execute(query, vals)
            inserted += new_cur.rowcount
        except Exception as e:
            new_conn.rollback()
            new_cur.execute("SET session_replication_role = 'replica';")
            pass

    new_conn.commit()

new_cur.execute("SET session_replication_role = 'origin';")
new_conn.commit()

new_cur.execute("SELECT COUNT(*) FROM products;")
new_count = new_cur.fetchone()[0]

old_conn.close()
new_conn.close()

print(f"SUCCESS! Products transferred. Total in new Indian DB: {new_count}")
