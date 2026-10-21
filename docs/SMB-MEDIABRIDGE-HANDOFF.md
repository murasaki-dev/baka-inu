# MediaBridge handoff: complete Baka-Inu source-change inventory

Compared on **2026-10-21**, through Baka-Inu Home Assistant version **0.1.62**.
Follow-up changes after that fingerprinted snapshot are documented below.

## Scope and evidence

This document expands the original SMB handoff into an inventory of every
surviving difference in the bundled MediaBridge source, plus the supporting
Baka-Inu integration needed to port those differences correctly.

The comparison is between:

- **Standalone baseline:** `C:/Users/Administrator/Documents/mediabridge`, clean
  Git worktree at commit `fc147de68b223a6d3c45a104c1614398805628be`, dated
  2026-10-19, subject `fixed some hyperlink parsin issues`.
- **Bundled implementation:** `C:/Users/Administrator/Documents/inu/mediabridge-src`.
- **Home Assistant mirror:** `homeassistant/baka_inu/mediabridge-src`.

| Compared file | Added lines | Removed lines | Diff hunks |
| --- | ---: | ---: | ---: |
| `main.rs` | 350 | 72 | 45 |
| `web/index.html` | 13 | 21 | 7 |
| `Cargo.toml` | 0 | 0 | 0 |
| `Cargo.lock` | 0 | 0 | 0 |

Line-ending whitespace is ignored. No Rust dependencies were added or upgraded
relative to this standalone baseline. Exact patches and SHA-256 fingerprints:

- [Rust source diff](mediabridge-comparison/main.rs.diff)
- [Bundled dashboard diff](mediabridge-comparison/web-index.html.diff)
- [Comparison manifest and complete hunk index](mediabridge-comparison/comparison.json)

These are a snapshot, not a promise that the two projects will remain unchanged.
Baka-Inu's source is untracked in its current Git worktree, so an exact chronology
of every intermediate edit or reverted experiment cannot be reconstructed from
its Git history. The patches cover every current source difference; the sections
below also identify superseded approaches discussed during development. Features
already in the standalone baseline are not incorrectly claimed as new work.

## Porting overview

| Area | Port into standalone MediaBridge? | Main symbols |
| --- | --- | --- |
| Codec selection and resolution defaults | Review the default-policy change first | `PlaybackPreferences`, `ytdl_format_selector` |
| Queue/history metadata and failures | Yes | `QueueItem`, `QueueItemStatus`, `Status`, `drain_metadata` |
| Background cookie inheritance | Yes | `add_youtube_lookup_cookies` |
| Background lookup deadline | Yes | `run_cancellable_command` |
| Mix extraction, candidate fallback, retries | Yes, with integration verification | `expand_youtube_mix_cancellable`, autoplay functions |
| Queue-preserving additions and replay | Yes | `enqueue_explicit_item`, `handle` |
| Submitter attribution | Optional generic field; identity must come from the caller's access layer | `queued_by_user_id` |
| Hardware decode selection/reporting | Yes | `start_url`, `media_status` |
| Linux sign-in diagnostics | Yes | `open_librewolf_sign_in` |
| Authenticated SMB playback | Port the mechanism; adapt its credential provider | `smb_authenticated_playback_url` |
| Room permissions, web dialogs, SMB browsing UI | Baka-Inu integration; not Rust player core | `server.mjs`, `public/`, `smb-*.mjs` |

## 1. Playback defaults, codec selection, and the bundled dashboard

### Rust configuration changes

- Add `default_video_codec: String` to `Config`, `UserConfig`, live
  `PlaybackPreferences`, and `PlaybackPreferencesRequest`.
- Default to `h264`; accepted values are `auto`, `h264`, and `vp9`.
- Validate the codec both when loading configuration and saving preferences.
- Persist it in `save_playback_preferences`, include it in the live-preference
  fallback, initialize it in `run_server`, and expose it through preferences APIs.
- Default maximum resolution changes from unset/player default to `720`.
- `load_user_config` migrates missing quality and an existing `best` value to
  `720`. A preferences request with omitted quality also falls back to `720`.

### Format selection

New `ytdl_format_selector(codec, quality)` builds the mpv `--ytdl-format` value:

- H.264 preference: AVC/H.264 video first, then VP9, then other available video,
  followed by a combined-format fallback; audio is retained.
- VP9 preference: VP9 first, then H.264, then the same general fallbacks.
- Auto: general best-video-plus-audio/combined selection.
- Apply the requested height cap consistently to each fallback.
- Validate explicit heights from 144 through 4320. The Rust API still accepts
  `best`; the selector can omit its height constraint. Configuration loading
  nevertheless remaps a saved `best` default to 720 on restart.
- Always pass the resulting selector to mpv, including when no per-item quality
  was supplied. This replaces the previous resolution-only selector.

### `mediabridge-src/web/index.html`

- Playback defaults and per-video controls use the ordered presets 2160, 1440,
  1080, 720, and 480; 2160 is labeled `4K · 2160p`, and 720 is selected initially.
- Remove the UI options `Use player default` and `Best available`.
- Add Preferred video codec with H.264, VP9, and Automatic choices and fallback
  explanatory text.
- Read/write `default_video_codec` in the preferences form and update its save
  confirmation text.
- Normalize an unsupported/missing quality to 720 in `applyPreferences` and the
  initial `/preferences` fetch. Stop dynamically adding arbitrary quality values.
- Both existing codec assignments in `applyPreferences` are present in the exact
  diff; their duplication is incidental, not a separate feature to reproduce.

**Compatibility:** defaulting to 720 and rewriting `best` were deliberate room
resource choices. A general-purpose MediaBridge release may want to preserve the
user's existing resolution policy while taking the codec-selection feature.

## 2. Queue item schema, attribution, and duration

`QueueItem` gains optional, serde-defaulted fields:

| Field | Purpose |
| --- | --- |
| `queued_by_user_id` | Opaque identity of the person submitting/promoting an item |
| `duration_seconds` | Known finite video length |
| `metadata_error` | Last background metadata lookup failure |
| `smb_share_id` | Opaque reference to server-side SMB credentials |

- `QueueItemStatus` exposes submitter ID, duration, and metadata error alongside
  its existing title/uploader/artwork/playback fields. It does not expose an SMB
  password or the credential-service token.
- `QueueIndexRequest` gains optional `queued_by_user_id`; `/queue/promote` copies
  it to the promoted item as well as clearing `autoplay_generated`.
- `update_item_metadata` clears the previous metadata error after success and
  stores a positive finite `duration_seconds` returned by the resolver.
- When cloning a seed into an autoplay suggestion, clear its submitter ID,
  duration, title, uploader, thumbnail, and channel artwork. Suggestions must not
  inherit the seed's person or length.

**Identity boundary:** standalone MediaBridge treats IDs as caller-provided
metadata; it does not authenticate room users. Baka-Inu overwrites submitted and
promotion IDs with the authenticated user's ID, then resolves display names on
its own server. Do not claim the Rust field itself prevents identity spoofing.

## 3. Metadata scheduling, failures, and history status

- `start_url` now schedules background metadata when the new current item has no
  title, avoiding duplicate pending requests.
- After single-item play/queue operations, enqueue title-less queued entries for
  metadata. Previously that scheduling was not consistently done on those paths.
- `dispatch_pending_metadata` inspects the front current-item request without
  removing it prematurely. A current local mpv item's lookup waits for playback
  startup, so it does not compete with mpv's own extractor.
- Queued-item lookups can run while current playback has not yet reported a
  started state. Browser backends that do not report that state no longer block
  the whole queue's metadata.
- `drain_metadata` stores failure messages on matching current, queue, and history
  entries, while retaining stderr diagnostics. Failures were previously log-only.
- Add `history_items` to `/status`, using a shared `status_items` serializer for
  queue and history. History is serialized in reverse order, newest first.
- `/close` still stops playback and clears the queue, but no longer erases the
  session's history. This is in-memory MediaBridge history; Baka-Inu separately
  maintains its durable room and per-user archive files.

## 4. Browser cookies for background YouTube extraction

New `add_youtube_lookup_cookies(command, url)`:

- Applies only to YouTube URLs.
- Reads current `PLAYBACK_PREFERENCES`, including selected browser/profile.
- Reuses existing `cookie_browser_spec` resolution, including the managed
  LibreWolf profile mapped to yt-dlp's Firefox cookie reader.
- Honors cookies being off and propagates preference-selection errors.
- Adds `--cookies-from-browser` to metadata, playlist, and Mix subprocesses.
- Logs that configured browser cookies are being used without logging cookie
  contents. The CLI usage text now describes this broader scope.

The baseline already used cookies for mpv. This change closes the gap where
playback was authenticated but autoplay/background extraction was anonymous.

## 5. Background process deadline

`run_cancellable_command` adds an elapsed-time deadline of **90 seconds**. On
expiry it terminates the child process, joins stdout/stderr readers, and returns
an explicit timeout error. Existing cancellation behavior is retained.

This deadline is per invocation, not a total scan deadline. It does not cover
every `command.output()` call elsewhere: ordinary playlist expansion and a
resolver call without a cancellation token still use their existing paths.
Likewise, this Rust helper does not gain an output-size cap in this patch.

## 6. YouTube Mix extraction command and failure classification

`expand_youtube_mix_cancellable` now:

1. Tries the seeded watch URL with `list=RD<video-id>&start_radio=1`.
2. If that does not yield a usable playlist, tries the direct
   `/playlist?list=RD<video-id>` URL once.
3. Uses configured browser cookies, Deno setup, and `--ignore-config`.
4. Requests a flat JSON playlist with `--yes-playlist`, `--playlist-end 40`,
   `--socket-timeout 10`, `--retries 1`, and `--extractor-retries 1`.
5. Preserves stderr warnings instead of suppressing them. Parse failures record
   the returned result type/extractor and attempt number for diagnosis.
6. Treats English diagnostics `This playlist type is unviewable` and
   `The playlist does not exist` as unavailable-Mix outcomes. Other nonzero
   process exits are operational errors and return immediately.
7. Returns the string prefix `NO_MIX:` after exhausting the unavailable/invalid
   playlist attempts; autoplay uses that prefix to move to another candidate.

**Important limitation:** the direct playlist URL has actually returned
`This playlist type is unviewable` during this project. Its presence is an
attempted fallback, not evidence that generated Mixes are accessible that way.
The current implementation still tries it. The classifier also groups parse
failures, including invalid JSON, under `NO_MIX:` after both attempts. A typed
result distinguishing unavailable content, malformed output, authentication,
and transport failures would be a better standalone design.

There is no implementation here of general YouTube "Up next" recommendations.
Do not claim every video is guaranteed to have a Mix or that this code proves a
particular YouTube platform change occurred.

## 7. Autoplay candidate scan, retries, cancellation, and progress

### Candidate selection

- Enabling autoplay immediately calls the dispatcher; it no longer depends on
  mpv/browser reporting `playing` before requesting a Mix.
- Try the current YouTube video, then up to **20 eligible, non-autoplay YouTube
  queue entries**, in their current order.
- Non-YouTube entries do not consume the 20 eligible-video slots.
- Only one Mix worker runs at a time. At most 40 returned candidates are read
  per extraction, and at most 20 new suggestions are appended per successful Mix.
- Existing generated suggestions stop further expansion. Manual additions do not
  replace that Mix.
- Track checked video IDs during the current-root scan; unavailable or exhausted
  seeds are not requested repeatedly in that scan.
- Read candidates from the live queue on each dispatch. New eligible entries can
  be tried within the first 20 slots. Changing the current root clears the scan
  cache. Therefore 20 is a live-window limit, not a permanent lifetime limit.
- Accept results from a seed still present in either current playback or the
  queue. Clone that seed's playback settings when constructing suggestions.
- Retain duplicate filtering against seen IDs, current, queue, and history.
- If extraction succeeds but all returned entries are duplicates, continue to
  the next eligible seed instead of treating that as an operational failure.

### Retry and cancellation state

- Add a monotonically wrapping `autoplay_generation` to worker messages. Ignore
  results from older generations after cancellation or replacement.
- Operational errors retain the diagnostic, reset the requested-seed marker,
  and apply a 60-second retry cooldown. They do not skip through other seeds as
  though all those videos lacked a Mix.
- Toggling resets cooldown and scan state. Turning off cancels the active worker
  and invalidates its generation.
- When disabling removes unplayed generated suggestions, remove those IDs from
  the seen set so a manual retry can suggest them again.
- A successful queue fill clears the stored error. A no-Mix/exhausted-seed result
  also clears an old operational diagnostic before continuing the scan.

### Public status and dismissal

- `/status` adds `autoplay_loading`, `autoplay_error`, and `autoplay_status`.
- `autoplay_status_text` describes current-video lookup, the current queue item
  being checked, the eligible queued-candidate count (capped at 20), queued Mix
  results, cooldown failures, or no-Mix waiting state.
- Queue positions are one-based positions in the live full queue, so a displayed
  position can exceed 20 when non-YouTube items precede it. Candidate count is a
  different value. Both are recalculated as the queue changes.
- Add `POST /autoplay/error/clear`, returning `{ "ok": true }` and clearing only
  the diagnostic. It does not cancel extraction, change the queue, reset retry
  cooldown, or disable autoplay.

**Porting note:** progress is currently a display string and internal phase, not
a structured candidate-progress JSON object. Separate fields would suit a
standalone API better. The Rust route has no Baka-Inu role model; Baka-Inu alone
makes clearing admin-only and strips detailed errors from non-admin responses.

## 8. Queue preservation and immediate replay

- `enqueue_explicit_item` inserts immediately before the first generated entry,
  preserving all existing entries and their relative order. It no longer deletes
  generated suggestions when someone adds a manual video.
- `/queue_playlist` uses that helper repeatedly, preserving playlist order before
  the existing generated entries.
- `/queue_next` pushes to the front without deleting generated suggestions.
- `/queue_playlist_next` pushes the playlist to the front in its original order,
  without deleting the remaining suggestions.
- Add `/play_preserve_queue`: replace current playback, archive the former
  current item, advance its playback epoch, clear its playback error, and leave
  the rest of the queue intact.
- `/play` retains its intentional queue replacement. Disabling autoplay still
  removes generated suggestions; `/close` intentionally clears the queue.

```text
Before:           Manual A -> Auto X -> Auto Y
Queue Manual B:   Manual A -> Manual B -> Auto X -> Auto Y
Queue next C:     Manual C -> Manual A -> Manual B -> Auto X -> Auto Y
```

An earlier intermediate version required `preserve_queue: true` for
`/queue_next`. The current Rust handler preserves by default and does not read
that flag; some Baka-Inu requests still send it harmlessly. Port the current
semantics rather than restoring the obsolete conditional deletion.

## 9. Hardware decoding and reporting

- mpv receives `--hwdec=<MEDIABRIDGE_MPV_HWDEC>`, defaulting to `auto`.
- `/status` adds `hardware_decoder`, read from mpv's `hwdec-current` property.
- Report mpv `no` as `software`; report `checking` if it is not yet available.
- Non-mpv/browser status returns `null` for this field.

This reports **decoding**. go2rtc/FFmpeg desktop **encoding**, render-device
permissions, VA-API probing, NVIDIA support, bitrate controls, buffers, and output
resolution selection are implemented in Baka-Inu's Docker/streaming scripts and
server, not in these MediaBridge Rust differences.

## 10. Linux LibreWolf sign-in diagnostics

`open_librewolf_sign_in` on Linux now logs the selected launcher and spawned PID,
inherits launcher stderr instead of discarding it, and returns the child after
those diagnostics. It retains `MEDIABRIDGE_LIBREWOLF_NO_BIDI=1` for sign-in.
This makes startup/profile problems visible in the container's logs.

## 11. Authenticated SMB playback

The full implementation and standalone porting prompt are retained below in
the original SMB handoff section. The new Rust work consists of:

- Optional `QueueItem.smb_share_id`.
- `smb_percent_encode` and `smb_authenticated_playback_url`.
- Control-character rejection in SMB URLs.
- Protected loopback credential retrieval with a share/URL-bound lookup.
- Private stdin playlist delivery to mpv, a safe forced media title, and output
  suppression for authenticated SMB to prevent credential-bearing URLs leaking.
- A `private_smb` parameter in `watch_mpv_stderr`, retaining generic error
  classification while suppressing raw authenticated-player lines.

The adapter needs Baka-Inu's credential service and environment configuration.
Do not copy only the Rust helper into standalone MediaBridge and expect saved
credentials to exist; implement/adapt a native credential provider there.

## 12. Features already present in the standalone baseline

The comparison shows these are inherited capabilities, not new Baka-Inu changes:

- Basic YouTube Mix autoplay, queue operations, temporary suggestion promotion,
  cancellation machinery, and video-ID duplicate filtering.
- Guest SMB URL validation for local mpv playback and SMB `--ytdl=no`.
- Browser-profile cookie selection, managed LibreWolf profile support, and cookie
  access checks; the new work extends use to background YouTube commands.
- mpv IPC, play/pause/seek/volume controls, playback errors tied to an epoch,
  volume retention across videos, and desktop playback notifications.
- LibreWolf/Chromium browser automation, YouTube interface handling, Twitch
  theater handling, Linux/Windows tray/process controls, Sunshine/Moonlight,
  configurable origins/API port, and existing URL credential redaction.
- Resolver output already containing duration, live-state, and artwork fields;
  the new work retains duration/error on queue items and exposes history items.

Avoid presenting an inventory of every function in the bundled file as a list
of features added during this project. Exact changes are the attached diffs.

## 13. Baka-Inu integration changes outside the MediaBridge source

These explain the surrounding user-facing behavior but are not patches to the
standalone Rust player or its bundled dashboard:

- `server.mjs` authenticates users; stamps submitter/promoter IDs; maps IDs to
  names; limits bridge routes; filters autoplay errors for non-admins; and gates
  the error-clear operation to admins.
- The room UI provides queue/history/profile rows, channel scrolling, title
  links, middle-click background tabs, drag/reorder controls, themed Play next
  confirmation, and compact row sizing. Some history/profile UI now uses
  `/queue_next`; `/play_preserve_queue` remains an available bridge API.
- Queue total duration is computed progressively, with lookups stopped after
  the known total exceeds 24 hours. Unknown lengths remain explicit. This total
  and its caching are room-server/UI features, not a new Rust total-duration API.
- YouTube chat title/thumbnail/duration previews use oEmbed, bounded watch-page
  parsing, and Node yt-dlp fallback plus caches, as well as known bridge metadata.
  Do not assume that Node subprocess code automatically inherits Rust cookies.
- Room chat, accounts/roles, moderation, pins, bookmarks, notifications, durable
  chat/video logs, profile pagination, branding, and admin dialogs stay in Baka-Inu.
- SMB bookmarks, file browsing, credential prompts/storage, and the protected
  credential endpoint are in `smb-browser.mjs`, `smb-auth.mjs`, and their public UI.
- Container additions include `smbclient`, `libavformat-extra`, source-module
  copies, and `MEDIABRIDGE_SMB_CONFIG_DIR` / `MEDIABRIDGE_SMB_ROOM_PORT` in the
  launch wrapper. Existing runtime bundles include mpv, yt-dlp, and Deno.

## 14. Verification, limits, and suggested port order

- JavaScript syntax checks and a local Windows `cargo check --locked --offline`
  succeeded for the SMB-authentication implementation. The compiler emitted the
  existing unused-variable/dead-code warnings; no dependency changes were needed.
- That is a compile result, not end-to-end authentication verification. The
  user's Windows SMB server has not been exercised from this environment.
- A different YouTube seed produced a Mix for the user; the original example
  produced bot-check and unviewable-playlist errors along the debugging path.
  Later multi-seed fallback behavior has not been established end to end here.
- This documentation task ran no implementation tests and changed no standalone
  MediaBridge source. The attached comparison is read-only evidence.
- Saved SMB credentials and their encryption key both live on the server volume.
  Encryption does not protect against an attacker who can read both. Backups
  need the key for recovery; loss of it requires entering credentials again.
- Temporary Samba auth files contain plaintext while a listing runs, under
  private filesystem permissions; normal completion/error cleanup removes them.
  Abrupt process termination can leave a temporary file behind.
- General-purpose credential-provider design, typed Mix outcomes, structured
  scan progress, output bounds for Rust background jobs, and a total scan budget
  are follow-up work, not already implemented guarantees.

Suggested port order: schema/status -> metadata scheduler and cookies -> bounded
Mix worker -> autoplay state machine -> queue semantics and attribution -> codec
selection/decoder reporting -> sign-in diagnostics -> SMB provider integration ->
dashboard updates. Update standalone API documentation and verify each behavior
in its native environment. Keep the resolution-default policy a deliberate choice.

## 15. Complete diff-hunk index

Every Rust/dashboard diff hunk is indexed by old and new line, context, and
file in [comparison.json](mediabridge-comparison/comparison.json). The appendix
below maps those IDs to the sections above. This includes struct/config plumbing,
both status constructors, and the server preference initializer; none should be
omitted merely because it repeats a field added elsewhere.

| Hunk | File | Standalone line | Bundled line | Sections |
| --- | --- | ---: | ---: | --- |
| R01 | main.rs | 118 | 118 | 1 |
| R02 | main.rs | 129 | 130 | 1 |
| R03 | main.rs | 141 | 143 | 1 |
| R04 | main.rs | 154 | 157 | 1 |
| R05 | main.rs | 222 | 227 | 1 |
| R06 | main.rs | 271 | 280 | 1 |
| R07 | main.rs | 284 | 296 | 1 |
| R08 | main.rs | 291 | 323 | 1 |
| R09 | main.rs | 329 | 362 | 1 |
| R10 | main.rs | 340 | 374 | 2 / 11 |
| R11 | main.rs | 397 | 439 | 7 |
| R12 | main.rs | 456 | 504 | 2 |
| R13 | main.rs | 488 | 536 | 1 |
| R14 | main.rs | 503 | 553 | 1 |
| R15 | main.rs | 535 | 586 | 3 / 7 / 9 |
| R16 | main.rs | 561 | 617 | 2 |
| R17 | main.rs | 576 | 635 | 4 |
| R18 | main.rs | 668 | 727 | 1 |
| R19 | main.rs | 692 | 754 | 1 |
| R20 | main.rs | 762 | 825 | 4 |
| R21 | main.rs | 1234 | 1309 | 11 |
| R22 | main.rs | 1284 | 1360 | 5 |
| R23 | main.rs | 1303 | 1385 | 4 |
| R24 | main.rs | 1334 | 1417 | 4 |
| R25 | main.rs | 1361 | 1445 | 2 / 6 |
| R26 | main.rs | 1405 | 1518 | 3 |
| R27 | main.rs | 1414 | 1536 | 3 |
| R28 | main.rs | 1441 | 1560 | 7 |
| R29 | main.rs | 1459 | 1580 | 2 / 7 |
| R30 | main.rs | 1467 | 1589 | 7 / 8 |
| R31 | main.rs | 2399 | 2583 | 11 |
| R32 | main.rs | 2460 | 2685 | 9 |
| R33 | main.rs | 2490 | 2718 | 1 / 11 |
| R34 | main.rs | 2621 | 2856 | 3 |
| R35 | main.rs | 2885 | 3125 | 10 |
| R36 | main.rs | 2947 | 3190 | 2 / 3 |
| R37 | main.rs | 3261 | 3514 | 3 / 7 / 9 |
| R38 | main.rs | 3310 | 3572 | 3 / 7 / 9 |
| R39 | main.rs | 3575 | 3840 | 7 |
| R40 | main.rs | 3616 | 3885 | 8 |
| R41 | main.rs | 3632 | 3900 | 8 |
| R42 | main.rs | 3644 | 3912 | 3 / 8 |
| R43 | main.rs | 3677 | 3952 | 2 |
| R44 | main.rs | 3699 | 3977 | 3 / 8 |
| R45 | main.rs | 3875 | 4152 | 1 |
| W01 | web/index.html | 73 | 73 | 1 (dashboard) |
| W02 | web/index.html | 103 | 106 | 1 (dashboard) |
| W03 | web/index.html | 288 | 291 | 1 (dashboard) |
| W04 | web/index.html | 306 | 303 | 1 (dashboard) |
| W05 | web/index.html | 347 | 345 | 1 (dashboard) |
| W06 | web/index.html | 358 | 357 | 1 (dashboard) |
| W07 | web/index.html | 720 | 719 | 1 (dashboard) |


## 16. Development milestones and superseded approaches

These are handoff milestones recorded in this chat, not Git commits or a fully
recoverable edit log. Version numbers refer to the Home Assistant package.

| Version | Relevant milestone |
| --- | --- |
| Before 0.1.45 | Codec/resolution defaults, decoder reporting, metadata scheduling/errors, richer history, and sign-in diagnostics existed in the bundled implementation; exact per-edit dates are not recoverable from this worktree. |
| 0.1.45 | Chat queue-next integration and an optional queue-preservation flag. The flag-based deletion behavior was later replaced by preservation by default. |
| 0.1.48 | Queue duration retention/status fields. |
| 0.1.49 | Immediate Mix request on enable, bounded Mix extraction, retry cooldown, and loading/error status. |
| 0.1.50 | Request-generation protection, 90-second background deadline, retry/seen-marker corrections, and clearer waiting states. |
| 0.1.52 | Configured browser cookies added to background YouTube lookups. |
| 0.1.53 | Direct playlist-URL fallback and extraction diagnostics. That fallback produced unviewable-playlist errors and is not a guaranteed fix. |
| 0.1.55 | Current-video plus up-to-20-queue-candidate scan, progress text, no-Mix handling, and error-clear endpoint. |
| 0.1.56 | Preserve suggestions on manual queue and playlist additions; preserve next-item operations. |
| 0.1.57 | Submitter identity on queue entries; duration-backed metadata display in Baka-Inu. |
| 0.1.58 | Attribute promoted autoplay entries to the promoting user. |
| 0.1.60–0.1.61 | Guest SMB browser and bookmark editing; these required no new Rust SMB playback feature. |
| 0.1.62 | Share-ID-based authenticated SMB player input and protected credential-provider integration. |

The transient UI/Node fixes between these milestones remain outside the Rust
source diff. General recommendation-based autoplay was discussed but not built;
"try the next three queued videos" was a proposal superseded by the 20-candidate
limit. Browser alerts were replaced in Baka-Inu with themed dialogs, not by a new
MediaBridge native confirmation API.

---

## Follow-up: 0.1.63 SMB playback diagnostics and private input

After the source comparison above, the user could browse an authenticated Windows
share and queue an MP4, but mpv exited immediately. No useful output was visible:
authenticated-player stdout was discarded and raw stderr was intentionally hidden.
This explains the missing diagnostic, not the underlying playback failure.

Changes to port after the 0.1.62 snapshot:

- Replace `watch_mpv_stderr` with generic `watch_mpv_output`, accepting a readable
  stdout or stderr stream. Pipe and drain both streams for authenticated SMB.
- Add `smb_playback_error_from_line`, producing static credential-safe categories
  for unsupported protocols, rejected authentication, denied access, missing file,
  rejected mpv options, unrecognized media/playlist, and connection failures.
- Emit those categories as `SMB player: ...` in container logs and forward them
  into the playback error channel. Do not print raw authenticated-player lines.
- Preserve an existing detailed error when the process later exits unsuccessfully,
  instead of overwriting it with only an exit status.
- Use an explicit `#EXTM3U` header when writing the private one-item stdin playlist,
  and disable terminal input with `--input-terminal=no` so stdin belongs to the
  playlist reader.
- Copy the Rust update into the Home Assistant mirror. No credential schema or
  standalone source changes are made by this follow-up.

The local compile check passes. Playback against the user's share has not yet
been verified, so this is not a confirmed fix for the reported immediate exit.
The earlier diff files and hashes deliberately remain the 0.1.62 audit snapshot.

# Detailed SMB integration and standalone handoff

## Implemented in Baka-Inu

- Admin-only banner button opens a themed media browser.
- Up to 20 bookmarked SMB shares or subfolders, stored in
  `ROOM_DATA_DIR/smb-shares.json` on the persistent data volume.
- Folder navigation, directories first, video-file filtering, and 100 entries per page.
- File-name click adds to the queue; the separate Play next button inserts next.
- Both send the original encoded `smb://server/share/path` to MediaBridge with
  `local: true`, a filename title, and the authenticated submitter's identity.
  For authenticated shares the room attaches an opaque `smb_share_id`.
- Directory listings use `smbclient` in a subprocess with argument arrays, no shell,
  a fixed `ls` command, a separate directory argument, a 20-second timeout,
  two concurrent listings maximum, and a 2 MiB output limit.
- Bookmark, browsing, and sign-in routes require the room admin. Mutation routes
  use the existing same-origin check. A themed sign-in dialog opens when guest
  access or saved credentials are rejected; Edit sign-in opens it manually.
- Sign-in accepts a username, password, and optional computer/domain name.
  Windows `COMPUTER\user` syntax is split into domain and username. Use the
  account password, not a Windows Hello PIN.
- Remembered credentials are AES-256-GCM encrypted, bound to the share ID, in
  the bookmark file. The encryption key is in `smb-credentials.key`; both files
  use mode 0600. Session-only credentials stay in process memory. The browser
  receives only username/domain and a presence flag, never a saved password.
- Listing uses a temporary mode-0600 Samba authentication file in a private
  directory, removed after the subprocess finishes. Passwords are not in argv.
- Clear saved sign-in removes both remembered and session-only credentials.
- The runtime installs `smbclient` and Debian's `libavformat-extra` package.
  The extra FFmpeg library provides SMB protocol support for the packaged mpv.
- SMB files bypass web metadata extraction; the filename is used as the title.

No SMB port is published by Baka-Inu. The container makes outgoing connections to
the share server. Use a reachable server IP if LAN hostname resolution is unavailable.

## What changed in MediaBridge for this integration?

The original guest browser needed no Rust changes. Authenticated playback now
adds the following changes to the bundled MediaBridge source:

- `clean_media_url(input, allow_smb)` accepts SMB only for local playback, requires
  a share and file path, and rejects credentials in the URL.
- `start_url` passes `--ytdl=no` to mpv for SMB URLs so yt-dlp is bypassed.
- `QueueItem` has an optional opaque `smb_share_id`. URLs remain credential-free.
- `smb_authenticated_playback_url` reads a private token from
  `MEDIABRIDGE_SMB_CONFIG_DIR/smb-playback.token`, then requests credentials from
  `GET http://127.0.0.1:PORT/api/internal/smb-credentials?share=ID&url=ENCODED_URL`
  with a Bearer token. PORT is `MEDIABRIDGE_SMB_ROOM_PORT` (default 8081).
- The endpoint requires a loopback peer and a constant-time token match, and
  checks that the requested URL is inside the bookmarked root before responding.
  Passwords are decrypted only server-side for the private response.
- The authenticated SMB URL is constructed only in memory. It is sent to mpv
  through stdin using `--playlist=-` and `--load-unsafe-playlists`; the original
  safe URL stays in state, history, API responses, and launch logs.
- Authenticated SMB playback uses a forced safe media title. Raw stdout is
  suppressed, and stderr is inspected for generic playback error categories
  without forwarding raw lines that could include authenticated URLs.
- SMB URL validation also rejects control characters to prevent playlist-input
  injection. Credential-bearing URLs submitted by clients are still rejected.
- `/queue` and `/queue_next` use the queue-preserving behavior documented separately.
- The existing `queued_by_user_id` queue field attributes the addition to the admin.

The Docker launch wrapper sets the two credential-service environment variables.
Native deployments must configure them explicitly if using this adapter.
Linux packages must provide an SMB-enabled playback backend.

## Prompt for the standalone MediaBridge project AI

Port share-ID-based authenticated SMB playback from Baka-Inu's bundled main.rs.
Compare before copying, and consider a credential-provider interface so native
MediaBridge can use its own encrypted storage or OS credential store while the
Baka-Inu adapter uses the protected loopback service described above.

Preserve credential-free public URLs and opaque references. Keep secrets out of
command arguments, public status, history, logs, and saved browser data. Preserve
URL-to-share boundary validation, control-character rejection, HTTP timeouts,
and a bounded credential response. Do not add credentials to QueueItem.url.

The web browser and smbclient integration belong to Baka-Inu. Standalone
MediaBridge needs an appropriate credential provider and SMB-enabled mpv, not
necessarily Baka-Inu's web browser. Windows-native browsing is not implemented.
Authenticated playback has not been verified against the user's remote server.

References:
- https://packages.debian.org/trixie/libavformat-extra61
- https://www.samba.org/samba/docs/current/man-html/smbclient.1.html
