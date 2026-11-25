"""A controllable camera and fake vacuum fixture for the end-to-end suite.

The camera serves a committed PNG through this integration's own HTTP view, so every image load the
card performs is counted. A service bumps the entity picture and the state object, which is what a
real camera does when it has a new map, and the counter proves how often the card actually asks for
one.

The entities come from a config entry (created from the `map_fixture:` YAML key through an import
flow) rather than from YAML platforms, because Home Assistant only attaches a device to an entity
that belongs to a config entry. The card resolves the vacuum's sibling sensors through the vacuum's
registry `device_id`, and the generated tile icons come from those registry entries, so the fixture
needs a real device.

This component exists only for `test/e2e`; it is never part of the released card.
"""

from __future__ import annotations

import json
import os
from typing import Any

import voluptuous as vol
from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry, SOURCE_IMPORT
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.typing import ConfigType

DOMAIN = "map_fixture"
DATA_COUNTS = "map_fixture_counts"
DATA_IMAGE = "map_fixture_image"
DATA_CAMERAS = "map_fixture_entities"
DATA_NAMED_CAMERAS = "map_fixture_named_entities"
DATA_VACUUMS = "map_fixture_vacuums"

PLATFORMS = [Platform.CAMERA, Platform.SENSOR, Platform.VACUUM]

DEFAULT_IMAGE = "/config/map_fixture.png"

CONFIG_SCHEMA = vol.Schema({DOMAIN: vol.Any(None, dict)}, extra=vol.ALLOW_EXTRA)

# The fake vacuum's device. The card resolves the vacuum's sibling entities through its registry
# `device_id`, and the generated tiles take their icon from the sibling's registry entry, so the
# consumable sensor (`sensor.py`) has to belong to the same device.
DEVICE_NAME = "Fake Vacuum"
DEVICE_IDENTIFIERS = {(DOMAIN, "map_fixture_fake_vacuum")}


def fixture_device_info() -> dict[str, Any]:
    """Device info shared by every entity of the fake vacuum."""
    return {
        "identifiers": DEVICE_IDENTIFIERS,
        "name": DEVICE_NAME,
        "manufacturer": "Map Fixture",
        "model": "Fake robot",
    }


# The default camera, used when the `map_fixture:` key names none. A camera config may name its
# camera and pick a named map; the named maps keep a fixed image and fixed room metadata, so a
# re-map in one spec cannot renumber another spec's rooms.
DEFAULT_CAMERAS = [{"name": "Vacuum Map", "map_key": "default"}]

# The synthetic fixture map, in vacuum coordinates. The committed PNG is 200x150 and the card's
# calibration maps 1 image pixel to 10 vacuum units, so these rectangles match the coloured blobs.
FIXTURE_ROOMS: dict[str, dict[str, Any]] = {
    "0": {"x0": 200, "y0": 200, "x1": 800, "y1": 700, "name": "Kitchen"},
    "1": {"x0": 1000, "y0": 200, "x1": 1700, "y1": 700, "name": "Living room"},
    "2": {"x0": 200, "y0": 900, "x1": 800, "y1": 1300, "name": "Bedroom"},
}

# Two same-coloured L-shaped rooms around a hallway (test/fixtures/synthetic/interlock.png). Their
# bounding boxes overlap, so the pixels alone do not say which fill is which room. Only the bounds
# are published here: that is what Xiaomi Cloud Map Extractor and Dreame report, and the harder
# case for the card. 1 image pixel is 10 vacuum units, and the rectangles are the rooms' bounds.
INTERLOCK_ROOMS: dict[str, dict[str, Any]] = {
    "kitchen": {"x0": 100, "y0": 100, "x1": 1100, "y1": 1100, "name": "Kitchen"},
    "hall": {"x0": 420, "y0": 100, "x1": 1900, "y1": 1100, "name": "Hall"},
}

# A re-map that keeps the geometry but renumbers the segments, which is what makes a configured
# selection stale without looking different on the map.
SHIFTED_ROOMS: dict[str, dict[str, Any]] = {
    "7": {"x0": 200, "y0": 200, "x1": 800, "y1": 700, "name": "Kitchen"},
    "8": {"x0": 1000, "y0": 200, "x1": 1700, "y1": 700, "name": "Living room"},
    "9": {"x0": 200, "y0": 900, "x1": 800, "y1": 1300, "name": "Bedroom"},
}

# A realistic floor plan (test/fixtures/apartment/): rooms sharing walls, irregular shapes, long and
# Polish names. Generated with its metadata, which the generator writes next to the image.
APARTMENT_ROOMS_FILE = "/config/map_apartment_rooms.json"


# The same flat as a Valetudo map camera (sca075's MQTT Vacuum Camera) publishes it: each room's own
# convex-hull outline in Valetudo units, no bounds (issue #77, valetudo-room-outlines.spec.ts).
APARTMENT_VALETUDO_ROOMS_FILE = "/config/map_apartment_valetudo_rooms.json"


def _apartment_rooms(file: str = APARTMENT_ROOMS_FILE) -> dict[str, dict[str, Any]]:
    try:
        with open(file, encoding="utf-8") as handle:
            return json.load(handle)
    except OSError:
        return {}


FIXTURE_IMAGES: dict[str, str] = {
    "default": DEFAULT_IMAGE,
    "interlock": "/config/map_interlock.png",
    "apartment": "/config/map_apartment.png",
    "apartment_valetudo": "/config/map_apartment.png",
}
FIXTURE_MAP_ROOMS: dict[str, dict[str, dict[str, Any]]] = {
    "interlock": INTERLOCK_ROOMS,
    "apartment": _apartment_rooms(),
    "apartment_valetudo": _apartment_rooms(APARTMENT_VALETUDO_ROOMS_FILE),
}

# The replacement image the interlock camera serves, for the path-cut piece spec.
INTERLOCK_PATH_IMAGE = "/config/map_interlock_path.png"


class MapFixtureImageView(HomeAssistantView):
    """Serves the fixture map and counts each request."""

    url = "/api/map_fixture/image"
    name = "api:map_fixture:image"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.Response:
        counts: dict[str, int] = self.hass.data.setdefault(DATA_COUNTS, {})
        token = request.query.get("v", "default")
        counts[token] = counts.get(token, 0) + 1
        counts["total"] = counts.get("total", 0) + 1
        # The default map is the one set_image swaps (the stale-rooms spec needs a re-mapped image);
        # a named fixture map always serves its own committed file, or its path variant.
        map_key = request.query.get("map", "default")
        if map_key == "default":
            path = self.hass.data.get(DATA_IMAGE, DEFAULT_IMAGE)
        elif map_key == "interlock" and self.hass.data.get("map_fixture_interlock_path"):
            path = INTERLOCK_PATH_IMAGE
        else:
            path = FIXTURE_IMAGES.get(map_key, "")
        if not path or not os.path.exists(path):
            return web.Response(status=404, text=f"missing fixture image: {path}")
        with open(path, "rb") as handle:
            body = handle.read()
        return web.Response(body=body, content_type="image/png", headers={"Cache-Control": "no-store"})


class MapFixtureStatsView(HomeAssistantView):
    """Reads and resets the request counter."""

    url = "/api/map_fixture/stats"
    name = "api:map_fixture:stats"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.Response:
        return web.json_response(self.hass.data.setdefault(DATA_COUNTS, {}))

    async def post(self, request: web.Request) -> web.Response:
        self.hass.data[DATA_COUNTS] = {}
        return web.json_response({"reset": True})


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the views and the services, and import the YAML key into a config entry."""
    hass.data.setdefault(DATA_IMAGE, DEFAULT_IMAGE)
    hass.http.register_view(MapFixtureImageView(hass))
    hass.http.register_view(MapFixtureStatsView(hass))

    async def bump(call: ServiceCall) -> None:
        for entities in hass.data.get(DATA_CAMERAS, {}).values():
            for entity in entities:
                entity.bump()

    hass.services.async_register(DOMAIN, "bump", bump)

    async def set_image(call: ServiceCall) -> None:
        hass.data[DATA_IMAGE] = call.data.get("path", DEFAULT_IMAGE)

    hass.services.async_register(DOMAIN, "set_image", set_image)

    async def interlock_path(call: ServiceCall) -> None:
        """Serve the interlock plan with the cleaning path, or the plain one again."""
        hass.data["map_fixture_interlock_path"] = bool(call.data.get("on", True))
        for entity in hass.data.get(DATA_NAMED_CAMERAS, []):
            entity.bump()

    hass.services.async_register(DOMAIN, "interlock_path", interlock_path)

    async def set_rooms(call: ServiceCall) -> None:
        """Swap the room metadata between the original ids and a re-mapped set."""
        shift = call.data.get("mode", "shift") == "shift"
        rooms = SHIFTED_ROOMS if shift else FIXTURE_ROOMS
        for entities in hass.data.get(DATA_CAMERAS, {}).values():
            for entity in entities:
                entity.set_rooms(rooms)

    hass.services.async_register(DOMAIN, "set_rooms", set_rooms)

    async def vacuum_configure(call: ServiceCall) -> None:
        """Set the fake vacuum's lag, timings, next-call failure and availability."""
        for entity in hass.data.get(DATA_VACUUMS, []):
            entity.configure(dict(call.data))

    hass.services.async_register(DOMAIN, "vacuum_configure", vacuum_configure)

    async def vacuum_reset(call: ServiceCall) -> None:
        """Put the fake vacuum into a state at once, reported without lag."""
        for entity in hass.data.get(DATA_VACUUMS, []):
            entity.reset(call.data.get("activity", "docked"))

    hass.services.async_register(DOMAIN, "vacuum_reset", vacuum_reset)

    if DOMAIN in config:
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN,
                context={"source": SOURCE_IMPORT},
                data=config.get(DOMAIN) or {},
            )
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the fixture's camera, vacuum and sensor."""
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the fixture's platforms."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
