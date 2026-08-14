"""
API v1 Router Aggregation.

Collects every feature module's router into a single ``api_router`` that
``app.main`` mounts once under the versioned prefix. Adding a new module in
a later phase means adding one ``include_router`` line here -- no changes
to ``app.main`` are needed.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.api.v1.health import router as health_router
from app.audit.routes import router as audit_router
from app.auth.routes import router as auth_router
from app.buyers.routes import router as buyers_router
from app.cache.routes import router as cache_router
from app.core.responses import build_success_response
from app.events.routes import router as events_router
from app.inquiries.routes import router as inquiries_router
from app.masters.brands.routes import router as brands_router
from app.masters.cities.routes import router as cities_router
from app.masters.company_list.routes import router as company_list_router
from app.masters.countries.routes import router as countries_router
from app.masters.currencies.routes import router as currencies_router
from app.masters.hsn.routes import router as hsn_router
from app.masters.product_categories.routes import router as product_categories_router
from app.masters.product_sub_categories.routes import router as product_sub_categories_router
from app.masters.products.routes import router as products_router
from app.masters.states.routes import router as states_router
from app.masters.buyer_types.routes import router as buyer_types_router
from app.masters.supplier_types.routes import router as supplier_types_router
from app.masters.uom.routes import router as uom_router
from app.organizations.routes import router as organizations_router
from app.planning.routes import router as planning_router
from app.queue.routes import router as queue_router
from app.rbac.routes import router as rbac_router
from app.suppliers.routes import router as suppliers_router
from app.trash.routes import router as trash_router
from app.users.routes import router as users_router

api_router = APIRouter()

api_router.include_router(health_router)
api_router.include_router(auth_router)
api_router.include_router(users_router)
api_router.include_router(rbac_router)
api_router.include_router(queue_router)
api_router.include_router(cache_router)
api_router.include_router(audit_router)
api_router.include_router(trash_router)

# Phase 6: Core Organization & User Management.
api_router.include_router(organizations_router)

# Phase 7: Master Data Management.
api_router.include_router(countries_router)
api_router.include_router(states_router)
api_router.include_router(cities_router)
api_router.include_router(currencies_router)
api_router.include_router(uom_router)
api_router.include_router(hsn_router)
api_router.include_router(brands_router)
api_router.include_router(product_categories_router)
api_router.include_router(product_sub_categories_router)
api_router.include_router(products_router)
api_router.include_router(company_list_router)
api_router.include_router(supplier_types_router)
api_router.include_router(buyer_types_router)

# Phase 8: Supplier Management.
api_router.include_router(suppliers_router)

# Buyers (Client) Management.
api_router.include_router(buyers_router)

# Inquiries (Requirement) workflow -- two-layer consignment planning.
api_router.include_router(inquiries_router)

# Shipment Planning: dynamic branch-sheet grid (Mum Branch, MP Branch, ...).
api_router.include_router(planning_router)

# Phase 1 (Live Events): generic real-time WebSocket infrastructure --
# see app/events/ and doc/EVENTS_ARCHITECTURE.md. Not module-specific;
# any future module's routes/services publish through this without
# needing their own router entry here.
api_router.include_router(events_router)


@api_router.get("/organizations/public", summary="Get public organization info for login page")
async def get_public_org_info(request: Request) -> dict:
    return build_success_response(
        data={"id": "default", "name": "Yinglima ERP", "logo_url": None},
        request_id=getattr(request.state, "request_id", "-"),
    )

