"""
Queue Module — Phase 4.

Database-backed background job queue. Everything runs inside this single
ERP process; no external broker (Redis, RabbitMQ, Celery) is required.

Architecture:
    - ``constants.py``    : JobStatus and JobPriority enums.
    - ``models.py``       : QueueJob ORM model (the queue_jobs table).
    - ``repository.py``   : QueueRepository — only DB access, no business logic.
    - ``service.py``      : QueueService — all job orchestration logic.
    - ``worker.py``       : BackgroundWorker — asyncio task that polls and runs jobs.
    - ``registry.py``     : Job handler registry — future modules register handlers here.
    - ``schemas.py``      : Pydantic request/response schemas.
    - ``routes.py``       : FastAPI API endpoints for managing jobs.
    - ``dependencies.py`` : FastAPI DI wiring.

How future modules register a job handler::

    # In app/notifications/jobs.py (Phase 5+):
    from app.queue.registry import register

    @register("send_welcome_email")
    async def send_welcome_email(payload: dict) -> None:
        user_id = payload["user_id"]
        # ... send the email ...
"""
