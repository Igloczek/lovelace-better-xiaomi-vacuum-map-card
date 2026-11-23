"""A fake core Roborock vacuum for the end-to-end suite (issue #120, area outlines).

The card joins Home Assistant's area mapping to the map camera per vacuum integration, keyed by the
vacuum's registry `platform`. Core Roborock is the confirmed join: its segment ids carry the map
flag (`0_16`) while the map camera keys its rooms by the bare segment id (`16`), and its
`selected_map` select names the map the vacuum is on. To prove that join against a real Home
Assistant, this custom component takes the `roborock` domain (Home Assistant loads a custom
integration in place of a built-in one with the same domain), so the vacuum's registry entry says
`platform: roborock` exactly as a real one does. Everything else is the shared fake vacuum.

It exists only for `test/e2e`; it is never part of the released card.
"""

from __future__ import annotations

import voluptuous as vol

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

DOMAIN = "roborock"
PLATFORMS = [Platform.SELECT, Platform.VACUUM]
CONFIG_SCHEMA = vol.Schema({DOMAIN: vol.Any(None, dict)}, extra=vol.ALLOW_EXTRA)


def device_info() -> dict:
    """The device both entities belong to: the card finds the select through the vacuum's device."""
    return {
        "identifiers": {(DOMAIN, "fake_roborock")},
        "name": "Fake Roborock",
        "manufacturer": "Map Fixture",
        "model": "roborock.vacuum.e2e",
    }


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    if DOMAIN in config:
        hass.async_create_task(
            hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_IMPORT}, data={})
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
