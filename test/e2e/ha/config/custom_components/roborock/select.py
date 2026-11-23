"""Core Roborock's current-map select (`translation_key: selected_map`), on the vacuum's device."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import device_info
from .vacuum import maps


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([SelectedMap()])


class SelectedMap(SelectEntity):
    _attr_translation_key = "selected_map"
    _attr_has_entity_name = False
    _attr_name = "Fake Roborock Selected map"
    _attr_unique_id = "fake_roborock_selected_map"
    _attr_device_info = device_info()

    def __init__(self) -> None:
        self._attr_options = [name for name, _ in maps().values()]
        self._attr_current_option = self._attr_options[0]

    async def async_select_option(self, option: str) -> None:
        self._attr_current_option = option
        self.async_write_ha_state()
