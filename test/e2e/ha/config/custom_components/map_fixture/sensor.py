"""A consumable sensor on the fake vacuum's device, for the end-to-end registry spec.

The card's generated tiles are built from the registry entries of the entities that belong to the
vacuum's device, and a tile template without a fixed icon takes the icon from that registry entry.
This sensor gives the fixture such an entry: its `unique_id` matches the Xiaomi Miio template's
`filter_left` sensor, so the generated tile exists, and `rename-registry.spec.ts` can change its
registry icon and see the tile follow without a reload.

It exists only for `test/e2e`; it is never part of the released card.
"""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import fixture_device_info


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the fake vacuum's consumable sensor."""
    async_add_entities([FakeConsumableSensor()])


class FakeConsumableSensor(SensorEntity):
    """A filter-left sensor, named so it reads as one of the vacuum's own sensors."""

    _attr_should_poll = False
    _attr_has_entity_name = False
    _attr_device_info = fixture_device_info()
    _attr_name = "Fake Vacuum Filter"
    # The trailing part is ignored: the card's Xiaomi Miio template matches the prefix.
    _attr_unique_id = "consumable_filter_left_e2e"
    _attr_native_unit_of_measurement = "h"
    _attr_native_value = 100
