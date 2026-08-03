"""
One-command backend startup.

Usage:
    python server.py

Runs, in order:
    1. alembic upgrade head   -- applies any pending database migrations
    2. python -m scripts.seed  -- idempotent bootstrap (permissions, roles,
                                   the super_admin role, the admin user)
    3. uvicorn app.main:app    -- starts the API server

Run this from an ACTIVATED virtual environment, from the `backend/`
directory (the same place you'd normally run `uvicorn` from), e.g.:

    cd backend
    venv\\Scripts\\activate      (Windows)
    source venv/bin/activate    (macOS/Linux)
    python server.py

Configuration (host/port/reload) can be overridden via environment
variables or command-line flags -- see `python server.py --help`.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent


def _run_step(description: str, command: list[str]) -> None:
    """Run one setup step, streaming its output live, and abort on failure."""
    print(f"\n{'=' * 70}\n>>> {description}\n{'=' * 70}")
    result = subprocess.run(command, cwd=BACKEND_DIR)
    if result.returncode != 0:
        print(
            f"\n[server.py] ERROR: step failed ({description!r}, exit code "
            f"{result.returncode}). Aborting startup -- fix the error above and "
            "re-run `python server.py`."
        )
        sys.exit(result.returncode)


def _check_env_file() -> None:
    """Warn (but don't block) if .env is missing -- Settings will fail with a clearer error shortly after."""
    env_path = BACKEND_DIR / ".env"
    if not env_path.exists():
        print(
            "\n[server.py] WARNING: no .env file found at "
            f"{env_path}. If you haven't already, copy .env.example to .env "
            "and fill in your real DATABASE_URL / JWT_SECRET_KEY / etc. "
            "before continuing.\n"
        )


def main() -> None:
    """Parse CLI flags, run migrations + seed, then hand off to uvicorn."""
    parser = argparse.ArgumentParser(description="Run migrations, seed data, then start the API server.")
    parser.add_argument("--host", default="127.0.0.1", help="Host/interface to bind uvicorn to (default: 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind uvicorn to (default: 8000).")
    parser.add_argument(
        "--no-reload", action="store_true", help="Disable uvicorn's auto-reload (default: reload is ON)."
    )
    parser.add_argument(
        "--skip-migrate", action="store_true", help="Skip the 'alembic upgrade head' step."
    )
    parser.add_argument(
        "--skip-seed", action="store_true", help="Skip the 'python -m scripts.seed' step."
    )
    args = parser.parse_args()

    _check_env_file()

    python = sys.executable  # the interpreter currently running this script (i.e. the active venv's python)

    if not args.skip_migrate:
        _run_step("Applying database migrations (alembic upgrade head)", [python, "-m", "alembic", "upgrade", "head"])
    else:
        print("\n[server.py] Skipping migrations (--skip-migrate).")

    if not args.skip_seed:
        _run_step("Seeding bootstrap data (permissions, roles, admin user)", [python, "-m", "scripts.seed"])
    else:
        print("\n[server.py] Skipping seed step (--skip-seed).")

    uvicorn_command = [
        python, "-m", "uvicorn", "app.main:app",
        "--host", args.host,
        "--port", str(args.port),
    ]
    if not args.no_reload:
        uvicorn_command.append("--reload")

    print(f"\n{'=' * 70}\n>>> Starting API server: http://{args.host}:{args.port}\n{'=' * 70}\n")
    # Replaces this process with uvicorn (rather than subprocess.run) so
    # Ctrl+C, reload-triggered restarts, and exit codes all behave exactly
    # as if you'd typed the uvicorn command yourself.
    try:
        import os

        os.chdir(BACKEND_DIR)
        os.execv(python, uvicorn_command)
    except AttributeError:
        # os.execv isn't available on some platforms/terminals (e.g. certain
        # Windows shells) -- fall back to a plain subprocess call.
        result = subprocess.run(uvicorn_command, cwd=BACKEND_DIR)
        sys.exit(result.returncode)


if __name__ == "__main__":
    main()
