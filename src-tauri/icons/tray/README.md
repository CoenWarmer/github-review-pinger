# Tray icons

`tray.svg` is the source, drawn on an 18×18 grid (the macOS menu bar size).

| File | Used on | Rendering |
| --- | --- | --- |
| `tray-template@2x.png` | macOS | 36×36, black on transparent; marked as a template so macOS tints it for light and dark menu bars |
| `tray-white.png` | Windows, Linux | 32×32, white on transparent, for the default dark taskbar and panel |

To regenerate, rasterize `tray.svg` with a browser engine (ImageMagick's
built-in SVG renderer anti-aliases poorly) at those sizes, replacing the
stroke color for the white variant.
