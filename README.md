# @cynosure-mcp/computer-controller

MCP server for desktop automation — launch apps, capture screenshots, control mouse and keyboard. Supports multi-monitor setups and Gemini-optimized screenshot scaling.

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

| Tool                    | Description                                   |
| ----------------------- | --------------------------------------------- |
| `list_applications`     | Index and search installed applications       |
| `launch_application`    | Launch an application by name                 |
| `get_screenshot`        | Capture the desktop (multi-monitor support)   |
| `get_cursor_area`       | 512×512 screenshot centered on the cursor     |
| `move_mouse`            | Move cursor to a position                     |
| `click_mouse`           | Click at current or specified position        |
| `double_click`          | Double-click at current or specified position |
| `drag_mouse`            | Click-and-drag between positions              |
| `scroll_mouse`          | Scroll the mouse wheel                        |
| `get_mouse_position`    | Get current cursor location                   |
| `type_text`             | Insert text at cursor                         |
| `press_key_combination` | Press key combo (e.g., `ctrl+c`)              |
| `get_screen_size`       | Get display dimensions                        |
| `get_system_details`    | OS, CPU, memory, and disk info                |
| `wait`                  | Pause for 1–10 seconds                        |

## Configuration

| Variable        | Required | Description                                                                                            |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `DISPLAY_INDEX` | No       | Restrict to a specific monitor. `0` or unset = all displays; `1` = primary; `2` = second display; etc. |
| `GEMINI_MODE`   | No       | Set to `true` to scale screenshots to fit within 1000×1000 for Gemini models                           |

### Screenshot Scaling

Screenshots are automatically scaled to fit within model-friendly dimensions.
In standard mode (optimized for Claude Sonnet) the output is downscaled to one of 1024×768, 1280×800, or 1280×720 depending on screen aspect ratio.

When `GEMINI_MODE` is enabled, all screenshots are scaled to fit within a 1000×1000 bounding box (maintaining aspect ratio) and bottom-padded with black to exactly 1000×1000. Content always starts at coordinate (0, 0).

| Resolution | Scale Factor | Content Area | Bottom Padding |
| ---------- | ------------ | ------------ | -------------- |
| 1920×1080  | 0.5208       | 1000×563     | 437px          |
| 2560×1440  | 0.3906       | 1000×563     | 437px          |
| 3840×2160  | 0.2604       | 1000×563     | 437px          |
| 1920×1200  | 0.5208       | 1000×625     | 375px          |

## MCP Config

```json
{
  "mcpServers": {
    "computer-controller": {
      "command": "npx",
      "args": ["@cynosure-mcp/computer-controller"],
      "env": {
        "GEMINI_MODE": "true"
      }
    }
  }
}
```

## License

MIT
