import type { HelpTexts } from "../helpContent";

// Neutral wording: the app never addresses the user directly (no "you",
// no "your") — instructions are plain imperatives, explanations passive.
export const HELP_EN: HelpTexts = {
  categories: {
    erste: "Getting started",
    start: "Start screen",
    kopfleiste: "Header & toolbox",
    zeitleiste: "Timeline",
    auswahl: "Selection & batch editing",
    detail: "Detail view",
    suche: "Search",
    hinzufuegen: "Adding files",
    datum: "Dates & AI dating",
    verwalten: "Manage",
    protokoll: "History & undo",
    tagebuch: "Diary & recordings",
    phasen: "Topic areas & phases",
    einstellungen: "Settings",
    tastatur: "Keyboard & mouse",
    faq: "Frequently asked questions",
  },
  topics: {
    // ---------- Getting started ----------
    "intro-was": {
      title: "What is CronoStream?",
      blocks: [
        {
          p: "CronoStream arranges photos, videos, audio recordings, documents, emails and diary entries on one horizontal timeline – earlier on the left, later on the right. A “stream” is a project in its own folder. Any number of them can be created, for example one for the family and one just for documents.",
        },
        {
          list: [
            "**Copies, not originals:** When a file is added, CronoStream puts a copy into the stream folder. The original files are never changed.",
            "**Everything can be undone:** Every change is recorded in the history and can be reverted. Removed files go to the trash first.",
            "**Everything stays local:** No account, no cloud, no upload. Even AI dating only goes through the clipboard. The only connection to the internet is the update check, which can be switched off (see “About CronoStream”); files and contents never leave the computer.",
          ],
        },
      ],
    },
    "intro-erster": {
      title: "A first stream in five steps",
      blocks: [
        {
          steps: [
            "On the start screen click **Create a stream**, enter a name and **Choose location**. CronoStream creates a new folder there and opens it.",
            "Add files: drag a folder from the file manager onto the window, or click the golden **+** and mark files in the file browser.",
            "In the review window check the date found for each file and click **Add**.",
            "On the timeline, zoom with the mouse wheel and drag with the mouse button held down. Clicking a tile opens the detail view.",
            "Fix wrong dates: click the timestamp in the detail view, or change several files at once via **Edit**.",
          ],
        },
      ],
    },
    "intro-originale": {
      title: "What happens to the original files?",
      blocks: [
        {
          p: "Nothing. When a file is added it is copied into the stream folder, and the original stays where it is, unchanged. Date, name, note and rotation only change the entry in CronoStream, never the file on disk.",
        },
        {
          p: "Removing or permanently deleting something only ever affects the working copy in the stream folder. The original is also the safety line: if a working copy is missing, CronoStream fetches the file from there when restoring.",
        },
      ],
    },
    "intro-hilfe": {
      title: "Where is help in the app?",
      blocks: [
        {
          list: [
            "**Help Center (?) at the top right:** **Quick start** shows the most important topics, **Show all topics** every category. Search always covers all topics. The **See also** links under a topic lead to related topics.",
            "**Small ? badges** next to controls show an explanation on hover. Most buttons have a tooltip too.",
            "**One-time hints** appear the first time a feature is used. **Don't show again** hides them for good.",
          ],
        },
        { p: "Below the search field, **▶ Tutorial videos ↗** opens the video section of the help page on felixheck.de in the browser, in the interface language." },
        { p: "The Help Center closes with Esc, the × or a click next to it. The timeline stays visible meanwhile." },
      ],
    },

    // ---------- Start screen ----------
    "start-anlegen": {
      title: "Create a new stream",
      blocks: [
        {
          steps: [
            "Click **Create a stream**.",
            "Enter a name, for example “My life”.",
            "**Choose location** and select a folder. CronoStream creates a new subfolder with this name in it, holding the database, the thumbnails and the copies of all files.",
          ],
        },
        { p: "The new stream opens right away and is empty at first." },
      ],
    },
    "start-oeffnen": {
      title: "Open a stream",
      blocks: [
        {
          list: [
            "**Click a tile:** Under **Existing streams** there is a tile for every known stream, the most recently opened one first.",
            "**Open stream folder** (on the start screen next to **Create a stream**): opens a stream folder that is not in the list yet, for example from a USB stick or a backup.",
          ],
        },
        { p: "While it opens, an overlay shows “Opening stream”, with progress for large collections. The ← arrow at the top left leads back to the start screen later." },
      ],
    },
    "start-warnungen": {
      title: "Messages when opening",
      blocks: [
        {
          list: [
            "**Stream not found:** The folder was moved or deleted. **Remove from list** removes the entry. If the folder is somewhere else now, open it again via **Open stream folder**.",
            "**Stream has been moved:** The folder was moved or copied by hand, or it is on a drive under another path (another drive letter, a stick on another computer). **Adjust paths** points it at the new location; first the app places a copy of the database in the stream folder (“cronostream.db.vor-pfadanpassung-…”). **Cancel** opens it as before.",
            "**Not closed properly:** CronoStream was not closed properly last time, e.g. after a crash. **Open anyway** is usually safe.",
            "**Already open:** The stream is open in another window and has to be closed there first. Only when it is certain that it is not really open anywhere any more (e.g. after a crash), use **Close all instances and continue**.",
          ],
        },
      ],
    },
    "start-kachel": {
      title: "The menu on a stream tile",
      blocks: [
        { p: "A click on the tile opens the stream. The number on the tile is the count of files in it. A default badge marks the default stream. The **⋯** menu (More actions) offers:" },
        {
          list: [
            "**Open:** same as clicking the tile.",
            "**Rename:** only changes the displayed name, the folder on disk keeps its name.",
            "**Set as default stream** or **Clear default stream:** the default stream opens automatically the next time the app starts, but only at app start, not after the back arrow or a language change. Only one can be the default. If it cannot be opened (folder missing, drive not mounted, open in another window), the start screen stays with a notice.",
            "**Remove from list:** the folder stays untouched and can be added back at any time via **Open stream folder**.",
            "**Delete permanently…:** deletes the whole stream from disk, after two confirmations.",
          ],
        },
        { p: "The search field above the tiles only appears from 11 streams. With many streams only the tile list scrolls, not the whole page." },
      ],
    },
    "start-duplizieren": {
      title: "Make a copy of a stream",
      blocks: [
        { p: "There is no separate duplicate function any more. A copy is made through file operations:" },
        {
          steps: [
            "Open the stream and choose 🛠 **Manage** › **File operations**.",
            "Mark all files with Ctrl+A.",
            "Choose **Add to another stream** (or copy) and, in the target dialog, **＋ Create new stream**: enter a name and location, and the new stream serves as the target right away.",
          ],
        },
        { p: "For a complete timestamped copy, use **Create backup** under 🛠 **Manage** › **Backup**. In both cases the original stays unchanged." },
      ],
    },
    "start-loeschen": {
      title: "Delete a stream",
      blocks: [
        {
          steps: [
            "In the tile’s **⋯** menu, choose **Delete permanently…**. CronoStream checks the folder and shows name, file count and size. Foreign files in the folder that don't belong to the stream are listed by name, because they would be deleted too.",
            "Decide on **Keep the history** (on by default): the database is then saved before the folder is deleted, so the stream can be restored later. Without it, deleting is final.",
            "Click **Continue**, then confirm **Delete permanently** in the second dialog. The button stays locked for a few seconds so an accidental double click can't trigger it.",
          ],
        },
        { note: "The stream folder really is deleted from disk to free the space. Original files outside the folder stay untouched." },
      ],
    },
    "start-wiederherstellen": {
      title: "Restore a deleted stream or a backup",
      blocks: [
        { p: "Both are under the unobtrusive link **Restore & trash…** at the bottom of the start screen." },
        { p: "**Deleted stream**" },
        {
          steps: [
            "Open the link and choose **Deleted streams**. Every stream deleted with **Keep the history** is listed there with its deletion date and the number of files still available.",
            "Click **Restore**, enter a name and click **Choose a location and restore**.",
          ],
        },
        { p: "CronoStream reads the files again from their original source folders. Names, dates, notes, rotations and the whole history come back. A report lists sources that have changed or gone missing since. Files without a source keep their history but don't appear on the timeline." },
        { p: "**Discard** deletes the saved history for good. Restoring is no longer possible after that." },
        { p: "**Backup**" },
        {
          steps: [
            "Open the link and choose **Restore from backup**.",
            "Choose the backup folder, enter a name and choose a location.",
          ],
        },
        { p: "CronoStream creates a complete, independent copy of the backup and then opens it. The backup stays unchanged." },
      ],
    },

    // ---------- Header & toolbox ----------
    "kopf-symbole": {
      title: "What do the icons in the header mean?",
      blocks: [
        {
          keys: [
            ["←", "Back to the start screen"],
            ["+", "Add files: opens the file browser in **Add** (same as the large golden button at the bottom right)"],
            ["📥", "Opens the small **Drop box** window for collecting files"],
            ["✨", "**Review**: AI dating"],
            ["🛠", "**Manage**: file operations, history, duplicates, trash, backup"],
            ["🔍", "Show or hide search (Ctrl+F)"],
            ["🎬 / 🎙️", "Record video or audio"],
            ["Diary", "New diary entry with the current time"],
            ["Topic areas", "Manage topic areas and phases"],
            ["⚙", "Settings"],
            ["?", "This Help Center"],
            ["☕", "Buy me a coffee: opens the donation page in the browser"],
            ["⤢ / ⤡", "Fullscreen on / off"],
          ],
        },
        { p: "When files are waiting in the queue, a round **Dropped files** button with a counter appears at the bottom right next to the large +." },
        { p: "At the bottom left, an eye symbol for **private mode** appears once it is set up: eye = all files visible, crossed-out eye = private files hidden. It can be turned off in ⚙ › Privacy." },
      ],
    },
    "kopf-statistik": {
      title: "Statistics line and name",
      blocks: [
        { p: "Next to the back arrow is the name of the open stream; it can be renamed on the start screen (pencil on the tile). In the middle, the statistics line shows how many images, videos, audio files, documents and other files the stream holds and how much space it takes up." },
      ],
    },
    "kopf-vollbild": {
      title: "Fullscreen",
      blocks: [
        { p: "⤢ at the far right switches to fullscreen, ⤡ back. Esc always leaves fullscreen, on every screen." },
        { note: "Esc also closes the topmost open layer (e.g. the detail view or search). In fullscreen, one Esc therefore often does both at once." },
      ],
    },
    "kopf-werkzeugkasten": {
      title: "The toolbox (file browser)",
      blocks: [
        { p: "+, ✨, 🛠 and ⚙ open the same fullscreen layer above the timeline, each in a different area. The areas are chosen on the left, the tabs at the top. The left bar can be expanded and collapsed." },
        {
          list: [
            "**Add:** Overview, Single image, Search disk, Import list",
            "**Review:** Fix date with AI",
            "**Manage:** File operations, History, Duplicates, Trash, Backup",
            "**Settings:** all settings and “About CronoStream”",
          ],
        },
        { p: "**✓ Done** at the top right closes the toolbox. The timeline keeps its zoom and position." },
      ],
    },
    "kopf-peek": {
      title: "Mini timeline preview (peek)",
      blocks: [
        { p: "In File operations, a small preview of the timeline floats at the bottom left. Other views can be added under ⚙ › **Timeline & lanes** › **Mini timeline preview**, one switch per view. Clicking it hides the toolbox and reveals the real timeline. The **Back to…** pill returns to the last active tab with everything as it was." },
        { p: "The preview and the pill can be dragged to another position. The preview can also be shrunk or hidden." },
      ],
    },

    // ---------- Timeline ----------
    "zl-bewegen": {
      title: "Zoom and move",
      blocks: [
        {
          list: [
            "**Zoom:** mouse wheel, no modifier key needed. The date under the mouse pointer stays where it is.",
            "**Move:** drag with the left mouse button held down. There is deliberately no scroll bar.",
            "**Range:** from the overview (the whole stream fits in the window – that's how it starts) down to a single hour.",
          ],
        },
        { p: "A particular date can be reached via the date range in search or by clicking a phase bar. Zoom and position stay as they are while working in the toolbox." },
      ],
    },
    "zl-beschriftung": {
      title: "The labels above the lanes",
      blocks: [
        { p: "The top row changes with the zoom: years in the overview, then months, weeks, days and finally hours. At day level, midnight is marked with the date and a stronger line. The current period stays pinned at the left edge (e.g. “May 2012”). Narrow day columns (under 110 px) show only the day number." },
        { p: "In the overview, clicking a year opens all files of that year as a cluster. Months, weeks and days in the row above open a cluster with all files of that period in the same way (not the labels of the day view with the hour grid). Periods without files cannot be clicked, clickable ones are underlined on hover; dragging a label only moves the timeline." },
      ],
    },
    "zl-spuren": {
      title: "Lanes: documents, images, videos, audio",
      blocks: [
        { p: "Each kind of file has its own horizontal lane. Emails, diary entries and other files share the documents lane. A lane only appears when the stream contains files of that kind – the first video makes the video lane appear." },
        { p: "The existing lanes share the height. The fewer lanes there are, the larger the tiles. The order is set in the settings (**Lane order & visibility**)." },
      ],
    },
    "zl-kacheln": {
      title: "What the tiles show",
      blocks: [
        {
          list: [
            "**Images and videos:** thumbnail, the date on hover.",
            "**Documents and PDFs:** an icon at first, the page preview on hover.",
            "**Audio:** audio image with the file name.",
            "**Emails:** envelope icon with sender and date, sender and recipient on hover.",
            "**Diary entries:** diary image with the first line of text, the date and, if any, a paper clip with the number of attachments. The pencil on the tile opens the entry straight for editing.",
          ],
        },
        { p: "Tiles are largest in the middle of the window and get smaller towards the edges (magnifier effect). The tile under the pointer is enlarged. A click opens the detail view; for a stack see “Stacks”." },
      ],
    },
    "zl-stapel": {
      title: "Stacks: many files in a small space",
      blocks: [
        { p: "When files in a lane are so close together that their tiles would overlap, CronoStream combines them into a stack: up to three offset tiles with a golden count badge. Stacks split up when zooming in and merge again when zooming out. Tiles keep their size while doing so: they stay in the coarser columns until a column of the finer grid (months, days, hours) is as wide as a tile; only then are stacks separated at the fine lines. The new grid appears faintly at first and grows stronger as you zoom in." },
        {
          list: [
            "**Hover (only with the Hover trigger):** When the pointer rests on a stack for a moment, it opens: a large preview at the top, all files of the stack as a grid below. Moving over a small tile switches the preview.",
            "**Click (default):** opens the stack: a large preview at the top, all files as a grid below. If “Zoom into timeline” is chosen in the settings, the click zooms in instead until the stack dissolves into single tiles; if that's impossible because the files are too close together, the stack opens.",
            "**In an open stack:** clicking a tile opens the detail view, Ctrl+click marks it. Esc or a click on the empty background closes the stack.",
          ],
        },
        { p: "Trigger, action and zoom brake are set in the settings under **Stacks & Zoom**." },
      ],
    },
    "zl-cluster": {
      title: "Temporary clusters",
      blocks: [
        { p: "A cluster is a view of a set of files: darkened background, a heading with the count, a large preview and the tile grid below. The documents, images, videos and audio boxes filter by type. It works just like an open stack. Esc, the ✕ or a click on the empty background closes it." },
        {
          list: [
            "**Period:** click a year, month, week or day in the labels above the lanes",
            "**Search results:** **View results** in search",
            "**Same note:** **All with this note** in the detail view",
            "**Diary attachments:** **Show files** in a diary entry",
          ],
        },
        { p: "When the detail view is opened from a cluster, the arrow keys only step through that cluster's files. After Esc the cluster is back." },
      ],
    },
    "zl-rechtsklick": {
      title: "Right-clicking a tile",
      blocks: [
        {
          list: [
            "**N Edit** (only with an active selection): hands the marked files to file operations",
            "**Open in default app**",
            "**Show file in stream folder** / **Show file in source folder** (grayed out if the original no longer exists)",
            "For images: **Rotate 90° left/right**, **Rotate 180°**. This only rotates the display, the file stays unchanged.",
            "**Add to another stream**: puts the file in another stream's queue",
            "**Remove**: takes the file out of the stream (into the trash)",
          ],
        },
        { p: "For diary entries the menu only offers **Edit** and **Remove**." },
      ],
    },
    "zl-rechtsklick-frei": {
      title: "Right-clicking an empty spot",
      blocks: [
        {
          list: [
            "**Add diary entry here:** new entry dated at the clicked spot, so entries about the past are possible too",
            "**Paste from clipboard** (only when an image is on the clipboard): asks whether to add the image as a normal image file or as a diary entry, dated at the clicked spot",
          ],
        },
      ],
    },
    "zl-datum-ziehen": {
      title: "Change a date by dragging a tile",
      blocks: [
        { p: "With **Change date by dragging tiles** switched on in the settings, a tile can be dragged sideways to its correct place. On release, CronoStream works out the date from the position. How precise that is depends on the zoom – zoom far in for an exact time." },
        { p: "It is off by default so nothing gets moved by accident; dragging on a tile then moves the whole timeline. Every change is recorded in the history." },
      ],
    },
    "zl-ohne-datum": {
      title: "Warning “files with an unreadable date”",
      blocks: [
        { p: "Files whose date cannot be read don't appear on the timeline. Instead, a warning with their number is shown at the top left. They can be found in file operations (Manage) and given a date there." },
        { p: "When a large stream opens, “Loading stream…” shows the progress. Thumbnails then appear gradually as their part of the timeline comes into view." },
      ],
    },
    "zl-leer": {
      title: "What is shown while a stream is still empty?",
      blocks: [
        { p: "A picture with the text “Nothing here yet.” The next step is to drag files onto the window, click the golden **+** in the text, or record media straight away with 🎬 / 🎙️." },
      ],
    },

    // ---------- Selection ----------
    "auswahl-markieren": {
      title: "Mark several files on the timeline",
      blocks: [
        {
          list: [
            "**Ctrl+click** (Mac: Cmd+click) on a tile marks it without opening it. Marked tiles get a golden ring. On the timeline, Ctrl+click on a stack marks the whole stack; in an open stack or cluster single tiles can be marked.",
            "**Ctrl+A** marks all visible tiles on the timeline. In a cluster or open stack it marks its content (as filtered by type); a second Ctrl+A unmarks it again.",
            "**Esc** or the ✕ in the selection bar clears the selection.",
          ],
        },
        { p: "A bar “N selected” with an **Edit** button then appears at the bottom center." },
      ],
    },
    "auswahl-bearbeiten": {
      title: "“Edit”: hand the selection to file operations",
      blocks: [
        { p: "**Edit** in the selection bar (or **N Edit** in the right-click menu) opens file operations under Manage, limited to exactly these files, all already marked. Every batch action is available there: change date, send to AI, add a note, copy or move to another stream, print export, path list, remove." },
      ],
    },
    "auswahl-beispiel": {
      title: "Example: one note for an event",
      blocks: [
        {
          steps: [
            "Zoom to the files that belong together, e.g. a birthday spread over several stacks.",
            "Mark all of them with Ctrl+click.",
            "Click **Edit**. File operations open with exactly these files.",
            "Choose **Actions** › **Add note…**, enter e.g. “Grandma's 80th birthday” and click **Add**.",
          ],
        },
        { p: "From now on search finds all these files. When one of them is open in the detail view, **All with this note (N)** shows them all together as a cluster, however far apart they are on the timeline." },
      ],
    },

    // ---------- Detail view ----------
    "detail-oeffnen": {
      title: "Open, browse and close the detail view",
      blocks: [
        { p: "Clicking a single tile, a tile in a stack or cluster, or double-clicking a search hit opens the detail view." },
        {
          list: [
            "**Browse:** arrow keys ←/→ or the round arrow buttons, in chronological order across the whole timeline. Which kinds of file are included is set by **Navigation in the detail view**. Opened from a cluster, browsing stays within its files.",
            "**Filter icon at the top left:** opens a popover where the file types (images, videos, audio, documents, All) used for browsing can be switched live. The type of the current file stays on. The choice lasts only until the detail view is closed; the **Navigation in the detail view** setting remains the starting value. The icon is not shown in a search cluster.",
            "**Close:** Esc, the ✕ at the top right, or a click next to the card. The timeline then jumps to the file last viewed, and its tile flashes briefly; it sits on top of its stack. If the starting point is out of sight, a chip “↩ Back to <Month Year>” (or Esc) appears to the left of the tile and leads back to the earlier view including the cluster grid. If browsing happened inside a cluster grid, closing returns to the grid as before.",
            "**Right-click on the media:** the same menu as on the timeline.",
          ],
        },
        { p: "Below the media are the name, timestamp, remove button, note field and an info line with size and created/modified dates." },
      ],
    },
    "detail-bild": {
      title: "Enlarge and pan images",
      blocks: [
        { p: "Mouse wheel up (or +) lets the image “break out” of the card: it fills the window height and everything else disappears. Turning the wheel further or pressing + again zooms up to six times, dragging pans the image." },
        { p: "Mouse wheel down, −, Esc or a click next to the image returns to normal." },
      ],
    },
    "detail-player": {
      title: "Play video and audio",
      blocks: [
        { p: "Videos and audio start playing in the built-in player on their own. It has play/pause, a seek bar, ±10 seconds, volume and mute, playback speed from 0.5× to 2× and, for videos, a fullscreen button." },
        { p: "If the player cannot play a format (old WMA, WMV, DivX AVI, Cinepak/Indeo, GSM or ADPCM WAV, AMR and others), it says “Converting the format for playback…”. The file is converted once with ffmpeg to WebM (VP9/Opus) and the copy is played. The copies live in the computer's cache folder (2 GB at most); the original in the stream stays unchanged." },
      ],
    },
    "detail-dokumente": {
      title: "Documents, PDFs and emails",
      blocks: [
        {
          list: [
            "**PDFs and documents:** preview or the extracted text, plus **Open in default app**. If no text could be read, it says so.",
            "**Emails (.eml, Outlook .msg):** header with subject, from, to, cc and date, then the text. On the right, **Attachments** lists all attachments with their size; a click opens one in its default program. Images embedded in the mail (in the HTML or as an attachment the text refers to) are shown, 25 MB per mail at most. Images from the internet stay blocked. Links in the text (web addresses, email addresses, phone numbers) open in the default program on click, web pages in the browser.",
            "**Other files:** name and **Open in default app**. If the file is a program or script (.exe, .bat, .sh, .desktop, .lnk …), a dialog first asks whether it should really be opened. This applies everywhere files are opened externally (timeline, email and diary attachments, file browser).",
            "**Diary entries** open their own dialog.",
          ],
        },
      ],
    },
    "detail-zeitstempel": {
      title: "Change a file's date and time",
      blocks: [
        { p: "Click the pill with date and time in the detail view. It turns into the date input; Enter applies, Esc cancels. A badge next to it shows where the date came from: Metadata, File name, Created, Modified, Custom date, From AI or Recorded." },
        { p: "Only the timestamp in CronoStream changes; the file on disk stays as it is. The change is recorded in the history." },
        { p: "Whether date and time are also shown subtly over the image is controlled by **Show timestamp overlay**." },
      ],
    },
    "detail-name-notiz": {
      title: "Name and note",
      blocks: [
        { p: "**Name:** Click the name field, edit it and save with Enter or **Confirm** (Esc cancels). This only changes the display name in CronoStream, not the file name on disk." },
        { p: "**Note:** Type into “Note on this file…”. The note saves itself – shortly after the last keystroke, when moving on and when closing. Search finds notes." },
        { p: "**All with this note (N):** If at least two files have exactly the same note text, this button appears. It opens all of them as a cluster." },
      ],
    },
    "detail-entfernen": {
      title: "Sort out files in the detail view",
      blocks: [
        { p: "The red **Remove** button or the Delete key takes the file out of the stream and shows the next one straight away – that's how a collection gets sorted through in minutes. Removed files are in the trash and can be brought back from there or from the history." },
        { note: "If **Delete working copy on removal** is switched on, CronoStream asks first: the working copy and the entry are then deleted permanently at once." },
      ],
    },
    "detail-herausziehen": {
      title: "Drag files into other programs",
      blocks: [
        { p: "Drag the media in the detail view with the mouse button held down into another program, such as an email or a file manager. A copy is created there. In an enlarged image dragging pans the image; to drag it out, hold Alt as well." },
      ],
    },

    // ---------- Search ----------
    "suche-bedienen": {
      title: "Searching",
      blocks: [
        { p: "🔍 in the header or Ctrl+F opens the search bar above the timeline. The search runs shortly after the last keystroke and ignores upper/lower case." },
        {
          list: [
            "**What is searched:** display and original name, the text of PDFs, documents, emails and diary entries, all notes, and the file names of diary attachments.",
            "**Date range:** the **Date range** switch shows from/to fields. Text and date range can be combined or used alone.",
            "**Recent searches:** a click into the empty search field, on ▾ or the ↓ key opens the list of the last 50 searches of this stream (8 visible, scrollable with the mouse wheel or arrow keys). Click or Enter restores text and filters, × removes an entry, **Clear history** all of them. Ctrl+F alone does not open the list.",
            "**Close:** the search bar's ✕, 🔍 or Esc.",
          ],
        },
      ],
    },
    "suche-ergebnisse": {
      title: "View and step through hits",
      blocks: [
        { p: "Hit tiles get a golden ring, the current one a glowing ring; everything else is dimmed. The counter shows e.g. “3/12”." },
        {
          list: [
            "**Enter / Shift+Enter** or the arrow buttons jump to the next or previous hit. The timeline moves there and zooms in far enough that the hit isn't hidden in a stack.",
            "**Hit list** below the bar: a click shows the hit on the timeline, a double click opens it. While a cluster is open, the list is hidden.",
            "**View results** opens all hits as a cluster. If the search changes, the cluster follows; in the detail view the arrow keys then stay within the search results.",
          ],
        },
      ],
    },

    // ---------- Adding files ----------
    "add-wege": {
      title: "All the ways to add files",
      blocks: [
        {
          list: [
            "**Drag onto the window:** drag files or folders from the file manager onto the main window.",
            "**Drop box window (📥):** a small collecting window that always stays on top.",
            "**File browser (+):** browse and mark folders (Overview, Single image), search the disk or import a path list.",
            "**Clipboard:** Ctrl+V on the timeline or right-click › **Paste from clipboard**.",
            "**Create new:** diary entries and video/audio recordings.",
            "**From another stream:** **Add to another stream**, or copy/move in file operations.",
          ],
        },
        { p: "A copy is always made in the stream folder; the original stays untouched." },
      ],
    },
    "add-drop": {
      title: "Drag files onto the main window",
      blocks: [
        { p: "As soon as files are dragged over the window, an overlay says “Release to add the files”. Folders are expanded into their files, hidden files are skipped. Then the **Dropped files** review window opens. **Emails** can also be dragged straight from the mail program, likewise into the drop box window and into a diary entry: on Windows, mails and attachments from Outlook (classic); several mails dragged together from Evolution are split into individual emails. Such files are kept temporarily in the local app data (folder “dropped_files”) and deleted after being added or removed from the drop box. If nothing can be taken from what was dragged, a message appears." },
      ],
    },
    "add-pruefen": {
      title: "The “Dropped files” review window",
      blocks: [
        { p: "All files in the queue end up here, whether they were dragged onto the main window, collected in the drop box or sent from another stream. Each tile shows a thumbnail." },
        {
          list: [
            "**Date choice under each tile:** every date candidate found, e.g. “(Metadata)”, “(File name)”, “(Created)”, “(Modified)”. The best source is preselected.",
            "**Email tiles** show subject, sender and mail date.",
            "**Cross on the tile:** takes the file off the queue. Nothing happens on disk.",
            "**Clear list:** takes all files off the queue at once. Here too, the files on disk stay untouched.",
            "**Possible duplicate:** a comparison card with “Already in the stream” and “Newly dropped” side by side. Discard one by one or with **Discard all duplicates**.",
            "**File not found:** the file has been moved or deleted since and cannot be added.",
          ],
        },
        { p: "At the bottom, **Review / correct dates by hand** and/or **Review dates with AI after import** can be checked; **Add (N)** brings the files in. On closing, CronoStream reports how many files were added." },
      ],
    },
    "add-ablage": {
      title: "The drop box window (📥)",
      blocks: [
        { p: "📥 opens a small window that always stays on top. While browsing the file manager, finds can be dragged into it without worrying about dates or checks. They are listed with icon and name, and a counter shows “N waiting”. If a file has gone missing since, its row is struck through. The × on a row removes it from the drop box, and **Clear list** (at the bottom) removes all entries at once. The files on disk stay untouched." },
        { p: "The **−** next to the close cross shrinks the drop box to a small circle with the stream icon and the number of waiting files. Files can be dropped onto the circle too. A double-click restores the normal view." },
        { p: "The window has no system title bar. It is moved by the top bar with logo and title; the circle can be dragged anywhere." },
        { p: "The drop box also runs without the main window. In the Linux AppImage and the installed Windows version, there can be a start menu entry for just the drop box, and it can open at system start (⚙ › **System & language** › **Startup**, see “Startup: welcome, start menu and autostart”). With the --ablage parameter, the program starts with just the drop box. A second start ends up in the program that is already running instead of opening another one: with --ablage it shows the circle, otherwise the main window." },
        { p: "Without a main window, the drop box sits in the system tray as an icon and needs very little memory. A left click on the icon opens the circle; the menu offers **Open drop box** and **Quit**. A right click on the circle or its ✕ puts it back in the tray, even if the drop box was opened from the main window (the tray icon is then created on the first right click), and **Quit** in the tray menu ends the program. Without a tray (for example because a library is missing) the circle stays visible, and its ✕ then ends the program. On GNOME the tray icon only appears with the “AppIndicator” extension. If the main window is closed while the drop box is open, the drop box keeps running and the tray icon stays; it is then only ended via **Quit** in the tray icon's right-click menu." },
        { p: "On Wayland the app starts through XWayland, because Wayland lets a window neither choose its own position nor stay on top, and the drop box needs both. The main window may look slightly softer under fractional scaling." },
        { p: "The list survives closing the app. In the main window, the round **Dropped files** button at the bottom right shows what is waiting; a click opens the review window." },
      ],
    },
    "add-uebersicht": {
      title: "The “Overview” tab in the file browser",
      blocks: [
        { p: "A folder is chosen on the left: via the path field (**Go**), the quick links (home folder, desktop, pictures, documents, downloads) or the drives. Its files appear as tiles on the right." },
        {
          list: [
            "**Click:** shows the file in the preview on the right. Images can be zoomed and rotated there, video and audio played. The preview's edge can be dragged.",
            "**Email in the preview:** subject, sender and mail date, the sorting date only if it differs. This also applies to the disk search and the file operations.",
            "**Scrolling into the preview image** (wheel forwards) opens free zoom, like the magnifier. Only the image area reacts; outside it and when scrolling backwards the preview scrolls as before. Also applies when searching the disk.",
            "**Double click or Space:** marks the file for adding (golden frame with a check mark).",
            "**Folders:** a click offers to mark the whole folder (optionally with subfolders), a double click opens it.",
            "**Arrow keys** move through the grid, **Ctrl+A** marks every file that can be added.",
            "**↑ Parent folder**, **Show files in subfolders**, type chips (photos, videos, audio, documents), **Hide files already in the stream** and **Sort** (name, size, created, modified, with a direction arrow).",
            "**Right-click:** open in default program, show folder, add to another stream.",
          ],
        },
        { p: "Files that are already there carry the band “Already in the stream”. Under each tile is the date that would be used when adding, with its source in brackets. Marked files that are already there can be taken out of the stream again with **Remove (N)**. If **Delete working copy on removal** is switched on, a dialog asks first, because the files are then deleted for good." },
      ],
    },
    "add-sammlung": {
      title: "The collection and “Add to the stream”",
      blocks: [
        { p: "Everything marked, in all visited folders and tabs, goes into one shared collection. It survives changing folders and even quitting the app." },
        { p: "As soon as something is collected, the golden **Add to the stream** button with a counter appears at the bottom right. It opens the list of all collected files. Single ones can be taken out with **Remove from list**. With the same two review boxes as in the review window, **Add** brings them in." },
      ],
    },
    "add-einzelbild": {
      title: "The “Single image” tab",
      blocks: [
        { p: "For going through photo folders like an album: one large image at a time, with its neighbors preloaded. The folder is the one chosen on the left." },
        {
          keys: [
            ["→", "Next image"],
            ["← / Backspace", "Previous image"],
            ["Space", "Mark or unmark"],
          ],
        },
        { p: "At the bottom are the name, the position (“3 / 120”), rotate buttons and **Mark**. **Insert** opens **Review before adding**, where the date source or a custom date is chosen for each file; **Add files to CronoStream** brings them in." },
      ],
    },
    "add-festplatte": {
      title: "The “Search disk” tab",
      blocks: [
        { p: "Searches from the folder chosen on the left for matching files. The search runs in the background and the app stays usable." },
        {
          list: [
            "**Search term:** part of the file name (empty = all files of the chosen types).",
            "**Include subfolders**, **File types** (images, videos, audio, documents, emails, other; nothing checked = all).",
            "**Limit date range** by **Date taken** or **Copied to the computer**.",
            "**File size** at least/at most.",
            "**Hide duplicates:** of several copies of the same file found, shows only one.",
            "**Hide files already in the stream:** also recognizes renamed copies.",
            "**Content check:** “Fast” compares size and a short excerpt, “Thorough” the whole file byte by byte (safer, but slower).",
            "**Recent searches:** the search field remembers the last 50 disk searches including their filters, shared by all streams. Picking one switches to that folder and searches at once.",
            "**Load from index:** uses the last search of this folder without reading the disk again. Date range, type and size can still be changed freely.",
          ],
        },
        { p: "A progress band shows the phase and time left, **Cancel** stops the search. Hits appear in the same grid as in the overview and go into the collection when marked. Folders with more than about 200,000 files are refused – a narrower folder works then." },
      ],
    },
    "add-liste": {
      title: "The “Import list” tab",
      blocks: [
        { p: "**Open file** picks a text file (.txt) with a full path including the file name on every line, e.g. /home/user/222.jpg. Valid files are marked and go into the collection; files not found are counted. They are added as usual via **Add to the stream**." },
      ],
    },
    "add-zwischenablage": {
      title: "Paste an image from the clipboard",
      blocks: [
        {
          list: [
            "**Ctrl+V on the timeline:** immediately opens a new diary entry with the image attached, dated “now”. Without an image on the clipboard nothing happens.",
            "**Right-click an empty spot › Paste clipboard:** asks what to do with the image. **Add image** creates a normal image file dated at the clicked spot and opens it in the detail view. **Add diary entry** opens the diary editor with the image attached.",
          ],
        },
        { p: "The image is saved as JPEG (PNG if it has transparency) and named “Clipboard” (in the interface language) plus a timestamp." },
      ],
    },
    "add-anderer-ls": {
      title: "Send files to another stream",
      blocks: [
        { p: "**Add to another stream** (right-click a tile on the timeline or in the file browser) puts the file into the chosen stream's queue. It shows up in that stream's review window the next time it is opened." },
        { p: "For an immediate transfer, use **Copy to another stream…** or **Move to another stream…** in file operations." },
      ],
    },

    // ---------- Dates & AI ----------
    "datum-quellen": {
      title: "Where CronoStream gets the date from",
      blocks: [
        { p: "In this order – the first source that yields a date wins:" },
        {
          steps: [
            "WhatsApp file name (e.g. “IMG-20190612-WA0001”)",
            "Embedded metadata: capture time (EXIF) for photos, sent date for emails",
            "Date in the file name (e.g. “20150207_150541”)",
            "File system: the creation date, unless it is later than the modification date – then the file was evidently copied later, and the modification date is used.",
          ],
        },
        { p: "In addition, but never automatically: **Date inside the file**. Videos and sound recordings often carry their recording date (iPhone videos including the time zone), PDFs and Word, Excel, PowerPoint or LibreOffice files their creation date. In the review window it appears as a further choice once it has been read in the background; in the date choice under a tile, as soon as the pointer rests on it. Marking and adding never wait for it. It is also part of the AI request. For converted or re-saved files it is often just the time of that edit, which is why the app never picks it on its own." },
        { p: "The source is shown in the review window, under the tiles in the file browser and as a badge in the detail view. Custom dates, AI dates and recordings are labelled “Custom date”, “From AI” and “Recorded”." },
      ],
    },
    "datum-eingabe": {
      title: "Using the date input",
      blocks: [
        { p: "The same input with separate fields for day, month, year, hour and minute is used everywhere in the app." },
        {
          keys: [
            ["0–9", "type digits; the input moves on to the next field by itself"],
            ["↑ / ↓", "increase or decrease the value in the field"],
            ["← / →", "move between fields (also . / :)"],
            ["Backspace", "delete the last digit; in an empty field, go back to the previous one"],
            ["Enter", "apply"],
            ["Esc", "cancel (in the detail view)"],
          ],
        },
        { p: "The day is limited to valid days of the month. Dates in the future and before the **Earliest year for dates** (a setting, 1900 by default) are rejected." },
      ],
    },
    "datum-batch": {
      title: "Change the date of several files at once",
      blocks: [
        {
          steps: [
            "Mark the files in file operations (or select them on the timeline and click **Edit**).",
            "Choose **Actions** › **Change date…** (also available on right-click).",
            "Each file gets a card with a preview, “Before: …” and its own date input.",
            "For several files, enter a date and the **Offset** (min per file, default 5) at the top and click **Apply to all**. The first file gets the date, the second 5 minutes later and so on – ideal for photo series.",
            "Adjust single cards if needed and click **Save**. Only then is anything written, all in one go.",
          ],
        },
        { p: "An invalid date prevents saving until it is fixed. The change can be undone in the history." },
      ],
    },
    "datum-nach-import": {
      title: "Check dates right after importing",
      blocks: [
        { p: "The review window and the **Add to the stream** list both have two boxes. CronoStream remembers the choice." },
        {
          list: [
            "**Review / correct dates manually:** after the import, file operations open with exactly the files just added.",
            "**Review with AI after import:** after the import, AI dating opens, limited to these files.",
          ],
        },
        { p: "With both checked, file operations come first; **Continue to AI review** leads on from there." },
      ],
    },
    "datum-ki": {
      title: "Fix dates with AI",
      blocks: [
        { p: "For files with an uncertain date, such as scanned photos, an AI can often estimate the real date from file name, folder path and metadata. CronoStream itself contains no AI and talks to none – everything goes through the clipboard. The tab is under ✨ **Review** › **Fix date with AI**." },
        {
          steps: [
            "**Select files:** filters for date range (all files by default), date field, file name, **Uncertain dates only** and **Hide files already dated by AI**. Then **Next**.",
            "Optionally enter **Additional instructions for the AI**, e.g. “All pictures with IMG_ in the name are from the 2012 Easter holiday”.",
            "**Copy to clipboard** (or **Save as file**) and paste the text into any AI chat program.",
            "Copy the AI's answer and click **Read from clipboard now and import**.",
            "Check the list: previous date, suggestion (editable), confidence and reasoning. Uncheck unwanted rows and click **Apply**.",
          ],
        },
        { p: "A report shows “X changed, Y unchanged”, with **Show changes** on request. Everything is recorded as one action “Date taken from AI” in the history and can be undone completely or per file." },
      ],
    },
    "datum-ki-details": {
      title: "AI dating: what is shared and what helps with gaps",
      blocks: [
        { p: "**Shared** are only the file name, folder path, previous date and its source, file system times and embedded metadata (e.g. EXIF capture date, time zone, GPS timestamp). Images, videos and document contents are never transferred. Whether and with which AI the text is pasted is a deliberate, separate decision." },
        { p: "**Missing answers:** if the AI didn't answer every entry, CronoStream offers **Copy missing entries to clipboard**. Paste this short follow-up into the same chat and import the answer again; the new suggestions are added to the existing ones. With very many files, **Save as file** is often more reliable." },
        { p: "**Checking:** clicking the reasoning shows all raw data of the file. **Hide unchanged** hides rows whose day stays the same. Confidence is color-coded: high (green), medium (yellow), low (orange)." },
      ],
    },

    // ---------- Manage ----------
    "verw-dateiops": {
      title: "File operations: find and mark files",
      blocks: [
        { p: "🛠 **Manage** › **File operations** shows the stream's files as a tile grid. Everything that affects many files at once is done here." },
        {
          list: [
            "**Years (left):** **All years** or a single year with its count. The newest year is selected the first time.",
            "**Filters at the top:** text field (searches file name and content), a **Date range** switch with **Timestamp in the stream** or **Added on** and from/to, type chips.",
            "**Click:** shows the file in the preview on the right (warm white ring).",
            "**Double click or Space:** marks it for the batch action (red ring). Arrow keys move through the grid.",
            "**Select-all box** at the top left or **Ctrl+A:** mark all visible files or clear everything. Count and total size are shown next to it.",
          ],
        },
        { p: "What happens to the marked files is chosen in the **Actions (N)** menu or the right-click menu." },
      ],
    },
    "verw-aktionen": {
      title: "The Actions menu",
      blocks: [
        { p: "Only active when something is marked. The same entries are in the right-click menu, which also offers rotating images." },
        {
          list: [
            "**Change date…:** one by one or staggered with an offset",
            "**Send to AI for dating:** opens AI dating with exactly these files",
            "**Add note…:** appends a term to the note of every marked file (after a comma if there already is one, without duplicates)",
            "**Rotate left (90°)** / **Rotate right (90°):** rotates all marked photos; only the rotation value is saved, the file stays unchanged. Grayed out as soon as a marked file is not a photo",
            "**Copy to another stream…** / **Move to another stream…**",
            "**Print export…:** copy photos into a folder, named by date and time",
            "**Path list to clipboard** / **Path list as text file…**",
            "**Remove from CronoStream:** into the trash",
          ],
        },
        { p: "Next to it is the **Replace file in the stream…** button. It works independently of what is marked." },
      ],
    },
    "verw-uebertragen": {
      title: "Copy or move to another stream",
      blocks: [
        { p: "After **Copy to another stream…** or **Move to another stream…**, the target is chosen from the list of streams. One that is open elsewhere right now is locked. **＋ Create new stream** in the target dialog creates a new one (name and location) that serves as the target right away." },
        {
          list: [
            "**Copy:** the files are added to the target as well; everything here stays as it is.",
            "**Move:** copies to the target and only then removes the files here (into the trash). Nothing is deleted immediately.",
            "**Duplicate check:** already there means same source path or same content (size, quick hash, BLAKE3; missing hashes in the target are computed afterwards). First the “Files already there” dialog appears with **Skip existing** or **Copy anyway** / **Move anyway**.",
            "Afterwards a result dialog lists all skipped files with the reason. Once confirmed, they are marked in file operations; when moving, they can be removed there.",
            "**Notes** come along, and with them the private mode marker. A file only stays private in the target, though, if the same marker text is set up there.",
            "**Diary entries** arrive complete: text, all attachments in their order, and note. An entry with the same text and time in the target counts as already there. If an attachment is missing in the source folder, the entry is skipped with the message “Attachment ‘…’ is missing from the source folder.” and, when moving, is not removed here.",
            "Both sides get a history entry.",
          ],
        },
      ],
    },
    "verw-druckexport": {
      title: "Print export for photo book and print services",
      blocks: [
        { p: "Many print services sort photos by the date and time in the file name or print it on the back. **Print export…** copies the marked photos into a freely chosen folder and names each copy after the date and time on the timeline, e.g. “09.10.2026 - 14.30 Uhr.jpg”." },
        {
          list: [
            "Two photos in the same minute get “- 2”, “- 3” … appended.",
            "Photos rotated in CronoStream are saved rotated.",
            "Videos and documents are skipped; this is shown beforehand.",
            "Exporting again into the same folder replaces the files instead of duplicating them.",
          ],
        },
      ],
    },
    "verw-pfadliste": {
      title: "Path list: for external programs",
      blocks: [
        { p: "**Path list to clipboard** and **Path list as text file…** produce a text with one full path per line – the paths of the copies in the stream folder." },
        { p: "This makes it possible, for example, to shrink many large videos in batch with an external conversion program. The results come back afterwards via **Replace file in the stream…**, without losing dates, notes or names." },
      ],
    },
    "verw-ersetzen": {
      title: "Replace a file in the stream",
      blocks: [
        { p: "Swaps files in the stream for another version of the same file, e.g. videos compressed afterwards." },
        {
          steps: [
            "Click **Replace file in the stream…**, read the explanation and **Choose folder…**. Subfolders are searched too.",
            "Check the list of matches. A file matches if its name contains the name of the stream file (without extension) as a whole word, possibly with a suffix and a different extension: “Holiday.mov” matches “Holiday_compressed.mp4” but not “Holiday2.mp4”. The file type must be the same. With several candidates, one has to be chosen.",
            "Click **Replace files**. A report shows before, after and the space saved.",
          ],
        },
        { p: "Date, notes, display name, rotation and position on the timeline are kept." },
        { note: "The old file in the stream folder is deleted when replacing. Undoing (in the history) only works as long as the original is still in its source folder; if it is missing, the list shows a warning." },
      ],
    },
    "verw-papierkorb": {
      title: "The trash",
      blocks: [
        { p: "🛠 **Manage** › **Trash** shows all removed files, with the same years, filters and marking as file operations. The **Actions** menu offers three levels:" },
        {
          list: [
            "**Restore:** the files return to the timeline. If the working copy is missing, CronoStream fetches it from the original source.",
            "**Delete file only:** deletes the working copy and thumbnail and frees the space. The entry with date, name and history remains; the file can be brought back from its source later.",
            "**Delete + remove from database:** deletes the file, the entry and all its history entries. This is final and only possible for files in the trash.",
          ],
        },
        { p: "Both deleting levels ask for confirmation first." },
      ],
    },
    "verw-duplikate": {
      title: "The “Duplicates” tab: check the whole stream",
      blocks: [
        { p: "**Run duplicate check now** searches the entire stream for files with the same fingerprint – useful for files added before duplicate detection was switched on. The check keeps running when switching tabs." },
        { p: "The result (“12 possible duplicates found in 5 groups”) stays below the button, together with the button **Hand off to File operations**. All files involved are shown there; the unneeded ones are marked and removed. The app never decides which version stays." },
        { p: "**Find similar pictures** also finds photos that look the same without being the same file: copies that were scaled down, recompressed by WhatsApp or saved again. For this, every photo gets a picture fingerprint from its thumbnail. Nearly single-color pictures such as sky, walls or dark shots are left out, as are pictures with very little structure. A group gathers the pictures that resemble its first picture, so a long series of similar shots gives several small groups. The first search takes longer, because every photo gets its fingerprint then. Here too the result comes as a message with **Hand off to File operations**, and it stays a suggestion." },
      ],
    },
    "verw-sicherung": {
      title: "Create a backup",
      blocks: [
        { p: "🛠 **Manage** › **Backup** › **Create backup**, then a target folder. A progress window shows “n of m files copied”; **Cancel** cleans up anything half-finished." },
        { p: "The result is a folder with the stream's name and a timestamp: files, thumbnails, database and history. The backup is itself a complete stream. To go back to it, use **Restore & trash…** › **Restore from backup** on the start screen: it creates a new copy and opens it (alternatively open it directly via **Open stream folder**)." },
        { p: "The target must not be inside the stream folder itself." },
        { p: "**Update an existing backup…** brings an earlier backup up to date instead of copying everything again: choose the backup's folder; only new and changed files are copied, together with the current state of the database. Files that no longer exist in the stream stay in the backup, so a photo deleted by mistake is still there. A folder that is not a backup of this stream is refused. If the folder contains changes this stream does not have (for example a duplicate that was continued on its own) or belongs to a stream with another name, the app asks first. The folder's previous database stays in it as “cronostream.db.vor-aktualisierung”." },
      ],
    },
    "verw-archiv": {
      title: "Check archive: are all files still intact?",
      blocks: [
        { p: "🛠 **Manage** › **Check archive** › **Check archive** looks whether everything is still complete. The check only reads and changes nothing in the files." },
        {
          list: [
            "**Missing files:** on the timeline or attached to a diary entry, but missing from the stream folder. Files of the timeline can be fetched again from their original source through the history or the trash, as long as it still exists.",
            "**Missing thumbnails:** can be restored with **Recreate thumbnails**, all at once. A quick check then shows the new state without reading the files in full again.",
            "**Files without an entry:** in the stream folder but belonging to no entry, for instance leftovers of an interrupted copy. The app does not delete them.",
            "**Changed contents:** only with **Read contents in full**. The first time, every file gets a fingerprint; later checks notice when a file changed although the app did not change it, for instance through disk damage. A backup or the original source then probably still holds the correct version.",
          ],
        },
        { p: "Reading everything in full takes a long time for large archives. It is worth doing now and then, for example before updating a backup." },
      ],
    },

    // ---------- History ----------
    "log-ueberblick": {
      title: "What the history records",
      blocks: [
        { p: "🛠 **Manage** › **History** lists every action, newest first: adding, removing, permanently deleting, renaming, date changes (by hand and by AI), replacing, setting changes in this stream and all changes to topic areas and phases." },
        {
          list: [
            "**Search the history:** finds entries by the file name at the time of the action.",
            "**Expand:** a batch action such as “147 files added” shows each file with before → after.",
            "**Preview:** resting on a file name shows the image.",
            "**Load more entries** at the end fetches older entries.",
          ],
        },
      ],
    },
    "log-rueckgaengig": {
      title: "Undo a change",
      blocks: [
        {
          steps: [
            "Find the entry in the history and click **Undo**, or **Undo all** for batch actions. In an expanded entry there is a button per file too.",
            "If the same file has been changed again since, “This file has been changed again since then” appears with the newer changes. **Undo the newer changes first** reverts them as well, in the right order. Nothing is overwritten silently.",
            "When undoing an import, CronoStream asks whether to keep or delete the copy in the stream folder. The originals are safe either way.",
          ],
        },
        { p: "Undone entries are marked as such. If the working copy is missing, CronoStream brings the file back from its original source, as long as that still exists." },
      ],
    },
    "log-endgueltig": {
      title: "Delete permanently in the history",
      blocks: [
        { p: "For removed files whose working copy is still in the stream folder, the history offers boxes (**Select all** / **Deselect all**) and the red **Delete permanently** button. It deletes working copy and thumbnail and frees the space, after a confirmation." },
        { note: "This cannot be undone. The entry remains visible as “Permanently deleted”." },
      ],
    },

    // ---------- Diary & recordings ----------
    "tb-anlegen": {
      title: "Write a diary entry",
      blocks: [
        { p: "The diary icon in the header starts an entry at the current time; right-click an empty spot › **Add diary entry here** dates it at the clicked spot. Date and time can be changed in the dialog." },
        {
          list: [
            "Write in the text field.",
            "Attachments: **Add files**, drag files into the window, **Image from clipboard** or Ctrl+V. The × on an attachment card removes it.",
            "**Save** or Ctrl+Enter saves the entry. Without text and without an attachment it cannot be saved.",
            "With unsaved changes, Esc or closing asks first (**Keep editing** / **Discard**).",
          ],
        },
      ],
    },
    "tb-lesen": {
      title: "Read and edit diary entries",
      blocks: [
        { p: "Entries appear in the documents lane with their first line, the date and the number of attachments. A click opens the entry for reading, **Edit** (or the pencil on the tile) for changing it. Clicking an attachment opens it in its default program." },
        { p: "If an entry has several viewable attachments, **Show files** shows them as a cluster, after which the entry opens again. A new entry is recorded in the history like an import and can be undone. Search also finds the text of diary entries." },
      ],
    },
    "aufn-aufnehmen": {
      title: "Record video or audio",
      blocks: [
        {
          steps: [
            "Click 🎬 (video) or 🎙️ (audio) in the header. With several devices connected, choose **Camera** and **Microphone** at the top; the last choice is remembered.",
            "**Start recording**. A red dot pulses and the time runs. Use **Pause** / **Resume** as needed.",
            "**Stop recording** and check the result in the player.",
            "Enter a **Name of the recording** and **Add to the stream**, or **Discard and record again**.",
          ],
        },
        { p: "The recording appears on the timeline at the current time; its date source is “Recorded”." },
      ],
    },
    "aufn-ffmpeg": {
      title: "What if ffmpeg is missing?",
      blocks: [
        { p: "For recordings, CronoStream needs the free program ffmpeg. On Windows and macOS it is included in the installation; if it isn't found there, reinstalling CronoStream fixes it." },
        { p: "The Linux AppImage includes ffmpeg with all video and audio decoders, so nothing needs installing there. Other Linux installations use the system's ffmpeg. If it is missing, the recording dialog offers **Install ffmpeg** via the package manager (the system password is requested) or shows a terminal command. Then **Check again**." },
      ],
    },

    // ---------- Topic areas ----------
    "ph-verwalten": {
      title: "Create topic areas and phases",
      blocks: [
        { p: "The **Topic areas** icon in the header opens the dialog. A topic area (e.g. “Career” or “Places lived”) groups phases such as “University” or “Living in Berlin”." },
        {
          list: [
            "**Create topic area** and enter a name. **Add phase** creates a draft row with empty date fields in it; the phase is saved only once **Start** and **End** are filled in.",
            "Each phase has a title, **Start** and **End** (date input), the **ongoing** box (the end is then always today) and a **Color** (palette or hex value, **Apply**). A new phase automatically gets a color that is not yet used in any topic area.",
            "**Eye:** shows or hides a phase or a whole topic area. Half-filled means only some phases are visible.",
            "**Allow overlap** is set per topic area and is on by default for new topic areas. When it is off, an overlapping phase is not saved and the phases in the way are named.",
            "**Collapse:** the arrow on the left of a topic area hides its phases from the list; only the name and the number of phases stay visible. The state is remembered; **Add phase** expands the area again.",
            "**Sort order** (switch at the top): **Recently edited** (default) puts the most recently edited topic area on top, **Manual** shows the saved order as on the timeline. Creating, renaming, overlap and all phase changes count as editing, the eye does not.",
            "**Reorder** (only with **Manual** sort order): drag by the handle on the left, or Alt+↑/↓. The timeline always keeps the manual order.",
            "**Remove phase** or **Remove topic area** with the button at the end of the row.",
          ],
        },
        { p: "All changes apply immediately and can be undone in the history. Showing and hiding is saved but not recorded." },
      ],
    },
    "ph-zeitleiste": {
      title: "Phases on the timeline",
      blocks: [
        { p: "Phases are colored bars in a band above the lanes, one row per topic area; overlapping phases stack. Resting on a bar shows its period." },
        {
          list: [
            "**Click a bar:** zooms so the whole phase fills the window. **↩ Back** at the bottom left or Esc returns to the view before, as long as there was no manual zooming or panning in between.",
            "**Right-click a bar:** **Rename**, **Change color**, **Hide phase**, **Remove phase**.",
            "**Arrow menu left of the band:** quickly show and hide topic areas.",
          ],
        },
      ],
    },

    // ---------- Settings ----------
    "set-aufbau": {
      title: "The settings: layout and categories",
      blocks: [
        { p: "⚙ opens the settings. A bar of **categories** is on the left, the settings of the chosen category on the right. The category last chosen is kept for the session, even after a language change." },
        {
          list: [
            "**System & language:** interface language, appearance (color scheme **Light** or **Dark**, dark by default; applies to the whole computer, the drop box and the program icon follow; can also be switched at the top right of the start screen), startup (welcome screen, start menu, desktop, drop box, autostart) and uninstalling.",
            "**Files & duplicates:** working copy on removal, duplicate detection, earliest year, shortcut to the duplicate manager.",
            "**Timeline & lanes:** lane order, changing the date by dragging tiles, mini timeline preview.",
            "**Stacks & Zoom:** trigger, action and zoom brake of the stacks, pointer follows the opened stack.",
            "**Media & detail view:** navigation in the detail view, timestamp overlay, video thumbnail.",
            "**Privacy:** private mode.",
            "**About CronoStream:** version, copyright and licenses.",
          ],
        },
        { p: "Switches and selection fields (side-by-side buttons of which one is chosen) take effect immediately. For the earliest year, Enter or leaving the field confirms it (“✓ Saved”); for the video thumbnail, **Apply**. A symbol to the right of a setting shows where the choice applies (see “Where a setting applies”)." },
      ],
    },
    "set-sprache": {
      title: "Changing the interface language",
      blocks: [
        {
          steps: [
            "Open **⚙ Settings**.",
            "In the category **System & language**, in the **Language** row, pick the language: **Deutsch**, **English** or **Español**.",
          ],
        },
        { p: "This also works on the start screen, even before the first stream exists: at the top right, next to the coffee cup, are the buttons **Deutsch**, **English** and **Español** as well as **Light** and **Dark** for the color scheme. The choice is the same as in the settings." },
        { p: "The interface switches immediately, no restart needed. Settings stay open. Each language is listed in its own spelling, so it can be found even when the current language isn't understood." },
        { p: "On the very first start the interface follows the operating system language (German, English or Spanish), otherwise English applies. A saved choice always takes precedence." },
        {
          list: [
            "The choice applies to all streams on this computer, including the start screen and the **Drop box**. That's why there is no “Applies to” here.",
            "Date and time formats, the help, the program's messages, the picture on the empty timeline and the file names of the **Print export** follow the language too.",
            "Content stays as it is: names, notes, diary entries, life phases and the files themselves are not translated.",
          ],
        },
      ],
    },
    "set-geltung": {
      title: "Where a setting applies (pin and globe)",
      blocks: [
        { p: "Many settings have a small symbol at the right showing where they apply: **pin** = this stream only, **globe** = every stream on this computer. Clicking it opens a small window with two choices (Esc closes just that window):" },
        {
          list: [
            "**This stream:** only in the open stream; others keep their own choice. Changes are recorded in this stream's history and can be undone.",
            "**All:** for all streams on this computer. When switching, the current value is taken over – it does not change by switching.",
          ],
        },
        { p: "There is no symbol in the categories **System & language** and **About CronoStream**, because everything there applies to the whole computer, nor in **Privacy**, which always applies to its own stream only." },
        { p: "By default every setting applies only to its own stream. That way a photo stream can behave differently from a document stream. Most settings take effect immediately." },
      ],
    },
    "set-allgemein": {
      title: "Settings: Files & duplicates",
      blocks: [
        {
          list: [
            "**Delete working copy on removal** (off by default): removing a file also deletes its copy in the stream folder. Careful: removing is then final and does not go to the trash; the detail view and file operations therefore ask first. Originals stay untouched.",
            "**Auto-detect duplicates on import** (on): checks new files against the collection and flags suspects for review.",
            "**Quick check by file name and size** (on, sub-option): only checks when a file with the same name and size already exists. Switching it off also finds renamed duplicates – that takes longer.",
            "**Earliest year for dates** (1900): earlier years are rejected in every date input, dates in the future always.",
            "**Go to Duplicate Manager →:** opens the Duplicates tab.",
          ],
        },
      ],
    },
    "set-zeitleiste": {
      title: "Settings: Timeline & lanes",
      blocks: [
        {
          list: [
            "**Lane order & visibility:** reorder the lanes by dragging the ⋮⋮ handle or with the arrow buttons. **Reset to default order** resets it. Lanes without content are hidden automatically.",
            "**Change date by dragging tiles** (off): tiles can be dragged sideways to a new date. Off means dragging moves the timeline.",
            "**Mini timeline preview** (File operations only by default): one switch per toolbox view for whether the floating preview and its back button appear.",
          ],
        },
      ],
    },
    "set-stapel": {
      title: "Settings: Stacks & Zoom",
      blocks: [
        {
          list: [
            "**Stack trigger:** **Mouse pointer (hover)** opens on resting, **Click** (default) only on a mouse click. A click always resolves a stack, whatever this setting says.",
            "**Stack action:** **Zoom into timeline** zooms until the stack dissolves into single tiles. **Expand stack (fan out)** (default) shows the grid in place without changing the zoom.",
            "**Hover zoom brake:** only applies to hover + zoom. **Step by step** stops after each step until the mouse moves. **Continuous** keeps zooming while the pointer rests. **Click only** (default) opens on resting and zooms only on click. When the brake does not apply at the moment, it is shown dimmed with a note and can still be set in advance.",
            "**Pointer follows the opened stack** (switch, off by default): when a stack fans out, the pointer jumps to the middle tile, whose file is shown large at the top. This helps with stacks at the edge. It only applies when a stack fans out (with “Zoom into timeline” only when zooming no longer suffices to dissolve it) and only where the window system allows it: X11, Windows and macOS, not a pure Wayland session.",
            "**Zoom levels:** the switches **Show week grid** and **Show hour grid** (both on by default) decide which grid levels the timeline shows. Without the week grid, the day grid starts as soon as a month fills the window; without the hour grid, it stays at the day grid however far the zoom goes.",
            "**Mouse wheel opens and closes the detail view** (switch, on by default): one wheel step forward over the large preview of an opened stack opens the file, like a click. In the detail view, it takes about three steps back in a row to close it; a pause of over 0.6 seconds or a step forward resets the count. When an enlarged image returns into the frame while zooming out, the same scroll movement does not also close the detail view; the backward steps only count anew after a 0.7-second pause. With an enlarged image and over content that scrolls by itself (documents, texts), scrolling does not count. Afterwards the wheel briefly does not act on the timeline or the image zoom.",
          ],
        },
      ],
    },
    "set-medien": {
      title: "Settings: Media & detail view",
      blocks: [
        {
          list: [
            "**Navigation in the detail view:** **Same category only** (photo to photo), **All media** (default, chronologically across all lanes) or **Custom** with switches for images, videos, audio and documents.",
            "**Show timestamp overlay** (on): date and time shown subtly along the bottom edge in the detail view.",
            "**Video preview thumbnail:** position as a percentage of the video length (10 by default). **Apply** makes it apply to new videos. **Regenerate existing video thumbnails now** also renews all existing ones.",
          ],
        },
      ],
    },
    "set-start": {
      title: "Startup: welcome, start menu and autostart",
      blocks: [
        { p: "⚙ › **System & language** › **Startup** holds settings for the app itself. They apply to the whole computer, so there is no “Applies to” here." },
        {
          list: [
            "**Show welcome screen:** shows the short introduction every time the main window opens. In the welcome window, **Don't show again** turns it off; here it can be turned back on.",
            "**Start menu entry for CronoStream:** starts the main program from the start menu.",
            "**Start menu entry for the drop box:** opens only the drop box as a small circle, without the main window.",
            "**Open the drop box at system start:** opens the drop box automatically as a small circle after login.",
            "**Shortcut on the desktop** (off by default): puts CronoStream on the desktop as an icon. On Linux, the launcher is made executable and marked as trusted right away.",
          ],
        },
        { p: "The four switches for start menu, autostart and desktop only appear in the Linux AppImage and in the installed Windows version, and they behave the same on both. On the first start, the welcome window also offers a choice of **Appearance** (Light or Dark) as long as none is saved yet; **Get started** saves the preselection. It offers the switches once (**Setup on this computer**); entries that already exist, such as those from the Windows installer, are taken over. Afterwards they can be changed here." },
        { p: "On Linux, the start menu entries sit in the menu folder **CronoStream**, together with **Uninstall CronoStream**. On Windows, the installer creates a start menu folder (its name can be chosen on a page of its own in the installer, **CronoStream** by default) with the program, **CronoStream Drop Box** and **Uninstall CronoStream**. Installer and uninstaller speak German, English or Spanish depending on the Windows language, English otherwise, and the entries are named accordingly. On Windows, an entry that is switched off is only set aside and brought back when switched on again; if it is missing entirely, it is created anew." },
        { p: "**Watched folder** (⚙ › **System & language**): a chosen folder is watched. New files in it go into the drop box automatically, even with the main window closed, as long as the drop box is running. Files already there are not picked up. **Include subfolders** also picks up files from subfolders. Unfinished files (such as .part or .tmp) are only picked up once writing has finished. If the folder is not reachable (drive disconnected), watching resumes as soon as it is back. **Stop watching** ends it." },
      ],
    },

    "set-deinstallieren": {
      title: "Removing CronoStream completely",
      blocks: [
        { p: "⚙ › **System & language** › **Uninstall** › **Remove…** or the start menu entry **Uninstall CronoStream** opens a dialog. It lists everything CronoStream has created on this computer outside the streams: settings, stream list, drop box waiting list, search index and log file, stored interface data, caches, recordings not yet added to a stream, start menu, menu folder and autostart entries, and leftovers under the former name LifeStream. After **Remove now** and a final confirmation, all of it is deleted and the app quits." },
        {
          list: [
            "**Streams** are kept. Only streams checked one by one are deleted for good, together with their folder; none is checked by default. Streams that are not in the stream list are left untouched.",
            "**Also delete the program file** (Linux only, off by default): also deletes the AppImage file. Unchecked, it stays where it is and can be started again or deleted by hand later.",
            "**Windows:** afterwards the Windows uninstaller starts without asking again and removes the program itself.",
          ],
        },
        { p: "On Windows, CronoStream can also be uninstalled as usual through the Windows settings (Apps). The uninstaller then removes the program, the start menu folder, the desktop shortcut and the autostart; with the option to delete the app data, settings and caches as well. Streams are always kept." },
        { note: "The app data also holds the saved histories of deleted streams. Once CronoStream has been removed, those streams can no longer be restored." },
      ],
    },

    "set-privat": {
      title: "Private mode: hiding files",
      blocks: [
        { p: "Private mode hides files whose note contains a certain text. They only come back after entering a password. It applies per stream and is set up under ⚙ › **Privacy**." },
        { note: "This is a privacy screen inside the app, not encryption: the files stay untouched in the stream folder. Backups always contain all files, hidden ones included." },
        { p: "**Setting up**" },
        {
          steps: [
            "Open ⚙ › **Privacy**.",
            "Enter the **Password** and repeat it (at least 4 characters).",
            "Choose **Record combination** and press the desired key combination: Ctrl and a letter, other than the usual ones like C, V or X. Two special keys also work, such as Ctrl+Shift and a letter. It needs Ctrl or Alt plus one more key; combinations already taken, such as Ctrl+F, are refused, and Esc cancels. It is shown in plain text once to check it, and masked after **Accept**. **Show** and **Hide** toggle the plain-text display in the settings.",
            "Set the **Note text**: a file counts as private when its note contains this text. Upper and lower case do not matter.",
            "Choose the scope under **Where files are hidden** (see below). Under **Hide again automatically**, a number of minutes without input can be entered; 0 means off (default). The box **Show the icon in the bottom-left corner** (on by default) shows or hides the eye.",
            "Choose **Set up private mode**. The **Recovery code** then appears once. It belongs in a safe place; **Code noted** completes the setup.",
          ],
        },
        { p: "**Scope**" },
        {
          list: [
            "**Timeline only:** the timeline and its search do not show private files. They can still be found in the file lists.",
            "**Views only** (default): the timeline, search and file lists do not show them. The history still lists them.",
            "**Everywhere:** also left out of the history and of exports. Backups stay complete.",
          ],
        },
        { p: "**In daily use**" },
        {
          list: [
            "**Hide:** press the key combination. It takes effect immediately.",
            "**Show:** press the same combination, enter the **Password** and choose **Show**.",
            "After every opening of the stream, private files are hidden. With **Hide again automatically**, they are hidden again after the set time without input.",
            "The combination works in every view and dialog of the open stream.",
            "The **symbol at the very bottom left** shows the state: eye = all files visible, crossed-out eye = private files hidden. It can be turned off in the settings with **Show the icon in the bottom-left corner**; the window then gives no sign of whether files are currently hidden.",
          ],
        },
        { p: "**Changing settings, forgotten password, turning off**" },
        {
          list: [
            "The section can only be viewed and changed with the password: **Unlock**. **Lock** closes it again.",
            "Once unlocked, the note text, scope, auto-hide and the icon can be changed (**Save changes**), as well as **Change password** and **Record again** for the combination.",
            "**Forgot password?** leads to **Set new password**, which needs the recovery code. The code is used up afterwards and a new one is shown.",
            "**Turn off private mode** removes the password, combination and note text. All files are visible again, the notes themselves stay.",
          ],
        },
      ],
    },
    "set-ueber": {
      title: "About CronoStream and licenses",
      blocks: [
        { p: "At the very bottom of the settings are the version, the copyright and a note that CronoStream is free software under the EUPL-1.2 license (free of charge and without warranty, with a link to the source code). **View open-source licenses** opens a searchable list titled “Licenses” that starts with CronoStream itself and covers all components used; a click shows the full license text." },
        { p: "The **coffee cup** (tooltip “Buy me a coffee”) in the header between ? and fullscreen, at the top right of the start screen, opens the donation page in the browser." },
        { p: "**Updates:** by default, CronoStream asks felixheck.de at most once a day whether a newer version exists (a small file over HTTPS; only the IP address is transmitted, nothing about the computer, files or streams). If there is one, a notice with **Download** appears once per version; nothing is installed automatically. Without a connection, the check stays silent. The switch **Check for updates automatically** turns it off (per computer), **Check now** asks at once and also reports when there is no connection." },
      ],
    },

    // ---------- Keyboard & mouse ----------
    "keys-allgemein": {
      title: "Shortcuts on the timeline",
      blocks: [
        {
          keys: [
            ["Mouse wheel", "Zoom (anchored at the pointer)"],
            ["Drag", "Move the timeline"],
            ["Click", "Open a file or resolve a stack"],
            ["Ctrl+click", "Mark a tile"],
            ["Ctrl+A", "Mark all visible tiles (in a cluster: its content)"],
            ["Ctrl+F", "Open search"],
            ["Enter / Shift+Enter", "Next / previous search hit"],
            ["Ctrl+V", "Image from the clipboard as a diary entry"],
            ["Right-click", "Menu for a tile, an empty spot or a phase bar"],
            ["Own combination", "Hide and show private files (⚙ › Privacy)"],
            ["Esc", "Close the topmost layer: image zoom › detail view › cluster › stack › search › selection › phase zoom. Also leaves fullscreen."],
          ],
        },
      ],
    },
    "keys-detail": {
      title: "Shortcuts in the detail view",
      blocks: [
        {
          keys: [
            ["← / →", "Previous / next file"],
            ["Delete", "Remove the file and go to the next one"],
            ["+ / −, mouse wheel", "Enlarge / shrink the image"],
            ["Drag", "Pan the enlarged image"],
            ["Alt+drag", "Drag the enlarged image into another program"],
            ["Enter / Esc", "Apply / cancel the name or date field"],
            ["Esc", "Leave the zoom or close the detail view"],
          ],
        },
      ],
    },
    "keys-browser": {
      title: "Shortcuts in the file browser and dialogs",
      blocks: [
        {
          keys: [
            ["Arrow keys", "Overview/file operations: move through the grid"],
            ["Space / double click", "Mark a file"],
            ["Ctrl+A", "Mark all files (in file operations and trash: again = clear)"],
            ["→ / ← / Backspace", "Single image: browse"],
            ["Ctrl+Enter", "Save a diary entry"],
            ["Ctrl+V", "Diary editor: paste an image as an attachment"],
            ["Alt+↑ / ↓", "Topic areas: reorder an area"],
            ["Enter", "Dialogs with a name field: confirm"],
            ["Esc", "Close a dialog, menu or the Help Center"],
          ],
        },
        { p: "The keys of the date input are listed in the topic “Using the date input”." },
      ],
    },

    // ---------- FAQ ----------
    "faq-mehrere": {
      title: "Can several streams be open at once?",
      blocks: [
        { p: "A window always has exactly one stream open. ← at the top left leads back to the start screen, where another one can be opened. The same stream can never be open in two windows at the same time – that protects the database; the message “Already open” appears in that case." },
      ],
    },
    "faq-datum-name": {
      title: "What's the difference between changing the date and renaming?",
      blocks: [
        { p: "Changing the date moves the file on the timeline. Renaming only changes the name shown in CronoStream. Neither changes the file on disk. For file names containing date and time there is the **Print export**." },
      ],
    },
    "faq-entfernen": {
      title: "Remove, “Delete file only”, delete permanently – what's what?",
      blocks: [
        {
          list: [
            "**Remove:** takes the file off the timeline into the trash. Fully reversible (trash or history).",
            "**Delete file only** (trash): frees the space of the working copy but keeps the entry. The file can be fetched again from its original source.",
            "**Delete permanently** (history) or **Delete + remove from database** (trash): cannot be undone.",
          ],
        },
        { p: "The original outside the stream folder stays untouched in every case. With **Delete working copy on removal**, removing is already final." },
      ],
    },
    "faq-sicherung": {
      title: "Backup, copy or print export – which for what?",
      blocks: [
        {
          list: [
            "**Backup** (Manage): a complete copy with a timestamp, to keep or take along.",
            "**Copy everything into a new stream** (file operations): an independent copy under a new name, e.g. to continue working on it separately.",
            "**Print export** (file operations): only selected photos, named by date, for print services.",
            "**Copy to another stream** (file operations): selected files including their data into another stream.",
          ],
        },
      ],
    },
    "faq-mitnehmen": {
      title: "How does a stream move to another computer?",
      blocks: [
        { p: "A stream is a normal folder. Create a **backup** on an external drive or stick, or copy the closed stream folder. On the other computer, open it on the start screen via **Open stream folder**. If it sits under another path there, the app asks “Stream has been moved” when opening and adjusts the paths once confirmed. Dates, notes and history are all there. “Show in source folder” and fetching files from their source only work there if the originals can be reached too." },
      ],
    },
    "faq-formate": {
      title: "Which file types does CronoStream support?",
      blocks: [
        {
          list: [
            "**Images:** JPG, PNG, GIF, BMP, WebP, TIFF",
            "**Videos:** MP4, MOV, MKV, WebM, AVI, WMV, FLV, 3GP, MPG",
            "**Audio:** MP3, WAV, M4A, FLAC, OGG, AAC, WMA, AIFF",
            "**Documents:** PDF, DOCX, DOC, ODT, RTF, TXT (also in ANSI and UTF-16), CSV, XLS, XLSX, with text search",
            "**Emails:** EML and Outlook MSG, with attachments and text search",
          ],
        },
        { p: "Other files can be added too. They appear without a preview in the documents lane and open in their default program." },
      ],
    },
    "faq-duplikate": {
      title: "How does CronoStream detect duplicates?",
      blocks: [
        { p: "CronoStream makes a short fingerprint for each file from its size plus the beginning and end of its content. The same fingerprint means a possible duplicate, even under a different name. This is fast even for large videos." },
        {
          list: [
            "**When adding:** as a comparison card in the review window. If the import itself still finds a suspect later, a message with **Hand off to File operations** appears.",
            "**For the whole collection:** the **Duplicates** tab under Manage.",
            "**In disk search:** **Hide duplicates** and **Hide files already in the stream**, optionally with a thorough content check.",
          ],
        },
        { p: "This is controlled by the settings **Auto-detect duplicates on import** and **Quick check by file name and size**." },
      ],
    },
    "faq-lokal": {
      title: "Does any data leave the computer?",
      blocks: [
        { p: "No. CronoStream works completely locally, without an account, cloud or upload. A small internal media server only delivers thumbnails to its own interface and cannot be reached from outside." },
        { p: "The only exception is a deliberate manual step: with AI dating, file names, paths and metadata are copied by hand into a freely chosen AI program – never file contents. Outside the AppImage, the recording dialog on Linux can also install ffmpeg via the package manager." },
        { p: "Within the app, files can also be concealed: **private mode** (⚙ › Privacy) hides files with a certain note text by key combination. It is a privacy screen, not encryption." },
      ],
    },
    "faq-arbeitet": {
      title: "The app is working: progress and canceling",
      blocks: [
        { p: "Longer operations show a progress card with a bar and the current file name at the top right; short waits show the “Working…” pill at the bottom right. Copying, backups and disk search can be canceled; CronoStream cleans up anything half-finished itself." },
        { p: "Feedback appears as small cards at the bottom center, some with an action button (e.g. **Hand off to File operations**)." },
      ],
    },
  },
};
