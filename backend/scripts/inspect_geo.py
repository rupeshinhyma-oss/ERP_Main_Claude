import asyncio
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from sqlalchemy import select
from app.database.engine import get_sessionmaker, dispose_engine
from app.masters.countries.models import Country
from app.masters.states.models import State
from app.masters.cities.models import City

async def inspect():
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        countries = (await session.execute(select(Country))).scalars().all()
        print("--- COUNTRIES ---")
        for c in countries:
            print(f"{c.id} | {c.name} | {c.code}")
            
        states = (await session.execute(select(State))).scalars().all()
        print("\n--- STATES / PROVINCES ---")
        for s in states:
            print(f"{s.id} | {s.name} | country_id={s.country_id}")
            
        cities = (await session.execute(select(City))).scalars().all()
        print("\n--- CITIES ---")
        for ci in cities:
            print(f"{ci.id} | {ci.name} | state_id={ci.state_id} | country_id={ci.country_id}")

if __name__ == "__main__":
    asyncio.run(inspect())
