# Visual capture workflow

Discover a process first with `process:<query>`, then read `window:<PID>` for an allowed application window. Use `display:` or `display:#N` only when display capture is enabled. Add `views: ["image"]` for a still image or `views: ["sequence"]` when motion or timing requires multiple frames.

Tune sequence duration, interval, scale, and region only when defaults do not fit. Region uses normalized `x,y,width,height` and is applied before scaling. For image grids, use `limit` as the square cell size and `offset` as a zero-based row-major cell index. Avoid capturing unrelated desktop content.
