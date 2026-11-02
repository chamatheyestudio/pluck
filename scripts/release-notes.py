"""Prints the release page text for the version in app/version.json."""
import json
import os

v = json.load(open(os.path.join(os.path.dirname(__file__), "..", "app", "version.json")))
lines = ["## What's new", ""] + [f"- {n}" for n in v.get("notes", [])] + [
    "",
    "## Get Pluck",
    "",
    "**Mac:** download **Pluck.dmg**, open it and drag Pluck into Applications. The first time you open it, macOS asks you to confirm: "
    "open System Settings, go to Privacy & Security, scroll down and click **Open Anyway**.",
    "",
    "**Windows:** download **Pluck-Setup.exe** and run it. If Windows says it protected your PC, click **More info**, then **Run anyway**.",
    "",
    "Already have Pluck? It updates itself. Nothing to do.",
    "",
    "Free, always. Made by Matte Black.",
]
print("\n".join(lines))
