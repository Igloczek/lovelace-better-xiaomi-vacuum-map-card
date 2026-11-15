"""Camera platform that exposes the synthetic map plus the room metadata the card reads."""

from __future__ import annotations

from typing import Any

from homeassistant.components.camera import Camera
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DATA_CAMERAS, DOMAIN, FIXTURE_ROOMS


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the fixture camera."""
    entity = MapFixtureCamera(name="Vacuum Map")
    hass.data.setdefault(DATA_CAMERAS, {}).setdefault(DOMAIN, []).append(entity)
    async_add_entities([entity])


class MapFixtureCamera(Camera):
    """A camera whose picture is served by an HTTP view so every request is counted."""

    _attr_should_poll = False

    def __init__(self, name: str) -> None:
        super().__init__()
        self._attr_name = name
        self._attr_unique_id = "map_fixture_camera"
        self._version = 1
        self._rooms = FIXTURE_ROOMS

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
        return f"/api/map_fixture/image?v={self._version}"

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
