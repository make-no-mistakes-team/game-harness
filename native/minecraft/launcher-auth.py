#!/usr/bin/python3
"""Read only the selected official Launcher's account-bound bearer from Secret Service.

Stdout is a PRIVATE supervisor pipe containing credentials. Never run interactively,
log it, or persist it. The caller verifies each candidate against the official profile
endpoint and the selected installed licensed profile before launching anything.
"""
import json
import pathlib
import re
import sys


def main():
    source = pathlib.Path(sys.argv[1])
    accounts = json.loads((source / "launcher_accounts.json").read_text())
    active = accounts.get("activeAccountLocalId")
    records = accounts.get("accounts", {})
    selected = records.get(active)
    if not isinstance(selected, dict):
        raise RuntimeError("Official Launcher account unavailable")
    candidates = []
    token = selected.get("accessToken")
    if token:
        candidates.append(token)
    local_id = selected.get("localId")
    if not candidates and local_id:
        import dbus
        import os
        bus = dbus.bus.BusConnection(f"unix:path=/run/user/{os.getuid()}/bus")
        service = dbus.Interface(bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets"), "org.freedesktop.Secret.Service")
        _, session = service.OpenSession("plain", dbus.String("", variant_level=1))
        try:
            service_props = dbus.Interface(bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets"), "org.freedesktop.DBus.Properties")
            for collection in service_props.Get("org.freedesktop.Secret.Service", "Collections"):
                props = dbus.Interface(bus.get_object("org.freedesktop.secrets", collection), "org.freedesktop.DBus.Properties")
                for item_path in props.Get("org.freedesktop.Secret.Collection", "Items"):
                    obj = bus.get_object("org.freedesktop.secrets", item_path)
                    item_props = dbus.Interface(obj, "org.freedesktop.DBus.Properties")
                    attributes = item_props.Get("org.freedesktop.Secret.Item", "Attributes")
                    token_key = str(attributes.get("tokenkey", ""))
                    # The official Launcher uses the local account id as its token key.
                    # Do not read unrelated apps' credentials or unlock a locked keyring.
                    if local_id != token_key or item_props.Get("org.freedesktop.Secret.Item", "Locked"):
                        continue
                    secret = bytes(dbus.Interface(obj, "org.freedesktop.Secret.Item").GetSecret(session)[2])
                    if len(secret) > 32768:
                        continue
                    for match in re.finditer(rb"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", secret):
                        candidate = match.group().decode("ascii")
                        if candidate not in candidates:
                            candidates.append(candidate)
        finally:
            dbus.Interface(bus.get_object("org.freedesktop.secrets", session), "org.freedesktop.Secret.Session").Close()
    if not candidates:
        raise RuntimeError("Official Launcher bearer unavailable")
    print(json.dumps({"tokens": candidates[:8], "profile": selected["minecraftProfile"]}))


try:
    main()
except Exception:
    # No stack, cache keys, account identities or credential contents on failure.
    sys.stderr.write("Official Launcher credential access unavailable.\n")
    sys.exit(1)
