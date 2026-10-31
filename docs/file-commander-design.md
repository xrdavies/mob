# File Commander Design

## Overview

The Files dialog uses a two-pane file commander layout for transferring files between the office computer (mobd) and this device. The left pane shows the remote shared folder (`~/mob-files`), fixed and flat. The right pane shows the local filesystem with full directory navigation, starting in Downloads.

## UI Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Files                                                               [×] │
├───────────────────────────────────┬─────────┬──────────────────────────┤
│ Office · ~/mob-files          [↻] │         │ This Mac            [↑] │
│                                   │         │ Home > Downloads         │
│                                   │         │                          │
│   android-ui-upload.bin    31 MiB │[←Upload]│   work-files/            │
│ ► quarterly-report.xlsx     2 MiB │[Downl.→]│ ► screenshot.png         │
│   notes.md                  4 KiB │         │   report.pdf             │
│   photo.jpg               856 KiB │         │   budget-2024.xlsx       │
│                                   │         │                          │
│                                   │         │                          │
│                                   │         │                          │
│                                   │         │                          │
├───────────────────────────────────┴─────────┴──────────────────────────┤
│ ↓ quarterly-report.xlsx  ██████████░░░░ 78%      [Pause] [Cancel]     │
│ ✓ Downloaded notes.md                                              [×]     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Components

### Left Pane (Remote)
- **Header:** "Office · ~/mob-files" with [↻] Refresh button
- **File list:** Flat list of files in the shared folder
  - File name left-aligned
  - File size right-aligned
  - No file type icons
  - Click to select/highlight (indicated with `►`)
- **Rooted at `~/mob-files`:** Open its folders with double-click and go back up, never above `~/mob-files`

### Right Pane (Local)
- **Header:** "This Mac" with [↑] up button
- **Breadcrumb:** Clickable path (e.g., "Home > Downloads")
- **File list:** Current directory contents
  - Files: name and size
  - Folders: name with trailing `/`
  - Click to select/highlight
  - Double-click folders to open
- **Navigation:** Full directory tree, starts in `~/Downloads`

### Middle Buttons
- **[← Upload]** Upload the selected local file or folder into the open office folder (right to left)
- **[Download →]** Download the selected office file into the open local folder (left to right)
- Folders on the office side can't be downloaded yet

### Transfer Strip (Bottom)
- **Active transfers:** All in-progress uploads/downloads
  - Direction indicator: `↑` upload, `↓` download
  - File name
  - Progress bar
  - Percentage and bytes (e.g., "2.3 MB / 5.1 MB")
  - [Pause] and [Cancel] buttons
- **Success message:** Most recent completed transfer only
  - Format: "✓ Downloaded filename" or "✓ Uploaded filename"
  - Auto-dismisses after 3-5 seconds
  - [×] button to dismiss manually

## Interactions

### File Selection
- **Click** a file row to select/highlight it
- Only one file selected at a time per pane
- Selected file indicated with `►` marker
- Click Upload or Download to transfer the selected file

### Directory Navigation (Right Pane)
- **Double-click** a folder to open it
- **Click** breadcrumb segments to jump up the tree
- **Click [↑]** to go up one level
- Path updates in breadcrumb as you navigate

### Context Menus (Right-click)

**Left Pane (Remote):**
- **Download** — downloads the file to current local directory
- **Rename** — renames the file on the office computer (inline edit or dialog)
- **Delete** — removes the file from `~/mob-files` with confirmation dialog:
  ```
  Delete quarterly-report.xlsx from office computer?
  
  [Cancel]  [Delete]
  ```

**Right Pane (Local):**
- **Upload** — uploads the file or folder to `~/mob-files` on office computer
  - Files: uploaded directly
  - Folders: uploaded recursively with all contents
- **Show in Finder** — reveals the file in Finder

### Transfer Behavior

**Download:**
1. Select file in left pane
2. Click Download → or right-click → Download
3. File downloads to current directory shown in right pane
4. Progress bar appears in transfer strip
5. When complete, file appears highlighted in right pane (if viewing that directory)
6. Success message shows: "✓ Downloaded filename"
7. Success message auto-dismisses after 3-5 seconds

**Upload:**
1. Select file/folder in right pane
2. Click ← Upload or right-click → Upload
3. File/folder uploads into the office folder open on the left (`~/mob-files` or a folder in it)
4. Progress bar appears in transfer strip
5. When complete, file appears in left pane (after manual refresh or auto-refresh)
6. Success message shows: "✓ Uploaded filename"
7. Success message auto-dismisses after 3-5 seconds

**Folder Upload:**
- Recursively uploads all files and subdirectories
- Progress shows total bytes for all files
- Creates matching directory structure in `~/mob-files`

**Pause/Resume:**
- Click [Pause] to pause an active transfer
- Button changes to [Continue], click to resume
- Paused transfers remain in the strip until resumed or canceled

**Cancel:**
- Click [Cancel] to abort a transfer
- Partial uploads removed from `~/mob-files/.uploads/`
- Partial downloads removed from local filesystem
- Transfer removed from strip

### File Highlighting

When a download completes:
1. If right pane is viewing the target directory, the new file auto-highlights
2. User sees the file appear with `►` marker
3. Provides immediate visual feedback without needing "Show in Folder"

## Design Principles

### Simplicity
- No file type icons (reduces visual noise)
- No checkboxes (click-to-select is cleaner)
- No Copy button for path (not needed)
- Folders indicated with trailing `/` only

### Clarity
- File names left-aligned, sizes right-aligned for easy scanning
- Selected file clearly marked with `►`
- Transfer direction obvious: `↑` upload, `↓` download
- Success messages confirm actions

### Efficiency
- Right-click menus for quick actions
- Breadcrumb navigation for fast directory jumps
- Middle buttons for keyboard-free transfers
- Auto-dismiss success messages to avoid clutter

### Scope Boundaries
- **Remote:** Fixed to `~/mob-files`, no navigation
  - Agent handles moving files from other directories
  - Security: no arbitrary filesystem access
- **Local:** Full navigation within user's home directory
  - Standard filesystem permissions apply
- **Desktop only:** This UI is for Tauri desktop app
  - iOS and Android keep simpler single-list design

## Implementation Notes

### mobd API Extensions Needed

**Folder uploads require:**
- Accept tus uploads with directory metadata
- Create matching directory structure in `~/mob-files`
- Return nested path in completion receipt

**Rename requires:**
- Endpoint: `POST /files/{path}/rename` with `{"newName": "..."}` (see mobd `docs/file-transfers.md`)
- Validation: no path traversal, no overwrites, no dot names

**Delete requires:**
- Endpoint: `DELETE /files/{path}`; a folder is deleted with its contents, so the confirmation must say so
- Remove file from `~/mob-files`
- Return 404 if not found, 204 on success

### Local Filesystem Access (Tauri)

- Use `@tauri-apps/plugin-fs` for directory reading
- Use `@tauri-apps/plugin-dialog` for system file picker (if needed)
- Respect macOS sandbox restrictions
- Handle permission errors gracefully

### Transfer State Management

- Store transfers in Zustand `useTransfers` store
- Persist active transfers across app restarts (optional)
- Track: id, direction, filename, status, bytes, total, message
- Statuses: `running`, `paused`, `failed`, `done`, `ready` (download awaiting save, unused in commander)

### Edge Cases

- **User navigates away during download:** Success message shows target path
- **Network disconnection:** Transfer fails, show retry option
- **Duplicate filenames:** mobd renames with upload ID suffix
- **Large folders:** Show aggregate progress for all files
- **Permission errors:** Show error message in transfer strip

## Future Enhancements (Not in Initial Version)

- Drag and drop between panes
- Multi-file selection (Cmd+click, Shift+click)
- Sorting options (name, size, date)
- Search/filter in file lists
- Folder size calculation for local pane
- Thumbnails for images
