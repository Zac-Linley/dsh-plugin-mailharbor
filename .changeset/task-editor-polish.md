---
'@zaclinley/dsh-mailharbor': minor
---

Task editor polish, editable extraction, and faster mail reading.

- The task editor is rebuilt: a four-way status switch, a due-date picker with
  今天/明天/本周五/下周一 shortcuts, colour-coded priority, a "这个事联系谁"
  field, a jump to the source mail, and delete in the editor.
- Extracted tasks are editable before saving (title, due, priority, contact).
- Message bodies are cached (client + host) and prefetched on row hover, so
  revisiting a mail is instant; the reader shows a loading state while fetching.
- AI actions show a spinner and elapsed seconds (rail generation, AI search,
  composer rewrite) instead of a silent wait.
