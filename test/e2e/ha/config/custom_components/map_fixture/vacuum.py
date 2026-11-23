"""A fake vacuum that misbehaves the way real integrations and robots do.

It exists only for `test/e2e` and is never part of the released card. Each behaviour is one that a
real setup showed and that the card has to survive:

- State is reported late (`lag` seconds, ~30 s on a polling integration such as xiaomi_miot): the
  state Home Assistant shows is a snapshot of what the robot did `lag` seconds ago.
- A multi-room command is cleaned in the robot's own order (sorted ids), not the order sent, like
  the Viomi V8 with `set_mode_withroom`. `cleaned_rooms` records the real order.
- A command sent while the robot heads home is ignored.
- After a job the robot returns and docks.
- `fail_next` makes the next command raise, like a device that does not answer.
- `available: false` makes the entity unavailable, like a polling integration losing the device.
- It reports its segments and cleans them through Home Assistant's `vacuum.clean_area`, which maps
  each area to the segments the user assigned it (issue #120). A segment clean is recorded in
  `commands` like a room command.
- Every `poll_seconds` it rewrites the state object with a new `polled` attribute and the same
  activity, like a polling integration whose battery or area attribute changed: `last_updated`
  moves, `last_changed` does not.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.components.vacuum import Segment, StateVacuumEntity, VacuumActivity, VacuumEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_call_later, async_track_time_interval

from . import DATA_VACUUMS, FIXTURE_ROOMS, fixture_device_info

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the fake vacuum."""
    entity = FakeVacuum(hass, name="Fake Vacuum")
    hass.data.setdefault(DATA_VACUUMS, []).append(entity)
    async_add_entities([entity])


class FakeVacuum(StateVacuumEntity):
    """The robot's true activity runs on timers; Home Assistant sees it `lag` seconds late."""

    _attr_should_poll = False
    _attr_has_entity_name = False
    _attr_device_info = fixture_device_info()
    _attr_supported_features = (
        VacuumEntityFeature.START
        | VacuumEntityFeature.PAUSE
        | VacuumEntityFeature.STOP
        | VacuumEntityFeature.RETURN_HOME
        | VacuumEntityFeature.SEND_COMMAND
        | VacuumEntityFeature.STATE
        | VacuumEntityFeature.CLEAN_AREA
    )

    def __init__(self, hass: HomeAssistant, name: str) -> None:
        self.hass = hass
        self._attr_name = name
        self._attr_unique_id = "map_fixture_fake_vacuum"
        self.lag = 0.0
        self.room_seconds = 4.0
        self.return_seconds = 3.0
        self.fail_next = False
        self._true_activity = VacuumActivity.DOCKED
        self._job: list[str] = []
        self._cleaned: list[str] = []
        self._current_room: str | None = None
        self._job_timer: Any = None
        self._reported: dict[str, Any] = self._snapshot()
        self._available = True
        self._sequence = 0
        self._polled = 0
        self.poll_seconds = 2.0
        self._poll_unsub: Any = None
        # Every room command the robot received, including an empty one: a spec can then tell "the
        # card sent nothing" from "the card sent an empty room list", which look identical in
        # `job_rooms` because a robot handed no rooms starts and stops at once.
        self._commands: list[list[str]] = []
        # The Viomi zone protocol (set_uploadmap, set_zone, set_mode), as the robot parses it: every
        # command in arrival order, and the zones `set_zone` gave, each as its four corners.
        self._viomi_commands: list[list[Any]] = []
        self._viomi_zones: list[list[float]] = []

    async def async_added_to_hass(self) -> None:
        self._start_polling()

    async def async_will_remove_from_hass(self) -> None:
        if self._poll_unsub is not None:
            self._poll_unsub()

    def _start_polling(self) -> None:
        if self._poll_unsub is not None:
            self._poll_unsub()
            self._poll_unsub = None
        if self.poll_seconds > 0:
            self._poll_unsub = async_track_time_interval(
                self.hass, self._poll, timedelta(seconds=self.poll_seconds)
            )

    @callback
    def _poll(self, _now: Any = None) -> None:
        """An attribute-only update: same reported activity, new attribute value."""
        self._polled += 1
        self.async_write_ha_state()

    # Configuration from the `map_fixture.vacuum_configure` service.
    def configure(self, data: dict[str, Any]) -> None:
        for key in ("lag", "room_seconds", "return_seconds"):
            if key in data:
                setattr(self, key, float(data[key]))
        if "poll_seconds" in data:
            self.poll_seconds = float(data["poll_seconds"])
            self._start_polling()
        if "fail_next" in data:
            self.fail_next = bool(data["fail_next"])
        if "available" in data:
            self._available = bool(data["available"])
            self.async_write_ha_state()

    def reset(self, activity: str = "docked") -> None:
        """Put robot and reported state into `activity` at once, for a clean test start."""
        self._cancel_job()
        self._job, self._cleaned, self._current_room = [], [], None
        self._commands = []
        self._viomi_commands, self._viomi_zones = [], []
        self._true_activity = VacuumActivity(activity)
        self._reported = self._snapshot()
        self._available = True
        self.fail_next = False
        self.async_write_ha_state()

    @property
    def available(self) -> bool:
        return self._available

    @property
    def activity(self) -> VacuumActivity | None:
        return self._reported["activity"]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attributes = {key: value for key, value in self._reported.items() if key != "activity"}
        attributes["polled"] = self._polled
        attributes["commands"] = [list(command) for command in self._commands]
        attributes["viomi_commands"] = [list(command) for command in self._viomi_commands]
        attributes["viomi_zones"] = [list(zone) for zone in self._viomi_zones]
        return attributes

    def _snapshot(self) -> dict[str, Any]:
        return {
            "activity": self._true_activity,
            "current_room": self._current_room,
            "cleaned_rooms": list(self._cleaned),
            "job_rooms": list(self._job),
        }

    @callback
    def _changed(self) -> None:
        """The robot changed; Home Assistant learns about it `lag` seconds later."""
        snapshot = self._snapshot()
        self._sequence += 1

        @callback
        def publish(_now: Any = None) -> None:
            self._reported = snapshot
            self.async_write_ha_state()

        if self.lag <= 0:
            publish()
        else:
            async_call_later(self.hass, self.lag, publish)

    def _cancel_job(self) -> None:
        if self._job_timer is not None:
            self._job_timer()
            self._job_timer = None

    @callback
    def _schedule(self, seconds: float, step: Any) -> None:
        self._cancel_job()
        self._job_timer = async_call_later(self.hass, seconds, step)

    @callback
    def _start_job(self, rooms: list[str]) -> None:
        # The robot plans its own route: it cleans the rooms in id order, whatever order was sent.
        self._job = sorted(rooms, key=lambda room: (len(room), room))
        self._cleaned = []
        self._current_room = None
        self._next_room()

    @callback
    def _next_room(self, _now: Any = None) -> None:
        remaining = [room for room in self._job if room not in self._cleaned]
        if self._current_room is not None and self._current_room not in self._cleaned:
            self._cleaned.append(self._current_room)
            remaining = [room for room in self._job if room not in self._cleaned]
        if not remaining:
            self._current_room = None
            self._true_activity = VacuumActivity.RETURNING
            self._changed()
            self._schedule(self.return_seconds, self._dock)
            return
        self._current_room = remaining[0]
        self._true_activity = VacuumActivity.CLEANING
        self._changed()
        self._schedule(self.room_seconds, self._next_room)

    @callback
    def _dock(self, _now: Any = None) -> None:
        self._job_timer = None
        self._true_activity = VacuumActivity.DOCKED
        self._changed()

    def _check_fail(self) -> None:
        if self.fail_next:
            self.fail_next = False
            raise HomeAssistantError("Fake vacuum did not answer")

    def _viomi_command(self, command: str, params: Any) -> None:
        """
        A Viomi V8 zone clean, as the robot takes it: `set_zone` is `[count, "i_0_x1_y1_..._x4_y4",
        ...]` (python-miio raw command; tykarol's `async_clean_area` and Valetudo's
        ViomiZoneCleaningCapability build the same strings), then `set_mode [3, 1]` starts the zones.
        A malformed zone is an error, as it would be a zone the robot misreads.
        """
        if not isinstance(params, list):
            raise HomeAssistantError(f"{command}: params must be a list, got {params!r}")
        if command == "set_zone":
            count, entries = params[0], params[1:]
            if not isinstance(count, int) or count != len(entries):
                raise HomeAssistantError(f"set_zone: count {count!r} does not match {len(entries)} zones")
            zones = []
            for index, entry in enumerate(entries):
                fields = str(entry).split("_")
                if len(fields) != 10 or fields[0] != str(index) or fields[1] != "0":
                    raise HomeAssistantError(f"set_zone: malformed zone {entry!r}")
                zones.append([float(value) for value in fields[2:]])
            self._viomi_zones = zones
        if command == "set_mode" and params == [3, 1]:
            if not self._viomi_zones:
                raise HomeAssistantError("set_mode [3, 1] without zones")
            self._true_activity = VacuumActivity.CLEANING
            self._changed()
            self._schedule(self.room_seconds, self._next_room)
        self._viomi_commands.append([command, params])
        self.async_write_ha_state()

    async def async_get_segments(self) -> list[Segment]:
        """The fixture map's rooms, which Home Assistant's area mapping assigns to areas."""
        return [Segment(id=room_id, name=room["name"]) for room_id, room in FIXTURE_ROOMS.items()]

    async def async_clean_segments(self, segment_ids: list[str], **kwargs: Any) -> None:
        """`vacuum.clean_area`, after Home Assistant resolved the areas to these segments."""
        self._check_fail()
        if self._true_activity == VacuumActivity.RETURNING:
            _LOGGER.info("fake vacuum ignores a segment clean while returning")
            return
        rooms = [str(room) for room in segment_ids]
        self._commands.append(rooms)
        self._start_job([room for room in rooms if room in FIXTURE_ROOMS])

    async def async_send_command(self, command: str, params: Any = None, **kwargs: Any) -> None:
        self._check_fail()
        if command in ("set_uploadmap", "set_zone", "set_mode"):
            self._viomi_command(command, params)
            return
        if command not in ("app_segment_clean", "clean_rooms"):
            raise HomeAssistantError(f"Unknown command: {command}")
        if self._true_activity == VacuumActivity.RETURNING:
            _LOGGER.info("fake vacuum ignores %s while returning", command)
            return
        rooms = params if isinstance(params, list) else [params]
        self._commands.append([str(room) for room in rooms])
        self._start_job([str(room) for room in rooms if str(room) in FIXTURE_ROOMS])

    async def async_start(self) -> None:
        self._check_fail()
        if self._true_activity == VacuumActivity.RETURNING:
            return
        if self._true_activity == VacuumActivity.PAUSED and self._job:
            self._true_activity = VacuumActivity.CLEANING
            self._changed()
            self._schedule(self.room_seconds, self._next_room)
            return
        self._start_job(list(FIXTURE_ROOMS))

    async def async_pause(self) -> None:
        self._check_fail()
        if self._true_activity == VacuumActivity.CLEANING:
            self._cancel_job()
            self._true_activity = VacuumActivity.PAUSED
            self._changed()

    async def async_stop(self, **kwargs: Any) -> None:
        self._check_fail()
        self._cancel_job()
        self._job, self._current_room = [], None
        self._true_activity = VacuumActivity.IDLE
        self._changed()

    async def async_return_to_base(self, **kwargs: Any) -> None:
        self._check_fail()
        self._job, self._current_room = [], None
        self._true_activity = VacuumActivity.RETURNING
        self._changed()
        self._schedule(self.return_seconds, self._dock)
