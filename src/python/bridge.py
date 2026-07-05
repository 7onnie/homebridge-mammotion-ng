#!/usr/bin/env python3
"""Persistent JSONL bridge between Homebridge and PyMammotion.

Adapted for pymammotion 0.8.x (verified against 0.8.8).

The external JSON-RPC-over-stdio contract is UNCHANGED from the 0.5.75 bridge so
the (unmodified) Node side keeps working:

  * stdin  : one JSON object per line, ``{"id", "method", "params"}``
  * stdout : one JSON object per line, ``{"id", "ok": true, "data": ...}`` on
             success or ``{"id", "ok": false, "error": "..."}`` on failure.

  methods  : init | list_devices | poll | command | shutdown
  init      params : {email, password, areaNameFallbacks}
  command   params : {name, action}  with action in {start, pause, dock, cancel}

  list_devices -> [{name, iotId, model, serialNumber}]
  poll/command -> [{name, online, battery, chargeState, sysStatus, modeName,
                    areaProgress, hasError, serviceAreas, selectedAreaIds,
                    currentAreaId}]

What changed internally for 0.8.x (see the notes shipped with this file):
  * Entry point is now ``pymammotion.client.MammotionClient`` (the old
    ``pymammotion.mammotion.devices.mammotion.Mammotion`` no longer exists).
  * Devices are enumerated through ``client.device_registry.all_devices``,
    which yields ``DeviceHandle`` objects (``.device_name``, ``.iot_id``,
    ``.snapshot``).  The underlying ``MowerDevice`` (== the old ``MowingDevice``)
    is ``handle.snapshot.raw``.
  * ``start_schedule_sync`` was renamed to ``start_plan_sync``.
  * The App-Version / pymammotion issue #137 workaround is applied by
    constructing ``MammotionClient(ha_version="3.4.22")`` so the HTTP
    ``App-Version`` header becomes ``HA,2.3.4.22``.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from pymammotion.client import MammotionClient
from pymammotion.const import APP_VERSION
from pymammotion.utility.constant.device_constant import WorkMode, device_mode

# pymammotion issue #137 App-Version gate.
#
# MammotionHTTP builds its header as f"HA,2.{ha_version}" (http.py:168). The
# Mammotion backend rejects stale app versions (e.g. HA,2.3.4.22) and the
# "NOT HA,"/"ALIYUN DEMO," prefixes with {"code":200,"msg":"Access denied"},
# but accepts the "HA,2." prefix with a *current* app version. pymammotion's
# bundled APP_VERSION (e.g. "2.3.8.19") tracks the current app, so derive
# ha_version from it (strip the leading "2.") -> header "HA,2.3.8.19", and it
# auto-follows future pymammotion APP_VERSION bumps. If Access-denied recurs,
# set the APP_VERSION env var or hardcode a newer value here.
HA_VERSION = APP_VERSION.split(".", 1)[1] if APP_VERSION.startswith("2.") else "3.8.19"


class Bridge:
    def __init__(self) -> None:
        # ha_version is forwarded to MammotionHTTP via login_and_initiate_cloud,
        # producing the App-Version: HA,2.3.4.22 header (issue #137 fix).
        self.mammotion = MammotionClient(ha_version=HA_VERSION)
        self.email: str | None = None
        self.password: str | None = None
        self.default_plan: str | None = None
        self.area_name_fallbacks: dict[str, list[str]] = {}
        self._area_id_map: dict[str, dict[int, int]] = {}
        self._next_area_refresh_at: dict[str, float] = {}
        self._next_plan_refresh_at: dict[str, float] = {}

    async def handle(self, method: str, params: dict[str, Any]) -> Any:
        if method == "init":
            return await self._init(params)
        if method == "list_devices":
            return await self._list_devices()
        if method == "poll":
            return await self._poll()
        if method == "command":
            return await self._command(params)
        if method == "shutdown":
            await self.mammotion.stop()
            return {"shutdown": True}
        raise ValueError(f"Unknown method: {method}")

    async def _init(self, params: dict[str, Any]) -> dict[str, bool]:
        email = str(params.get("email", "")).strip()
        password = str(params.get("password", "")).strip()
        if not email or not password:
            raise ValueError("Missing email or password")

        self.email = email
        self.password = password
        raw_fallbacks = params.get("areaNameFallbacks", {})
        parsed_fallbacks: dict[str, list[str]] = {}
        if isinstance(raw_fallbacks, dict):
            for key, value in raw_fallbacks.items():
                if not isinstance(key, str):
                    continue
                if not isinstance(value, list):
                    continue
                names = [str(item).strip() for item in value if str(item).strip()]
                if names:
                    parsed_fallbacks[key] = names
        self.area_name_fallbacks = parsed_fallbacks
        default_plan = str(params.get("defaultPlan", "")).strip()
        self.default_plan = default_plan or None
        await self.mammotion.login_and_initiate_cloud(email, password)
        return {"ready": True}

    # ------------------------------------------------------------------
    # Device access helpers (0.8.x device-registry / DeviceHandle based)
    # ------------------------------------------------------------------

    def _handles(self) -> list[Any]:
        """Return all registered DeviceHandle objects."""
        return list(self.mammotion.device_registry.all_devices)

    def _handle_by_name(self, name: str) -> Any:
        """Return the DeviceHandle for *name* or raise (mirrors old get_device_by_name semantics)."""
        handle = self.mammotion.device_registry.get_by_name(name)
        if handle is None:
            raise ValueError(f"Device '{name}' not registered")
        return handle

    @staticmethod
    def _resolve_plan_id(state, prefer_name=None):
        """state.map.plan is dict[plan_id -> Plan]. Return (plan_id, label) for
        the named plan, else the first; (None, None) if none stored."""
        plans = dict(getattr(getattr(state, "map", None), "plan", {}) or {})
        if not plans:
            return (None, None)
        items = list(plans.items())
        if prefer_name:
            for pid, plan in items:
                tn = str(getattr(plan, "task_name", "")).strip()
                jn = str(getattr(plan, "job_name", "")).strip()
                if prefer_name in (tn, jn):
                    return (str(getattr(plan, "plan_id", "") or pid), tn or jn)
        pid, plan = items[0]
        label = str(getattr(plan, "task_name", "")).strip() or str(getattr(plan, "job_name", "")).strip()
        return (str(getattr(plan, "plan_id", "") or pid), label)

    @staticmethod
    def _plans_list(state) -> list[dict[str, str]]:
        """[{id, name}] for each saved plan, de-duplicated by name, name-sorted.
        Consumed by the Node side to expose one 'Run <plan>' switch per plan."""
        plans = dict(getattr(getattr(state, "map", None), "plan", {}) or {})
        out: list[dict[str, str]] = []
        seen: set[str] = set()
        for pid, plan in plans.items():
            plan_id = str(getattr(plan, "plan_id", "") or pid)
            name = str(getattr(plan, "task_name", "")).strip() or str(getattr(plan, "job_name", "")).strip()
            if not name or not plan_id:
                continue
            key = name.casefold()
            if key in seen:
                continue
            seen.add(key)
            out.append({"id": plan_id, "name": name})
        out.sort(key=lambda item: item["name"].casefold())
        return out

    @staticmethod
    def _raw_state(handle: Any) -> Any:
        """Return the underlying MowerDevice (== old MowingDevice) for a handle."""
        return handle.snapshot.raw

    @staticmethod
    def _is_online(handle: Any) -> bool:
        """Best-effort online flag from the immutable snapshot."""
        try:
            return bool(handle.snapshot.online)
        except Exception:
            # Fall back to the raw device's static online flag if the snapshot
            # API ever changes shape.
            return bool(getattr(handle.snapshot.raw, "online", False))

    async def _list_devices(self) -> list[dict[str, Any]]:
        nick_by_name = self._nick_names()
        devices = []
        for handle in self._handles():
            name = handle.device_name
            serial = name.split("-", 1)[-1] if "-" in name else name
            state = self._raw_state(handle)
            model = state.mower_state.model or state.mower_state.product_key
            devices.append(
                {
                    "name": name,
                    "iotId": handle.iot_id,
                    "model": model,
                    "serialNumber": serial,
                    "nickName": nick_by_name.get(name),
                }
            )

        devices.sort(key=lambda item: item["name"])
        return devices

    def _nick_names(self) -> dict[str, str]:
        """Map device_name -> user-assigned nickName from the cloud device
        lists. Populated only for accounts that expose one (e.g. the Aliyun
        binding); empty on the Mammotion-direct path."""
        nicks: dict[str, str] = {}
        for attr in ("aliyun_device_list", "mammotion_device_list"):
            for dev in (getattr(self.mammotion, attr, None) or []):
                device_name = getattr(dev, "device_name", None)
                nick = getattr(dev, "nick_name", None)
                if device_name and nick and device_name not in nicks:
                    nicks[device_name] = str(nick)
        return nicks

    async def _poll(self) -> list[dict[str, Any]]:
        states = []
        now = asyncio.get_running_loop().time()
        for handle in self._handles():
            device_name = handle.device_name
            state = self._raw_state(handle)
            # handle.snapshot is a LIVE view; freshness is driven by pymammotion's
            # own mqtt_activity_loop (cadence tuned via MAMMOTION_POLL_*_SECS env
            # vars, set by the Node side). We just read the live snapshot here.
            # The old per-poll RPT_START/count=0 request was a BLE-only continuous
            # stream and a no-op over cloud MQTT — it never fetched a report, which
            # is what caused externally-started mows to take ~15 min to appear.

            map_area_names = list(getattr(state.map, "area_name", []) or [])
            map_areas = dict(getattr(state.map, "area", {}) or {})
            map_plans = dict(getattr(state.map, "plan", {}) or {})

            if now >= self._next_area_refresh_at.get(device_name, 0):
                try:
                    # Keep requesting map + names until map metadata is hydrated.
                    await self.mammotion.start_map_sync(device_name)
                except Exception as ex:
                    self._debug(f"{device_name}: start_map_sync failed: {ex}")
                try:
                    await self._send_command(device_name, "get_all_boundary_hash_list", sub_cmd=0)
                except Exception as ex:
                    self._debug(f"{device_name}: get_all_boundary_hash_list failed: {ex}")
                try:
                    await self._send_command(device_name, "get_area_name_list", device_id=handle.iot_id)
                except Exception as ex:
                    self._debug(f"{device_name}: get_area_name_list failed: {ex}")

                # Retry quickly while no area metadata is available, otherwise back off.
                if len(map_areas) == 0 and len(map_area_names) == 0:
                    self._next_area_refresh_at[device_name] = now + 20.0
                else:
                    self._next_area_refresh_at[device_name] = now + 120.0

            if now >= self._next_plan_refresh_at.get(device_name, 0):
                try:
                    # 0.8.x: start_schedule_sync was renamed to start_plan_sync.
                    await self.mammotion.start_plan_sync(device_name)
                except Exception as ex:
                    self._debug(f"{device_name}: start_plan_sync failed: {ex}")

                if len(map_plans) == 0:
                    self._next_plan_refresh_at[device_name] = now + 20.0
                else:
                    self._next_plan_refresh_at[device_name] = now + 300.0

            plan_names = []
            for plan in map_plans.values():
                task_name = str(getattr(plan, "task_name", "")).strip()
                job_name = str(getattr(plan, "job_name", "")).strip()
                if task_name or job_name:
                    plan_names.append(task_name or job_name)

            fallback_names = self._configured_area_names(device_name)
            _dev = state.report_data.dev
            _ss = int(getattr(_dev, "sys_status", 0) or 0)
            self._debug(
                f"{device_name}: sys={_ss}({self._mode_name(_ss)}) charge={int(getattr(_dev, 'charge_state', 0) or 0)} "
                f"map areas={len(map_areas)} area_names={len(map_area_names)} "
                f"zone_hashs={len(list(getattr(getattr(state, 'work', None), 'zone_hashs', []) or []))} "
                f"plans={len(map_plans)} plan_names={plan_names} fallback_names={fallback_names}"
            )

            states.append(self._to_state(device_name, handle))

        states.sort(key=lambda item: item["name"])
        return states

    async def _command(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        action = str(params.get("action", "")).strip()
        if not name or not action:
            raise ValueError("Missing name or action")

        handle = self._handle_by_name(name)
        state = self._raw_state(handle)
        mode = state.report_data.dev.sys_status
        charge_state = state.report_data.dev.charge_state

        if action == "start":
            await self._start(name, mode)
        elif action == "start_plan":
            plan_id = str(params.get("planId", "")).strip()
            if not plan_id:
                raise ValueError("Missing planId for start_plan")
            await self._start_plan(name, plan_id, mode)
        elif action == "pause":
            await self._pause(name, mode)
        elif action == "dock":
            await self._dock(name, mode, charge_state)
        elif action == "cancel":
            await self._cancel(name, mode)
        else:
            raise ValueError(f"Unsupported action: {action}")

        await self._request_iot_sync(name)
        # Give device/state handlers a brief moment to apply updates.
        await asyncio.sleep(0.15)
        return self._to_state(name, self._handle_by_name(name))

    async def _send_command(self, name: str, command: str, **kwargs: Any) -> None:
        await self.mammotion.send_command_with_args(name, command, **kwargs)

    async def _start(self, name: str, mode: int | None) -> None:
        if mode == WorkMode.MODE_WORKING:
            return
        if mode == WorkMode.MODE_PAUSE:
            await self._send_command(name, "resume_execute_task")
            return
        # Idle / docked / returning: a bare start_job is a no-op (no task loaded).
        # Execute the saved plan via single_schedule, like the official app.
        if mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")
        plan_state = self._raw_state(self._handle_by_name(name))
        plan_id, _label = self._resolve_plan_id(plan_state, prefer_name=self.default_plan)
        if plan_id:
            await self._send_command(name, "single_schedule", plan_id=plan_id)
            return
        # No saved plan: query_generate_route_information + start_job only starts a
        # degenerate empty task (live-verified 2026-07-04 — instant "100%" completion,
        # never enters MODE_WORKING), so surface a clear message instead of twitching
        # the mower out and back.
        raise ValueError(
            f"No saved plan for {name}. Create a mowing task in the Mammotion app first."
        )

    async def _start_plan(self, name: str, plan_id: str, mode: int | None) -> None:
        """Run one specific saved plan (backs the per-plan 'Run <plan>' switches)."""
        if mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")
        await self._send_command(name, "single_schedule", plan_id=plan_id)

    async def _pause(self, name: str, mode: int | None) -> None:
        if mode == WorkMode.MODE_WORKING:
            await self._send_command(name, "pause_execute_task")
        elif mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")

    async def _dock(self, name: str, mode: int | None, charge_state: int | None) -> None:
        if charge_state != 0:
            return

        if mode == WorkMode.MODE_WORKING:
            await self._send_command(name, "pause_execute_task")

        if mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")

        await self._send_command(name, "return_to_dock")

    async def _cancel(self, name: str, mode: int | None) -> dict:
        partial = {"cancelled": False, "docked": False, "dock_error": None}
        if mode == WorkMode.MODE_WORKING:
            await self._send_command(name, "pause_execute_task")
            await self._request_iot_sync(name)
        await self._send_command(name, "cancel_job")
        partial["cancelled"] = True
        # Re-read fresh state AFTER cancel to decide whether to send the mower home.
        await self._request_iot_sync(name)
        dev = self._raw_state(self._handle_by_name(name)).report_data.dev
        if int(getattr(dev, "charge_state", 0) or 0) == 0 and dev.sys_status != WorkMode.MODE_RETURNING:
            try:
                await self._send_command(name, "return_to_dock")
                partial["docked"] = True
            except Exception as ex:  # mower stopped but dock failed -> report, don't raise
                partial["dock_error"] = repr(ex)
        return partial

    async def _request_iot_sync(self, name: str) -> None:
        # One-shot count=1 report via pymammotion's own helper. The old
        # RptAct.RPT_START/count=0 was a BLE-only continuous stream and a no-op
        # over cloud MQTT (it never produced a report). request_report_snapshot
        # fires the correct count=1 poll (fire-and-forget: the report lands
        # asynchronously and updates the live snapshot). Used after user commands
        # to nudge a fresh reading; steady-state cadence is the mqtt_activity_loop.
        await self.mammotion.request_report_snapshot(name)

    def _to_state(self, device_name: str, handle: Any) -> dict[str, Any]:
        state = self._raw_state(handle)
        dev = state.report_data.dev
        work = state.report_data.work
        battery = int(getattr(dev, "battery_val", 0) or 0)
        charge_state = int(getattr(dev, "charge_state", 0) or 0)
        sys_status = int(getattr(dev, "sys_status", 0) or 0)
        mode_name = self._mode_name(sys_status)
        service_areas, selected_areas, current_area = self._service_area_state(device_name, state)

        progress = int((getattr(work, "area", 0) or 0) >> 16)

        # Mow completion % (clamped 0-100 via the library's mow_percent property).
        try:
            mow_percent = int(getattr(work, "mow_percent", progress) or 0)
        except Exception:
            mow_percent = progress
        mow_percent = max(0, min(100, mow_percent))

        # Blade wear: used-time >= warning threshold (warn==0 => unknown/disabled).
        try:
            blade = getattr(getattr(state.report_data, "maintenance", None), "blade_used_time", None)
            blade_used = int(getattr(blade, "blade_used_time", 0) or 0)
            blade_warn = int(getattr(blade, "blade_used_warn_time", 0) or 0)
            blade_worn = blade_warn > 0 and blade_used >= blade_warn
        except Exception:
            blade_worn = False

        # Obstacle/sensor fault: bumper or any ultrasonic sensor in ERROR (>=2).
        sensor_fault = False
        for attr in ("bumper_state", "ult_left", "ult_left_front", "ult_right_front", "ult_right"):
            try:
                if int(getattr(dev, attr, 0) or 0) >= 2:
                    sensor_fault = True
                    break
            except Exception:
                pass

        return {
            "name": state.name,
            "online": self._is_online(handle),
            "battery": battery,
            "chargeState": charge_state,
            "sysStatus": sys_status,
            "modeName": mode_name,
            "areaProgress": progress,
            "hasError": mode_name == "MODE_LOCK",
            "serviceAreas": service_areas,
            "selectedAreaIds": selected_areas,
            "currentAreaId": current_area,
            "plans": self._plans_list(state),
            "mowPercent": mow_percent,
            "bladeWorn": blade_worn,
            "sensorFault": sensor_fault,
        }

    def _service_area_state(self, device_name: str, state: Any) -> tuple[list[dict[str, Any]], list[int], int | None]:
        map_data = getattr(state, "map", None)
        if map_data is None:
            return ([{"id": 0, "name": "All Areas"}], [0], None)

        area_name_items = list(getattr(map_data, "area_name", []) or [])
        area_dict = dict(getattr(map_data, "area", {}) or {})

        name_by_hash: dict[int, str] = {}
        for item in area_name_items:
            try:
                hash_id = int(getattr(item, "hash"))
            except Exception:
                continue

            name = str(getattr(item, "name", "")).strip()
            if name:
                name_by_hash[hash_id] = name

        all_hashes: set[int] = set(name_by_hash.keys())
        for hash_id in area_dict.keys():
            try:
                all_hashes.add(int(hash_id))
            except Exception:
                continue

        if len(all_hashes) == 0:
            # Fallback for accounts where cloud map hash sync does not hydrate area hashes.
            # Use scheduled plan tasks as selectable service areas so Home can still expose
            # meaningful room/area names from the Mammotion app.
            plan_by_id = dict(getattr(map_data, "plan", {}) or {})
            plan_names: list[str] = []
            for plan in plan_by_id.values():
                task_name = str(getattr(plan, "task_name", "")).strip()
                job_name = str(getattr(plan, "job_name", "")).strip()
                label = task_name or job_name
                if label:
                    plan_names.append(label)

            # Keep deterministic order and de-duplicate case-insensitively.
            seen: set[str] = set()
            unique_names: list[str] = []
            for name in sorted(plan_names, key=lambda item: item.casefold()):
                key = name.casefold()
                if key in seen:
                    continue
                seen.add(key)
                unique_names.append(name)

            if len(unique_names) > 0:
                service_areas = [{"id": idx + 1, "name": name} for idx, name in enumerate(unique_names)]
                selected = [area["id"] for area in service_areas]
                return (service_areas, selected, None)

            fallback_names = self._configured_area_names(device_name)
            if len(fallback_names) > 0:
                service_areas = [{"id": idx + 1, "name": name} for idx, name in enumerate(fallback_names)]
                selected = [area["id"] for area in service_areas]
                return (service_areas, selected, None)

            return ([{"id": 0, "name": "All Areas"}], [0], None)

        id_map = self._area_id_map.setdefault(device_name, {})
        for hash_id in list(id_map.keys()):
            if hash_id not in all_hashes:
                id_map.pop(hash_id, None)

        next_id = max(id_map.values(), default=0) + 1
        for hash_id in sorted(all_hashes):
            if hash_id not in id_map:
                id_map[hash_id] = next_id
                next_id += 1

        sorted_hashes = sorted(all_hashes, key=lambda hash_id: (name_by_hash.get(hash_id, f"Area {id_map[hash_id]}"), hash_id))
        service_areas = [
            {
                "id": id_map[hash_id],
                "name": name_by_hash.get(hash_id, f"Area {id_map[hash_id]}"),
            }
            for hash_id in sorted_hashes
        ]

        zone_hashes = list(getattr(getattr(state, "work", None), "zone_hashs", []) or [])
        selected_areas = []
        for hash_id in zone_hashes:
            try:
                selected_area_id = id_map.get(int(hash_id))
            except Exception:
                selected_area_id = None

            if selected_area_id is not None:
                selected_areas.append(selected_area_id)

        if len(selected_areas) == 0:
            selected_areas = [area["id"] for area in service_areas]

        current_area = None
        try:
            current_zone_hash = int(getattr(getattr(state, "location", None), "work_zone", 0) or 0)
            if current_zone_hash in id_map:
                current_area = id_map[current_zone_hash]
        except Exception:
            current_area = None

        return (service_areas, selected_areas, current_area)

    @staticmethod
    def _mode_name(value: int) -> str:
        mode = device_mode(value)
        if mode == "Invalid mode":
            return f"UNKNOWN_{value}"
        return mode

    def _configured_area_names(self, device_name: str) -> list[str]:
        names = self.area_name_fallbacks.get(device_name)
        if names and len(names) > 0:
            return names

        names = self.area_name_fallbacks.get("*")
        if names and len(names) > 0:
            return names

        return []

    @staticmethod
    def _debug(message: str) -> None:
        print(message, file=sys.stderr, flush=True)


async def main() -> None:
    bridge = Bridge()

    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break

        line = line.strip()
        if not line:
            continue

        # Initialise request_id BEFORE the try so a malformed/partial payload
        # (json.loads raising before request_id is assigned) still produces a
        # well-formed error response the Node side can correlate (or drop).
        request_id = None
        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            method = payload.get("method")
            params = payload.get("params") or {}
            if not isinstance(params, dict):
                raise ValueError("params must be an object")

            data = await bridge.handle(method, params)
            response = {"id": request_id, "ok": True, "data": data}
        except Exception as exc:
            response = {
                "id": request_id,
                "ok": False,
                "error": str(exc),
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
