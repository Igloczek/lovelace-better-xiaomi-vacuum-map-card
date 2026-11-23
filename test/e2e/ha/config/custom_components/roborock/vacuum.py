"""The fake Roborock vacuum: the shared fake vacuum with core Roborock's segment ids.

Core Roborock reports `Segment(id=f"{map_flag}_{room.segment_id}", group=map_info.name)` for every
map. Map 0 is the apartment the `camera.apartment_map` camera shows; map 1 numbers its rooms from
the same start, so bare ids `10` and `18` exist on both floors and only the current-map select
tells them apart.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.vacuum import Segment
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from ..map_fixture import DATA_VACUUMS, FIXTURE_MAP_ROOMS
from ..map_fixture.vacuum import FakeVacuum
from . import device_info

UPPER_FLOOR = {"10": {"name": "Strych"}, "18": {"name": "Pracownia"}}


def maps() -> dict[str, tuple[str, dict[str, dict[str, Any]]]]:
    """Map flag -> (map name, rooms), as core Roborock's `home_map_info`."""
    return {"0": ("Erdgeschoss", FIXTURE_MAP_ROOMS["apartment"]), "1": ("Obergeschoss", UPPER_FLOOR)}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    entity = FakeRoborock(hass)
    hass.data.setdefault(DATA_VACUUMS, []).append(entity)
    async_add_entities([entity])


class FakeRoborock(FakeVacuum):
    """Records the segment ids Home Assistant resolved from `vacuum.clean_area`, map flags included."""

    _attr_device_info = device_info()

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(hass, name="Fake Roborock")
        self._attr_unique_id = "fake_roborock_vacuum"

    async def async_get_segments(self) -> list[Segment]:
        return [
            Segment(id=f"{flag}_{room_id}", name=room.get("name") or f"Room {room_id}", group=name)
            for flag, (name, rooms) in maps().items()
            for room_id, room in rooms.items()
        ]

    async def async_clean_segments(self, segment_ids: list[str], **kwargs: Any) -> None:
        self._check_fail()
        self._commands.append([str(segment) for segment in segment_ids])
        self.async_write_ha_state()
