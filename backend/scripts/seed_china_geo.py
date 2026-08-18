import asyncio
import os
import sys
import uuid
from sqlalchemy import select, update

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.database.engine import get_sessionmaker, dispose_engine
from app.masters.countries.models import Country
from app.masters.states.models import State
from app.masters.cities.models import City
from app.core.constants import RecordStatus

CHINA_PROVINCES_AND_CITIES = {
    "Zhejiang": {
        "code": "ZHE",
        "cities": ["Hangzhou", "Ningbo", "Wenzhou", "Yiwu", "Shaoxing", "Jiaxing", "Jinhua", "Taizhou", "Huzhou", "Quzhou"],
    },
    "Guangdong": {
        "code": "GUA",
        "cities": ["Guangzhou", "Shenzhen", "Dongguan", "Foshan", "Zhongshan", "Zhuhai", "Huizhou", "Shantou", "Jiangmen", "Chaozhou"],
    },
    "Jiangsu": {
        "code": "JIA",
        "cities": ["Nanjing", "Suzhou", "Wuxi", "Changzhou", "Nantong", "Yangzhou", "Xuzhou", "Zhenjiang", "Taizhou", "Yancheng"],
    },
    "Shanghai": {
        "code": "SH",
        "cities": ["Shanghai"],
    },
    "Beijing": {
        "code": "BJ",
        "cities": ["Beijing"],
    },
    "Tianjin": {
        "code": "TJ",
        "cities": ["Tianjin"],
    },
    "Chongqing": {
        "code": "CQ",
        "cities": ["Chongqing"],
    },
    "Shandong": {
        "code": "SD",
        "cities": ["Jinan", "Qingdao", "Yantai", "Weifang", "Zibo", "Linyi", "Weihai"],
    },
    "Fujian": {
        "code": "FJ",
        "cities": ["Fuzhou", "Xiamen", "Quanzhou", "Zhangzhou", "Putian"],
    },
    "Anhui": {
        "code": "ANH",
        "cities": ["Hefei", "Wuhu", "Bengbu", "Anqing", "Ma'anshan", "Chuzhou", "Tongling", "Fuyang"],
    },
    "Hebei": {
        "code": "HEB",
        "cities": ["Shijiazhuang", "Tangshan", "Baoding", "Langfang", "Cangzhou"],
    },
    "Henan": {
        "code": "HEN",
        "cities": ["Zhengzhou", "Luoyang", "Xinxiang", "Nanyang"],
    },
    "Hubei": {
        "code": "HUB",
        "cities": ["Wuhan", "Yichang", "Xiangyang"],
    },
    "Hunan": {
        "code": "HUN",
        "cities": ["Changsha", "Zhuzhou", "Xiangtan"],
    },
    "Sichuan": {
        "code": "SC",
        "cities": ["Chengdu", "Mianyang", "Deyang"],
    },
    "Shaanxi": {
        "code": "SN",
        "cities": ["Xi'an", "Baoji", "Xianyang"],
    },
    "Jiangxi": {
        "code": "JX",
        "cities": ["Nanchang", "Jiujiang", "Ganzhou"],
    },
}

async def seed_china(session=None):
    if session is not None:
        await _seed_china_internal(session)
    else:
        sessionmaker = get_sessionmaker()
        async with sessionmaker() as sess:
            await _seed_china_internal(sess)
        await dispose_engine()

async def _seed_china_internal(session):
    stmt = select(Country).where(Country.name.ilike("China"))
    china = (await session.execute(stmt)).scalar_one_or_none()
    if not china:
        logger.warning("China not found in countries table; skipping China geo seed.")
        return
    
    for prov_name, prov_data in CHINA_PROVINCES_AND_CITIES.items():
        state_stmt = select(State).where(State.country_id == china.id, State.name.ilike(prov_name))
        state = (await session.execute(state_stmt)).scalar_one_or_none()
        if not state:
            state = State(
                id=uuid.uuid4(),
                country_id=china.id,
                name=prov_name,
                code=prov_data["code"],
                status=RecordStatus.ACTIVE,
            )
            session.add(state)
            await session.flush()
        else:
            if not state.code:
                state.code = prov_data["code"]

        for city_name in prov_data["cities"]:
            if city_name.lower() == "shanghai" and prov_name == "Shanghai":
                old_sh = (await session.execute(select(City).where(City.name.ilike("shanghai"), City.country_id == china.id))).scalar_one_or_none()
                if old_sh:
                    old_sh.state_id = state.id
                    continue

            city_stmt = select(City).where(City.state_id == state.id, City.name.ilike(city_name))
            city = (await session.execute(city_stmt)).scalar_one_or_none()
            if not city:
                city = City(
                    id=uuid.uuid4(),
                    country_id=china.id,
                    state_id=state.id,
                    name=city_name,
                    status=RecordStatus.ACTIVE,
                )
                session.add(city)

    await session.commit()

if __name__ == "__main__":
    asyncio.run(seed_china())
