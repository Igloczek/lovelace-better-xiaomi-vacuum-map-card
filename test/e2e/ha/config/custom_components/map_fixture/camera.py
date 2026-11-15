"""Camera platform that exposes the synthetic map plus the room metadata the card reads."""

from __future__ import annotations

from typing import Any

from homeassistant.components.camera import Camera
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DATA_CAMERAS, DATA_NAMED_CAMERAS, DEFAULT_CAMERAS, DOMAIN, FIXTURE_MAP_ROOMS, FIXTURE_ROOMS


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the fixture cameras the `map_fixture:` key names, default first."""
    cameras = entry.data.get("cameras") or DEFAULT_CAMERAS
    entities = []
    for camera in cameras:
        map_key = camera.get("map_key", "default")
        entity = MapFixtureCamera(name=camera.get("name", "Vacuum Map"), map_key=map_key)
        entities.append(entity)
        # The default camera is the one `map_fixture.bump` and `map_fixture.set_rooms` drive. A named
        # fixture map keeps its committed image and metadata, so a re-map in one spec cannot
        # renumber the rooms another spec asserts on.
        if map_key == "default":
            hass.data.setdefault(DATA_CAMERAS, {}).setdefault(DOMAIN, []).append(entity)
        else:
            hass.data.setdefault(DATA_NAMED_CAMERAS, []).append(entity)
    async_add_entities(entities)


class MapFixtureCamera(Camera):
    """A camera whose picture is served by an HTTP view so every request is counted."""

    _attr_should_poll = False

    def __init__(self, name: str, map_key: str = "default") -> None:
        super().__init__()
        self._attr_name = name
        self._attr_unique_id = "map_fixture_camera" if map_key == "default" else f"map_fixture_camera_{map_key}"
        self._map_key = map_key
        self._version = 1
        self._rooms = FIXTURE_MAP_ROOMS.get(map_key, FIXTURE_ROOMS)

    @property
    def rooms(self) -> dict[str, Any]:
        """The metadata this camera publishes, for a service that bumps it."""
        return self._rooms

    def set_rooms(self, rooms: dict[str, Any]) -> None:
        """Simulate a re-map that renumbers the segments."""
        self._rooms = rooms
        self._version += 1
        self.async_write_ha_state()

    def bump(self) -> None:
        """Simulate the integration pushing a new map image."""
        self._version += 1
        self.async_write_ha_state()

    @property
    def entity_picture(self) -> str:
        # The card appends its own cache-buster. A new version here is what a new map looks like to
        # the card: the picture attribute changes and the camera state gets a new last_updated.
        # A named fixture map is served from the same counting view, told which map to send.
        source = "" if self._map_key == "default" else f"&map={self._map_key}"
        return f"/api/map_fixture/image?v={self._version}{source}"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "rooms": self._rooms,
            "last_update_timestamp": self._version,
            "access_token": "fixture-token",
        }

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        return None
