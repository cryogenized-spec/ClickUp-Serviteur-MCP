# ClickUp Markdown and rich text — API compatibility matrix

**Research snapshot:** 7 November 2026 (SAST). This matrix covers **documented public REST endpoints and the source implementation**, not every internal block in ClickUp's browser editor. Before posting, verify the refreshed MCP's `service_info.build_sha` against GitHub `main` and inspect the tool catalogue.

**Status definitions:** **API** = published API capability implemented in source; **Test** = needs real ClickUp UI rendering acceptance; **Lossy** = ClickUp documents degradation; **Not documented** = do not assert rendering; **No** = not supported by the API format. Unit-tested outbound JSON does **not** prove exact UI rendering.

| Feature | Task Markdown (`markdown_content`) | List Markdown (`markdown_content`) | Task comment native rich `comment` | Docs v3 `text/md` | Chat v3 `text/md` |
| --- | --- | --- | --- | --- | --- |
| Paragraphs, line breaks | API, Test | API, Test | API, Test | API, Test | API, Test |
| Bold and italic | API, Test | API, Test | API (text attributes), Test | API, Test | API, Test |
| Inline code | API, Test | Test | API (code attribute), Test | API, Test | Test |
| Headings | API, Test | Test | Not documented | API, Test | Test |
| Bullets, ordered lists | API, Test | Test | API (newline list types), Test | API, Test | Test |
| Checked/unchecked lists | Test | Test | API (checked/unchecked), Test | **No** | Test |
| Collapsible toggle lists | Test | Test | API (toggled/none + indent), Test | **No** | Test |
| Hyperlinks | API, Test | Test | API (link attribute), Test | API, Test | Test |
| Blockquotes | API, Test | Test | Not documented | API, Test | Test |
| Fenced code blocks with language | Test | Test | API (newline code-block attribute), Test | **Lossy** | Test |
| Strikethrough | Test | Test | Not documented | API, Test | Test |
| Underline | Test | Test | Not documented | **No** | Test |
| Images | API, Test | Test | Not documented | API with restrictions | Test |
| Tables | Test: native table structure not promised | Test | Not documented | **Lossy** (styling not retained) | Test |
| Horizontal divider | Test | Test | **No native rich divider documented**; explicit Unicode fallback | API, Test | Test |
| Text/background colors and badges | Not documented | Not documented | Not documented | **No** | Test |
| Banners, columns, synced content, advanced embeds | Not documented | Not documented | Not documented | **No** | Test |
| Genuine ClickUp member mention | Separate task assignment | Separate member ownership | API (verified `type:"tag"`), Test | Not documented | Not documented |
| Native emoji | Unicode text | Unicode text | API (`type:"emoticon"`), Test | Unicode text | Unicode text |

### ClickUp's distinct write/read contracts

**Tasks (REST v2)**

- `POST /api/v2/list/{list_id}/task`, `PUT /api/v2/task/{task_id}`: send `markdown_content`, not `description`, when author requests formatted Markdown. Serviteur exposes this as `description_markdown` in task draft/patch and rejects dual plain+Markdown fields.
- Read authorized tasks with `GET /api/v2/task/{task_id}?include_markdown_description=true` so source Markdown is available, subject to an explicit length/truncation report.
- ClickUp documents headers, emphasis, ordered/unordered lists, images/links, blockquotes and inline code. Other syntax should not be claimed visually verified without a test.

**Lists (REST v2)**

- `POST /api/v2/space/{space_id}/list`, `POST /api/v2/folder/{folder_id}/list`, `PUT /api/v2/list/{list_id}`: use `markdown_content` instead of `content`. List updates still require the `name` field.
- Docs for Lists are less specific about every supported Markdown construct; use a disposable UI render test to promote from Test.

**Task comments (REST v2)**

- `POST /api/v2/task/{task_id}/comment` takes `comment_text` for plain content or `comment:[...]` for ordered native rich structures. A literal `---` submitted as a text segment does **not** form a ClickUp divider (#100).
- Structured `rich_segments` compiles to documented `attributes: {bold,italic,code,link,list,code-block,indent}`, `type:"emoticon"` and `type:"tag"`. `list_type` and `code_block_language` attach to a **newline segment**. The `divider:true` variant inserts visibly readable Unicode line text and returns `native_divider:false`, never a false visual-native claim.
- The legacy `text` and `mention_segments` contract is preserved. Rich **editing** is not supported absent documented PUT-equivalent readback behavior. Real mentions must target a verified authorized Workspace member; assignment and notification are separate.

**Docs and Chat (REST v3)**

- Docs pages: `content_format:"text/md"` (or `text/plain`); update also uses `content_edit_mode:"replace"`. See ClickUp's **Docs API limitations**. Markdown export may normalize bracket escapes and lose native-editor-only blocks. Company page replacements remain independently permission gated.
- Chat: v3 `content_format:"text/md"` (default) or `text/plain`. No reason to encode Chat Markdown as v2 comment JSON.

### Acceptance matrix for release

Automated fixtures must cover mixed bold+italic, Unicode, escaping, HTTP(S) and mailto links, list varieties, nested/indented lists, unchecked+checked list states, native code blocks, emojis, actual member tags and malformed inputs. For each *supported* label require (1) request JSON contract, (2) bounded stored-content readback, and (3) **approved sanitized screenshot of real ClickUp UI rendering** in a disposable Workspace. Do not print real customer content, member IDs, short-lived attachment URLs, OAuth secrets or live task descriptions into GitHub logs.

An API 200/201 is **not** enough to declare rendering success. Record lossy/no-support cases and use an explicit approved fallback. One failed readback after a write is an uncertain outcome, never a reason to blindly post twice.

### Official sources

- [ClickUp task Markdown](https://developer.clickup.com/docs/tasks)
- [Create Task](https://developer.clickup.com/reference/createtask), [Update Task](https://developer.clickup.com/reference/updatetask), [Get Task](https://developer.clickup.com/reference/gettask)
- [Create List](https://developer.clickup.com/reference/createlist), [Update List](https://developer.clickup.com/reference/updatelist)
- [Comment formatting](https://developer.clickup.com/docs/comment-formatting), [Create Task Comment](https://developer.clickup.com/reference/createtaskcomment)
- [Create Docs page](https://developer.clickup.com/reference/createpagepublic), [Edit Docs page](https://developer.clickup.com/reference/editpagepublic), [Docs API limitations](https://developer.clickup.com/docs/docsimportexportlimitations)
- [Send Chat message](https://developer.clickup.com/reference/createchatmessage)
- [Formatting feature epic](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/106), [literal divider failure](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/100)
