# @cynosure-mcp/computer-controller

MCP server for desktop automation — launch apps, capture screenshots, control mouse and keyboard. Screenshot and input coordinates use the same display geometry, including multi-monitor offsets.

## Installation

```bash
npx @cynosure-mcp/computer-controller
```

Or install globally:

```bash
npm install -g @cynosure-mcp/computer-controller
computer-controller
```

## Tools

| Tool                     | Description                                   |
| ------------------------ | --------------------------------------------- |
| `list_applications`      | Index and search installed applications       |
| `launch_application`     | Launch an application by name                 |
| `get_screenshot`         | Capture the desktop (multi-monitor support)   |
| `get_cursor_area`        | 512×512 screenshot centered on the cursor     |
| `move_mouse`             | Move cursor to a position                     |
| `click_mouse`            | Click at current or specified position        |
| `double_click`           | Double-click at current or specified position |
| `drag_mouse`             | Click-and-drag between positions              |
| `scroll_mouse`           | Scroll the mouse wheel                        |
| `get_mouse_position`     | Get current cursor location                   |
| `type_text`              | Insert text at cursor                         |
| `press_key_combination`  | Press key combo (e.g., `ctrl+c`)              |
| `control_media_playback` | Control media (play/pause/stop/next/previous) |
| `control_volume`         | Control volume (up/down/mute)                 |
| `get_screen_size`        | Get display dimensions                        |
| `get_system_details`     | OS, CPU, memory, and disk info                |
| `wait`                   | Pause for 1–10 seconds                        |

The server also exposes the MCP resource `computer-controller://guide` with its computer-use workflow and coordinate rules. Resource inclusion is controlled by the MCP host; read it explicitly if the host does not add it to the model context.

### Screenshot coordinates

Call `get_screenshot` first. Its text result contains the actual image dimensions and the selected display. Coordinates are zero-based pixels in **that image**. If you captured `display: 0`, pass `display: 0` to mouse tools. If you omitted `display` to capture the full desktop, omit it on mouse tools too. Screenshot and mouse tools independently compute the same mapping from the current display geometry and `WIDTH`/`HEIGHT` limits; no token or global "current display" setting is needed.

**Version 2 migration:** `GEMINI_MODE` and `sys_prompt_template.txt` were removed; use `WIDTH`/`HEIGHT` and the guide resource. Without size limits, screenshots use native capture dimensions. Mouse tools accept an optional `display` number.

Omitting `display` captures the full desktop. `display: 0` selects the primary monitor, `display: 1` the next monitor. A failed monitor capture returns an error; it never returns a different monitor or the full desktop as a successful result. Capture backends are checked against their expected pixel dimensions. On macOS, multi-monitor capture currently fails closed until a geometry-aware backend is available.

## Configuration

| Variable        | Required | Description                                                                                            |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `DISPLAY_INDEX` | No | Restrict screenshots to a monitor: `0` or unset = all displays; `1` = primary; `2` = second display. |
| `WIDTH` | No | Maximum screenshot width in pixels (1–16384). |
| `HEIGHT` | No | Maximum screenshot height in pixels (1–16384). |

### Screenshot scaling

`WIDTH` and `HEIGHT` bound the image sent to the model. Set either or both. The image keeps its aspect ratio, is never enlarged or padded, and may be smaller than both limits. With neither set, screenshots stay at native capture size. These variables do not change the operating system's display resolution. The image dimensions reported by `get_screenshot` are the coordinate bounds.

## MCP Config

```json
{
  "mcpServers": {
    "computer-controller": {
      "command": "npx",
      "args": ["@cynosure-mcp/computer-controller"],
      "env": {
        "WIDTH": "1000",
        "HEIGHT": "1000"
      }
    }
  }
}
```

## License

MIT
