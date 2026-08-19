"""
Channel Naming + Subscription Permission Registry.

A "channel" is just a string name (e.g. ``"module:buyers"``,
``"user:3f2c...")`` that a WebSocket connection can subscribe to; see
:mod:`app.events.manager` for how subscriptions/broadcasts actually work.
This module owns:

1. The naming helpers (:func:`module_channel`, :func:`user_channel`, ...)
   so every caller builds the exact same channel string instead of
   hand-typing ``f"module:{x}"`` in a dozen places.
2. :data:`MODULE_CHANNEL_PERMISSIONS`, a data-driven map from a
   module channel to the REST permission code required to subscribe to
   it (Phase 1 brief section 7: "design the WebSocket/channel
   architecture so permissions can be checked before allowing a user to
   subscribe"). Adding a future module's live channel means adding ONE
   entry here -- nothing in :mod:`app.events.manager` or
   :mod:`app.events.routes` needs to change.

Deliberately reuses the SAME permission codes already seeded by
``scripts/seed.py`` (e.g. ``"buyer.view"``) rather than inventing a
parallel "can subscribe to live updates" permission -- per the brief's
"Use the existing permission system. Do not duplicate the permission
engine."

Phase 9: expanded to cover all current ERP modules that now publish live
events (Suppliers, Products, Inquiries, and the master-data modules
Brands/Categories/Sub-Categories/Countries/States/Cities/Currencies/UoM/
HSN). Buyers and Planning were already registered in Phase 1/2.
"""

from __future__ import annotations

import uuid

# --- Channel naming helpers -------------------------------------------------


def module_channel(module: str) -> str:
    """Build the channel name for a whole module's live updates, e.g. ``"module:buyers"``."""
    return f"module:{module}"


def user_channel(user_id: uuid.UUID | str) -> str:
    """Build the channel name for one user's private notifications, e.g. ``"user:<uuid>"``."""
    return f"user:{user_id}"


def entity_channel(entity: str, entity_id: uuid.UUID | str) -> str:
    """
    Build the channel name for ONE specific record, e.g. ``"buyer:982"``.

    Not in the Phase 1 brief's own channel list, but a natural extension
    of the same naming scheme (module-wide vs. one-record) that a future
    "I'm viewing this exact buyer's detail page" subscription can use
    without broadcasting every buyer's changes to every viewer -- included
    now since it costs nothing to define alongside the others and avoids
    a later inconsistent naming choice.
    """
    return f"{entity}:{entity_id}"


NOTIFICATIONS_CHANNEL = "notifications"
"""
Global, permission-less channel any authenticated user may subscribe to
(personal reminders, system announcements, ...) -- listed explicitly in
the Phase 1 brief's channel examples. Not module-scoped, so it has no
entry in :data:`MODULE_CHANNEL_PERMISSIONS` below (see
:func:`permission_required_for_channel`).
"""


# --- Channel -> permission registry ----------------------------------------

# Maps a module channel name to the permission code required to subscribe
# to it. Only modules that actually have a real, seeded permission code
# today are listed -- see `backend/scripts/seed.py` for the source of
# truth on which permission codes exist.
#
# Phase 9 additions (all newly wired to a real backend publisher in this
# phase -- see app.suppliers.routes, app.masters.products.routes,
# app.inquiries.routes, and each app.masters.<module>.routes):
#   - module:products        -> product.view      (Product Gallery alias)
#   - module:brands          -> brand.view
#   - module:categories      -> category.view
#   - module:subcategories   -> subcategory.view
#   - module:countries       -> country.read
#   - module:states          -> state.read
#   - module:cities          -> city.read
#   - module:currencies      -> currency.read
#   - module:uom             -> uom.read
#   - module:hsn             -> hsn.read
MODULE_CHANNEL_PERMISSIONS: dict[str, str] = {
    # --- Core transactional modules (buyers/planning: Phase 1/2; suppliers/inquiries: Phase 9) ---
    module_channel("buyers"):        "buyer.view",
    module_channel("suppliers"):     "supplier.view",
    module_channel("planning"):      "planning.read",
    module_channel("inquiries"):     "inquiry.read",
    # --- Product catalog ---
    module_channel("inventory"):     "product.view",   # Product Master (entity="product")
    module_channel("products"):      "product.view",   # Product Gallery alias
    # --- Master data (Phase 9) ---
    module_channel("brands"):        "brand.view",
    module_channel("categories"):    "category.view",
    module_channel("subcategories"): "subcategory.view",
    module_channel("countries"):     "country.read",
    module_channel("states"):        "state.read",
    module_channel("cities"):        "city.read",
    module_channel("currencies"):    "currency.read",
    module_channel("uom"):           "uom.read",
    module_channel("hsn"):           "hsn.read",
}


def permission_required_for_channel(channel: str) -> str | None:
    """
    Return the permission code required to subscribe to ``channel``, or
    ``None`` if the channel needs no special permission.

    Three cases, in order:

    1. ``channel`` is in :data:`MODULE_CHANNEL_PERMISSIONS` -> that
       permission is required.
    2. ``channel`` is :data:`NOTIFICATIONS_CHANNEL`, or a ``"user:{id}"``
       channel -> no module permission is needed (the caller -- see
       ``app.events.manager.ConnectionManager.subscribe`` -- separately
       enforces that a ``"user:{id}"`` channel's ``{id}`` must equal the
       connection's own authenticated user id, which is a stronger check
       than any permission code could express).
    3. Anything else (including a bare ``"buyer:982"`` entity channel, or
       an unrecognized channel name) -> permission-less by default, since
       Phase 1 does not yet define per-record permission rules; module
       integration phases can tighten this per channel type without
       needing to change this function's signature.
    """
    return MODULE_CHANNEL_PERMISSIONS.get(channel)


def is_user_channel(channel: str, user_id: uuid.UUID) -> bool:
    """True if ``channel`` is exactly this user's own private channel."""
    return channel == user_channel(user_id)


def is_any_user_channel(channel: str) -> bool:
    """True if ``channel`` looks like a `user:{id}` channel for ANY user (used to reject subscribing to someone else's)."""
    return channel.startswith("user:")