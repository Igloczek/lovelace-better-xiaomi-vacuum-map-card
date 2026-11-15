"""Config flow for the end-to-end fixture.

There is nothing to ask: the `map_fixture:` YAML key is imported into one config entry, because
Home Assistant only attaches a device to an entity that belongs to a config entry.
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from . import DOMAIN


class MapFixtureConfigFlow(ConfigFlow, domain=DOMAIN):
    """A single fixture entry, created from YAML."""

    VERSION = 1

    async def async_step_import(self, import_info: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Create the one entry the fixture needs."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title="Map fixture", data=dict(import_info or {}))
