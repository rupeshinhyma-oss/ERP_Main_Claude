"""
Trash API Routes.
"""

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.database.session import get_db_session
from app.trash.schemas import TrashItemResponse, TrashRestoreRequest, TrashPermanentDeleteRequest
from app.trash.service import TrashService

router = APIRouter(prefix="/trash", tags=["Trash Management"])


@router.get("", summary="List all soft-deleted items")
async def list_trash(
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    """Fetch soft-deleted items across all modules."""
    service = TrashService(db)
    items = await service.list_trash()
    data = [TrashItemResponse.model_validate(item).model_dump(mode="json") for item in items]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/restore", summary="Restore soft-deleted items")
async def restore_trash(
    payload: TrashRestoreRequest,
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    """Restore selected soft-deleted items back to active state."""
    service = TrashService(db)
    restored_count = 0
    for item in payload.items:
        entity_type = item.get("entity_type")
        item_id = item.get("id")
        if entity_type and item_id:
            await service.restore_item(entity_type, item_id)
            restored_count += 1

    return build_success_response(
        data={"restored_count": restored_count, "message": f"Successfully restored {restored_count} item(s)."},
        request_id=request.state.request_id,
    )


@router.post("/permanent-delete", summary="Permanently delete items from database")
async def permanent_delete_trash(
    payload: TrashPermanentDeleteRequest,
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    """Permanently delete selected soft-deleted items from the database."""
    service = TrashService(db)
    deleted_count = 0
    for item in payload.items:
        entity_type = item.get("entity_type")
        item_id = item.get("id")
        if entity_type and item_id:
            await service.hard_delete_item(entity_type, item_id)
            deleted_count += 1

    return build_success_response(
        data={"deleted_count": deleted_count, "message": f"Permanently deleted {deleted_count} item(s) from database."},
        request_id=request.state.request_id,
    )


@router.post("/empty", summary="Empty all items in trash permanently")
async def empty_trash(
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    """Permanently delete ALL soft-deleted records from the database."""
    service = TrashService(db)
    deleted_count = await service.empty_trash()
    return build_success_response(
        data={"deleted_count": deleted_count, "message": f"Permanently deleted {deleted_count} item(s) from database."},
        request_id=request.state.request_id,
    )
