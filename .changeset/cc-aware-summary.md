---
'@zaclinley/dsh-mailharbor': patch
---

Stop suggesting a reply to mail you were only copied on.

- The summary prompt now receives your role (直接收件人 / 仅抄送 / 发件人 / 不在名单)
  and is told to skip reply suggestions unless you are a direct recipient.
- For non-recipients the host also removes a reply-suggestion section the model
  still writes, so summaries stay deterministic.
- The summary card hides "用这些要点回复" and shows "未建议回复" in that case.
