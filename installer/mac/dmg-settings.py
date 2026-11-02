# dmgbuild settings for Pluck.dmg. Made by Matte Black.
# Used by build.sh:  dmgbuild -s dmg-settings.py -D app=... -D background=... -D icon=... Pluck Pluck.dmg
import os.path

app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)
appname = os.path.basename(app)

files = [app]
symlinks = {"Applications": "/Applications"}
icon = defines.get("icon")  # noqa: F821
background = defines.get("background")  # noqa: F821

format = "ULMO"
window_rect = ((200, 140), (660, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
arrange_by = None
icon_size = 112
text_size = 13
icon_locations = {appname: (180, 200), "Applications": (480, 200)}
hide_extensions = [appname]
