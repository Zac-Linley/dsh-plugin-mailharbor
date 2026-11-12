---
'@zaclinley/dsh-mailharbor': minor
---

Virtualized conversation list.

- The grouped list renders only the visible window (plus a 600px overscan)
  once there are more than 30 groups, using cumulative height estimates and
  top/bottom spacers.
- Scrolling near the bottom loads the next 40 messages automatically while
  preserving the scroll position; the manual 加载更多 button remains.
- Expanded conversations are measured into the virtual height so they do not
  overlap the following groups.
