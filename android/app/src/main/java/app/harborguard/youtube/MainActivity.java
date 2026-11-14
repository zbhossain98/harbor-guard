package app.harborguard.youtube;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.WebChromeClient;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URLEncoder;
import java.util.ArrayList;

public final class MainActivity extends Activity implements BrowserEngine.Listener {
    private static final int NOTIFICATIONS = 24, SAVE_FILE = 25;
    private BrowserEngine engine;
    private PlayerService player;
    private FrameLayout root, pane;
    private LinearLayout screen, library;
    private TextView subtitle;
    private ProgressBar progress;
    private LinearLayout tools;
    private ImageView toolsIcon;
    private boolean toolsHidden, shownBackground;
    private int shownProgress = -1, shownCatalog = -1;
    private String shownMessage = "", shownTiming = "", shownToggle = "";
    private boolean shownReady;
    private final Runnable revealTools = () -> setToolsHidden(false);
    private boolean bound, libraryVisible, resumed;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private DownloadCatalog.Option saveOption;
    private Runnable afterPermission;
    private Dialog playerDialog, downloadDialog;
    private LinearLayout downloadBody;
    private String downloadId = "", downloadKey = "";
    private boolean downloadWait;
    private int downloadGeneration;
    private SeekBar playerSeek;
    private TextView playerTiming, playerToggle;
    private boolean seeking;
    private final ArrayList<Dialog> dialogs = new ArrayList<>();
    private TextView downloadStatus;
    private ProgressBar downloadProgress;
    private boolean libraryBusy;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            player = ((PlayerService.LocalBinder)binder).service(); engine = player.initialize(MainActivity.this);
            if (engine.web.getParent() instanceof ViewGroup) ((ViewGroup)engine.web.getParent()).removeView(engine.web);
            pane.addView(engine.web, 0, new FrameLayout.LayoutParams(-1, -1)); engine.attach(MainActivity.this, MainActivity.this);
            String target = BrowserEngine.youtubeUrl(getIntent().getData()); if (target != null) engine.navigate(target);
            if ("downloads".equals(getIntent().getAction())) showLibrary(); else showVideo();
            if (!resumed) engine.suspendScreen(); changed();
        }
        @Override public void onServiceDisconnected(ComponentName name) { engine = null; player = null; subtitle.setText("Reopen HarborTube to reconnect"); subtitle.setVisibility(View.VISIBLE); }
    };
    private final BroadcastReceiver downloadUpdate = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!libraryVisible) return;
            if (DownloadService.busy && libraryBusy && downloadStatus != null && downloadProgress != null) {
                downloadStatus.setText(DownloadService.status); downloadProgress.setIndeterminate(DownloadService.percent < 0); downloadProgress.setProgress(Math.max(0, DownloadService.percent));
            } else renderLibrary();
        }
    };
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this); root.setBackgroundColor(Ui.BG); screen = Ui.column(this);
        root.addView(screen, new FrameLayout.LayoutParams(-1, -1)); setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                left = bars.left; top = bars.top; right = bars.right; bottom = bars.bottom;
            } else { left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop(); right = insets.getSystemWindowInsetRight(); bottom = insets.getSystemWindowInsetBottom(); }
            if (fullscreen == null) view.setPadding(left, top, right, bottom); return insets;
        });
        // One full-size WebView. Overlays never resize the video viewport.
        pane = new FrameLayout(this); screen.addView(pane, new LinearLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(Ui.MINT));
        pane.addView(progress, new FrameLayout.LayoutParams(-1, dp(2), Gravity.TOP));
        subtitle = Ui.text(this, "Loading YouTube…", 12, Ui.MUTED, false);
        subtitle.setPadding(dp(16), dp(10), dp(16), dp(10)); subtitle.setBackgroundColor(Ui.SURFACE);
        FrameLayout.LayoutParams message = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP); message.topMargin = dp(2); pane.addView(subtitle, message);
        tools = Ui.row(this); tools.setGravity(Gravity.CENTER); tools.setPadding(dp(14), 0, dp(16), 0);
        toolsIcon = new ImageView(this); toolsIcon.setImageDrawable(Ui.icon("more", Ui.TEXT));
        tools.addView(toolsIcon, new LinearLayout.LayoutParams(dp(20), dp(20)));
        TextView toolsLabel = Ui.text(this, "Tools", 13, Ui.TEXT, true); toolsLabel.setPadding(dp(8), 0, 0, 0); tools.addView(toolsLabel);
        Ui.clickable(tools, Ui.SURFACE, 24, this::toolsSheet); tools.setElevation(dp(4));
        tools.setContentDescription("Video tools: download, background music, saved files and settings");
        FrameLayout.LayoutParams launcher = new FrameLayout.LayoutParams(-2, dp(48), Gravity.END | Gravity.BOTTOM);
        launcher.rightMargin = dp(16); launcher.bottomMargin = dp(72); root.addView(tools, launcher);
        bound = bindService(new Intent(this, PlayerService.class), connection, BIND_AUTO_CREATE);
        registerDownloadUpdates();
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
    }
    @android.annotation.SuppressLint("UnspecifiedRegisterReceiverFlag")
    private void registerDownloadUpdates() {
        IntentFilter filter = new IntentFilter(DownloadService.UPDATE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(downloadUpdate, filter, Context.RECEIVER_NOT_EXPORTED);
        // Lint does not recognize this pre-33 fallback. The signature permission
        // keeps the receiver private on Android 8-12, which lacks this flag.
        else registerReceiver(downloadUpdate, filter, "app.harborguard.youtube.INTERNAL", null);
    }
    private int dp(int value) { return Ui.dp(this, value); }
    private LinearLayout.LayoutParams square(int size) { return new LinearLayout.LayoutParams(dp(size), dp(size)); }
    @Override public void changed() {
        if (engine == null || isDestroyed()) return;
        if (shownCatalog != engine.catalogRevision) { shownCatalog = engine.catalogRevision; renderDownloadChoices(); }
        String message = !engine.error.isEmpty() ? engine.error : "Loading YouTube…";
        boolean messageVisible = !engine.ready || !engine.error.isEmpty();
        if (!shownMessage.equals(message) || shownReady != messageVisible) {
            shownMessage = message; shownReady = messageVisible;
            subtitle.setText(message); subtitle.setVisibility(messageVisible ? View.VISIBLE : View.GONE);
        }
        if (shownProgress != engine.progress) {
            shownProgress = engine.progress; progress.setProgress(engine.progress);
            progress.setVisibility(engine.progress >= 100 ? View.INVISIBLE : View.VISIBLE);
        }
        if (shownBackground != engine.background) {
            shownBackground = engine.background;
            toolsIcon.setImageDrawable(Ui.icon(engine.background ? "music" : "more", engine.background ? Ui.MINT : Ui.TEXT));
        }
        if (playerDialog != null && playerDialog.isShowing()) {
            String toggle = engine.playing ? "Pause" : "Play";
            if (!shownToggle.equals(toggle)) { shownToggle = toggle; playerToggle.setText(toggle); }
            String timing = Ui.time(engine.position) + " / " + (engine.duration > 0 ? Ui.time(engine.duration) : "Live");
            if (!shownTiming.equals(timing)) { shownTiming = timing; playerTiming.setText(timing); }
            if (!seeking) playerSeek.setProgress(engine.duration > 0 ? (int)(engine.position / engine.duration * 1000) : 0);
        }
    }
    @Override public void scrolled() {
        if (fullscreen != null || libraryVisible) return;
        setToolsHidden(true); main.removeCallbacks(revealTools); main.postDelayed(revealTools, 650);
    }
    private void setToolsHidden(boolean hide) {
        if (tools == null || fullscreen != null || toolsHidden == hide) return;
        toolsHidden = hide; tools.setClickable(!hide); tools.animate().cancel();
        tools.animate().alpha(hide ? 0 : 1).translationY(hide ? dp(12) : 0).setDuration(hide ? 100 : 160).start();
    }
    private void toolsSheet() {
        if (engine == null) return;
        LinearLayout body = Ui.column(this); body.setPadding(0, dp(14), 0, 0);
        final Dialog[] menu = new Dialog[1];
        LinearLayout first = Ui.row(this), second = Ui.row(this);
        first.addView(toolTile("download", "Download", "Video or audio", () -> { menu[0].dismiss(); downloadSheet(); }), tileParams());
        first.addView(toolTile("music", "Listen", engine.background ? "Background is on" : "Background music", () -> { menu[0].dismiss(); playerSheet(); }), tileParams());
        second.addView(toolTile("library", libraryVisible ? "YouTube" : "Saved", libraryVisible ? "Back to video" : "Offline library", () -> { menu[0].dismiss(); if (libraryVisible) showVideo(); else showLibrary(); }), tileParams());
        second.addView(toolTile("settings", "Settings", "Playback & protection", () -> { menu[0].dismiss(); settings(); }), tileParams());
        body.addView(first); body.addView(second); menu[0] = sheet("Video tools", body);
    }
    private LinearLayout.LayoutParams tileParams() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, -2, 1); p.setMargins(dp(4), dp(4), dp(4), dp(4)); return p;
    }
    private LinearLayout toolTile(String iconName, String label, String detail, Runnable action) {
        LinearLayout tile = Ui.column(this); tile.setMinimumHeight(dp(104)); tile.setGravity(Gravity.CENTER_VERTICAL); tile.setPadding(dp(16), dp(14), dp(12), dp(14));
        ImageView icon = new ImageView(this); icon.setImageDrawable(Ui.icon(iconName, Ui.TEXT)); tile.addView(icon, new LinearLayout.LayoutParams(dp(22), dp(22)));
        TextView text = Ui.text(this, label, 15, Ui.TEXT, true); text.setPadding(0, dp(8), 0, dp(2)); tile.addView(text);
        tile.addView(Ui.text(this, detail, 11, Ui.MUTED, false)); Ui.clickable(tile, Ui.SOFT, 18, action); return tile;
    }
    private void showVideo() {
        libraryVisible = false; setToolsHidden(false); if (library != null) library.setVisibility(View.GONE);
        if (engine != null) { engine.web.setVisibility(View.VISIBLE); engine.resumeScreen(); }
    }
    private void showLibrary() {
        libraryVisible = true; 
        if (engine != null) { if (!engine.background) engine.action("pause", null); engine.web.setVisibility(View.INVISIBLE); }
        renderLibrary();
    }
    private void renderLibrary() {
        downloadStatus = null; downloadProgress = null; libraryBusy = DownloadService.busy;
        if (library != null) pane.removeView(library);
        library = Ui.column(this); library.setBackgroundColor(Ui.BG); library.setPadding(dp(20), dp(20), dp(20), 0);
        library.addView(Ui.text(this, "Your downloads", 28, Ui.TEXT, true));
        TextView caption = Ui.text(this, "Ready for wherever you go", 13, Ui.MUTED, false); caption.setPadding(0, dp(6), 0, dp(22)); library.addView(caption);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); LinearLayout items = Ui.column(this); scroll.addView(items); library.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        if (DownloadService.busy || !DownloadService.status.isEmpty()) {
            LinearLayout card = card(); card.addView(Ui.text(this, DownloadService.busy ? DownloadService.currentTitle : "Latest download", 16, Ui.TEXT, true));
            TextView label = Ui.text(this, DownloadService.status, 12, Ui.MUTED, false); label.setPadding(0, dp(6), 0, dp(12)); card.addView(label); downloadStatus = label;
            if (DownloadService.busy) {
                ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); bar.setIndeterminate(DownloadService.percent < 0); bar.setProgress(Math.max(0, DownloadService.percent)); bar.setProgressTintList(android.content.res.ColorStateList.valueOf(Ui.MINT)); card.addView(bar); downloadProgress = bar;
                card.addView(Ui.pill(this, "Cancel download", false, () -> startService(new Intent(this, DownloadService.class).setAction("cancel"))));
            }
            items.addView(card, spaced());
        }
        JSONArray saved;
        try { saved = new JSONArray(getSharedPreferences("downloads", MODE_PRIVATE).getString("items", "[]")); } catch (Exception error) { saved = new JSONArray(); }
        if (saved.length() == 0) {
            LinearLayout empty = card(); empty.addView(Ui.text(this, "Keep your favourites close", 18, Ui.TEXT, true));
            TextView info = Ui.text(this, "Open a video, then choose Tools → Download to save video or audio.", 14, Ui.MUTED, false); info.setPadding(0, dp(12), 0, dp(18)); empty.addView(info);
            empty.addView(Ui.pill(this, "Explore YouTube", true, () -> { showVideo(); if (engine != null) engine.navigate(BrowserEngine.HOME); })); items.addView(empty, spaced());
        }
        for (int i = 0; i < saved.length(); i++) {
            JSONObject item = saved.optJSONObject(i); if (item == null) continue;
            LinearLayout card = card(); TextView title = Ui.text(this, item.optString("title"), 15, Ui.TEXT, true); title.setMaxLines(2); card.addView(title);
            TextView file = Ui.text(this, item.optString("file"), 11, Ui.MUTED, false); file.setPadding(0, dp(6), 0, dp(12)); card.addView(file);
            card.addView(Ui.pill(this, "Open offline", false, () -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(item.optString("uri")), item.optString("mime")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); }
                catch (RuntimeException error) { toast("The file may have moved, or no player is installed."); }
            })); items.addView(card, spaced());
        }
        items.addView(Ui.pill(this, "Back to YouTube", false, () -> { showVideo(); }), spaced());
        pane.addView(library, new FrameLayout.LayoutParams(-1, -1)); library.setAlpha(0); library.animate().alpha(1).setDuration(160).start();
    }
    private LinearLayout card() { LinearLayout card = Ui.column(this); card.setPadding(dp(18), dp(18), dp(18), dp(18)); card.setBackground(Ui.round(this, Ui.SURFACE, 20)); return card; }
    private LinearLayout.LayoutParams spaced() { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.bottomMargin = dp(14); return p; }
    private Dialog sheet(String title, LinearLayout body) {
        Dialog dialog = new Dialog(this); LinearLayout content = Ui.column(this); content.setPadding(dp(22), dp(18), dp(22), dp(24)); content.setBackground(Ui.round(this, Ui.SURFACE, 26));
        View handle = new View(this); handle.setBackground(Ui.round(this, Ui.SOFT, 3)); LinearLayout.LayoutParams grip = new LinearLayout.LayoutParams(dp(38), dp(4)); grip.gravity = Gravity.CENTER; grip.bottomMargin = dp(22); content.addView(handle, grip);
        LinearLayout heading = Ui.row(this); heading.addView(Ui.text(this, title, 23, Ui.TEXT, true), new LinearLayout.LayoutParams(0, -2, 1));
        heading.addView(Ui.action(this, "close", "Close", dialog::dismiss), square(44)); content.addView(heading);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(false); scroll.addView(body);
        content.addView(scroll, new LinearLayout.LayoutParams(-1, -2)); dialog.setContentView(content);
        Window window = dialog.getWindow(); if (window != null) { window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT)); window.setDimAmount(.6f); window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); window.setGravity(Gravity.BOTTOM); window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE); }
        dialogs.add(dialog); dialog.setOnDismissListener(ignored -> dialogs.remove(dialog));
        dialog.show(); if (window != null) window.setLayout(-1, -2); return dialog;
    }
    private void playerSheet() {
        if (engine == null || engine.videoId.isEmpty()) { toast("Open a video first"); return; }
        LinearLayout body = Ui.column(this); TextView title = Ui.text(this, engine.title, 20, Ui.TEXT, true); title.setPadding(0, dp(16), 0, dp(20)); body.addView(title);
        SeekBar seek = new SeekBar(this); playerSeek = seek; seeking = false; seek.setMax(1000); seek.setProgress(engine.duration > 0 ? (int)(engine.position / engine.duration * 1000) : 0); seek.setEnabled(engine.duration > 0 && !engine.ad); seek.setProgressTintList(android.content.res.ColorStateList.valueOf(Ui.MINT)); body.addView(seek);
        playerTiming = Ui.text(this, Ui.time(engine.position) + " / " + (engine.duration > 0 ? Ui.time(engine.duration) : "Live"), 12, Ui.MUTED, false); body.addView(playerTiming);
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int value, boolean user) { }
            @Override public void onStartTrackingTouch(SeekBar bar) { seeking = true; }
            @Override public void onStopTrackingTouch(SeekBar bar) { seeking = false; if (engine != null) engine.action("seek", engine.duration * bar.getProgress() / 1000); }
        });
        TextView toggle = Ui.pill(this, engine.playing ? "Pause" : "Play", true, () -> { if (engine != null) engine.action("toggle", null); }); playerToggle = toggle; body.addView(toggle, spaced());
        body.addView(Ui.pill(this, engine.background ? "Turn off background audio" : "Listen in background", false, () -> { if (playerDialog != null) playerDialog.dismiss(); toggleBackground(); }), spaced());
        body.addView(Ui.pill(this, "Download video or audio", false, () -> { if (playerDialog != null) playerDialog.dismiss(); downloadSheet(); }), spaced());
        body.addView(Ui.pill(this, "Share video link", false, this::share), spaced()); shownTiming = shownToggle = ""; playerDialog = sheet("Now playing", body);
        engine.setDetails(true);
        playerDialog.setOnDismissListener(closed -> { dialogs.remove(closed); playerDialog = null; if (engine != null) engine.setDetails(false); });
    }
    private void toggleBackground() {
        if (engine == null || player == null) return;
        if (engine.background) { player.setBackground(false); changed(); return; }
        if (!engine.documentStart || !engine.bridgeReady) { toast("Update Android System WebView to use background audio."); return; }
        if (engine.videoId.isEmpty()) { toast("Play a video first, then enable background audio."); return; }
        notifications(() -> {
            if (player != null && player.setBackground(true)) { engine.action("play", null); toast("Background audio on · controls are in your notifications"); changed(); }
        });
    }
    private void downloadSheet() {
        if (engine == null || engine.videoId.isEmpty() || engine.ad) { toast("Open a video first, then tap Download."); return; }
        if (!engine.bridgeReady) { toast("Update Android System WebView to enable downloads."); return; }
        if (DownloadService.busy) { showLibrary(); return; }
        if (downloadDialog != null && downloadDialog.isShowing()) return;
        downloadId = engine.videoId; downloadWait = true; downloadKey = ""; shownCatalog = -1; downloadBody = Ui.column(this);
        downloadDialog = sheet("Download", downloadBody);
        downloadDialog.setOnDismissListener(closed -> { dialogs.remove(closed); downloadDialog = null; downloadBody = null; });
        engine.action("formats", null); renderDownloadChoices();
        final int requested = ++downloadGeneration;
        main.postDelayed(() -> { if (downloadDialog != null && requested == downloadGeneration) { downloadWait = false; renderDownloadChoices(); } }, 15000);
    }
    private void renderDownloadChoices() {
        if (downloadDialog == null || downloadBody == null || engine == null) return;
        if (!downloadId.equals(engine.videoId)) { downloadDialog.dismiss(); return; }
        DownloadCatalog catalog = engine.downloads();
        StringBuilder key = new StringBuilder(engine.formatCount() + ":" + downloadWait);
        if (catalog != null) for (DownloadCatalog.Option option : catalog.options) key.append(option.label).append(option.video).append(option.audio);
        if (key.toString().equals(downloadKey)) return; downloadKey = key.toString();
        downloadBody.removeAllViews();
        TextView title = Ui.text(this, engine.title, 15, Ui.TEXT, true); title.setMaxLines(2); title.setPadding(0, dp(14), 0, dp(16)); downloadBody.addView(title);
        if (catalog == null || catalog.options.isEmpty()) {
            if (downloadWait) {
                ProgressBar reading = new ProgressBar(this); downloadBody.addView(reading, square(32));
                TextView waiting = Ui.text(this, "Reading video streams… You can keep the video playing. Choices appear here automatically.", 14, Ui.MUTED, false); waiting.setPadding(0, dp(12), 0, dp(16)); downloadBody.addView(waiting);
            } else {
                TextView detail = Ui.text(this, engine.formatCount() == 0 ? "YouTube has not exposed a downloadable media stream for this video." : "This video has no resolved MP4 or WebM stream that this phone can save yet.", 14, Ui.MUTED, false); detail.setPadding(0, dp(8), 0, dp(16)); downloadBody.addView(detail);
                downloadBody.addView(Ui.pill(this, "Retry reading streams", false, () -> { downloadKey = ""; engine.action("formats", null); renderDownloadChoices(); }), spaced());
                downloadBody.addView(Ui.pill(this, "Close & reload video", false, () -> { downloadDialog.dismiss(); showVideo(); engine.web.reload(); }), spaced());
            }
            return;
        }
        for (DownloadCatalog.Option option : catalog.options) {
            downloadBody.addView(Ui.pill(this, option.label + "  ↓", catalog.options.indexOf(option) == 0, () -> { downloadDialog.dismiss(); notifications(() -> chooseSave(option)); }), spaced());
        }
        TextView note = Ui.text(this, "Saved to Download/HarborTube. Available qualities update as YouTube loads them. Maximum size: 2 GB.", 12, Ui.MUTED, false); downloadBody.addView(note);
    }
    private void chooseSave(DownloadCatalog.Option option) {
        if (Build.VERSION.SDK_INT < 29) {
            saveOption = option; Intent pick = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(option.mime).putExtra(Intent.EXTRA_TITLE, option.filename());
            try { startActivityForResult(pick, SAVE_FILE); } catch (RuntimeException error) { toast("No file picker is available."); }
        } else startDownload(option, null);
    }
    private void startDownload(DownloadCatalog.Option option, Uri destination) {
        if (engine == null || DownloadService.busy) return;
        startForegroundService(DownloadService.request(this, option, engine.web.getSettings().getUserAgentString(), destination));
        toast("Download started"); showLibrary();
    }
    private void notifications(Runnable action) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            afterPermission = action; requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS);
        } else action.run();
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results); if (code == NOTIFICATIONS && afterPermission != null) { Runnable action = afterPermission; afterPermission = null; action.run(); }
    }
    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == SAVE_FILE && result == RESULT_OK && data != null && data.getData() != null && saveOption != null) {
            Uri uri = data.getData();
            boolean read = (data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
            boolean write = (data.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
            try {
                if (read && write) getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                else if (read) getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                else if (write) getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (SecurityException ignored) { }
            startDownload(saveOption, uri);
        }
        if (code == SAVE_FILE) saveOption = null;
    }
    private void search() {
        LinearLayout body = Ui.column(this); EditText query = new EditText(this); query.setSingleLine(true); query.setHint("Find videos, artists, playlists"); query.setTextColor(Ui.TEXT); query.setHintTextColor(Ui.MUTED); query.setTextSize(16); query.setPadding(dp(12), dp(16), dp(12), dp(16)); body.addView(query, spaced());
        final Dialog[] dialog = new Dialog[1]; Runnable submit = () -> {
            try { showVideo(); if (engine != null) engine.navigate("https://m.youtube.com/results?search_query=" + URLEncoder.encode(query.getText().toString(), "UTF-8")); dialog[0].dismiss(); }
            catch (Exception error) { toast("Search is unavailable"); }
        };
        body.addView(Ui.pill(this, "Search YouTube", true, submit)); query.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        query.setOnEditorActionListener((v, action, event) -> { if (action == android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH) { submit.run(); return true; } return false; }); dialog[0] = sheet("Discover something", body); query.requestFocus();
    }
    private void settings() {
        if (engine == null) return; LinearLayout body = Ui.column(this); boolean[] values = engine.protection(); String[] labels = {"Enable protection", "YouTube ad helper", "Network ad filtering", "Tracker filtering"};
        body.addView(Ui.pill(this, "Reload video", false, () -> { for (Dialog dialog : new ArrayList<>(dialogs)) dialog.dismiss(); showVideo(); engine.web.reload(); }), spaced());
        body.addView(Ui.pill(this, "YouTube home", false, () -> { for (Dialog dialog : new ArrayList<>(dialogs)) dialog.dismiss(); showVideo(); engine.navigate(BrowserEngine.HOME); }), spaced());
        body.addView(Ui.pill(this, "Playback check", false, this::playbackCheck), spaced());
        for (int i = 0; i < values.length; i++) { final int index = i; Switch toggle = new Switch(this); toggle.setText(labels[i]); toggle.setTextColor(Ui.TEXT); toggle.setPadding(0, dp(16), 0, dp(16)); toggle.setChecked(values[i]); toggle.setOnCheckedChangeListener((button, value) -> values[index] = value); body.addView(toggle); }
        TextView summary = Ui.text(this, engine.blocked() + " requests blocked · " + (engine.documentStart ? "Early filtering ready" : "Update Android System WebView for early filtering"), 12, Ui.MUTED, false); summary.setPadding(0, dp(14), 0, dp(20)); body.addView(summary);
        final Dialog[] dialog = new Dialog[1]; body.addView(Ui.pill(this, "Apply protection & reload", true, () -> { engine.applyProtection(values); dialog[0].dismiss(); }), spaced());
        body.addView(Ui.pill(this, "About HarborTube", false, () -> { dialog[0].dismiss(); about(); })); dialog[0] = sheet("Settings", body);
    }
    private void about() {
        LinearLayout body = Ui.column(this); TextView info = Ui.text(this, "HarborTube 0.2.2\n\nIndependent YouTube web client. Background audio is opt-in and stops when you remove the app from Recents. Downloads use available MP4 and WebM streams; not every video or quality supports saving.\n\nPlayback and account data go to YouTube, with no HarborTube server. Downloads and their titles stay on your phone.\n\nFilters: The EasyList authors, CC BY-SA 3.0. AndroidX: Apache 2.0. Source notices are included with the app source.", 14, Ui.MUTED, false); info.setPadding(0, dp(16), 0, dp(16)); body.addView(info); sheet("About", body);
    }
    private void playbackCheck() {
        if (engine == null || engine.videoId.isEmpty()) { toast("Open a video first"); return; }
        LinearLayout body = Ui.column(this); TextView report = Ui.text(this, "Reading playback…", 14, Ui.TEXT, false);
        report.setPadding(0, dp(14), 0, dp(20)); body.addView(report);
        Runnable read = () -> {
            if (engine == null) return;
            engine.web.evaluateJavascript("(()=>{const v=document.querySelector('#movie_player video')||document.querySelector('video');if(!v)return null;let ahead=0;for(let i=0;i<v.buffered.length;i++){if(v.buffered.start(i)<=v.currentTime&&v.buffered.end(i)>=v.currentTime)ahead=v.buffered.end(i)-v.currentTime;}const q=v.getVideoPlaybackQuality?.();return JSON.stringify({width:v.videoWidth,height:v.videoHeight,ahead:Math.round(ahead*10)/10,dropped:q?.droppedVideoFrames??null,total:q?.totalVideoFrames??null,state:v.paused?'Paused':v.readyState<3?'Buffering':'Playing'});})()", result -> {
                try {
                    Object decoded = new org.json.JSONTokener(result).nextValue();
                    if (!(decoded instanceof String)) { report.setText("No active video was found."); return; }
                    JSONObject data = new JSONObject((String)decoded);
                    android.content.pm.PackageInfo provider = android.webkit.WebView.getCurrentWebViewPackage();
                    report.setText("Status: " + data.optString("state") + "\nResolution: " + data.optInt("width") + " × " + data.optInt("height")
                        + "\nBuffered ahead: " + data.optDouble("ahead") + " seconds\nDropped frames: " + (data.isNull("dropped") ? "Unavailable" : data.optLong("dropped") + " of " + data.optLong("total"))
                        + "\nWebView: " + (provider == null ? "Unknown" : provider.versionName)
                        + "\n\nA near-empty buffer points to slow delivery. Increasing dropped frames with a healthy buffer points to rendering or decoding load.");
                } catch (Exception ignored) { report.setText("Playback details are unavailable."); }
            });
        };
        body.addView(Ui.pill(this, "Refresh", false, read)); sheet("Playback check", body); read.run();
    }
    private void share() { if (engine != null && !engine.videoId.isEmpty()) startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "https://www.youtube.com/watch?v=" + engine.videoId), "Share video")); }
    private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_SHORT).show(); }
    @Override public void external(Uri uri) { try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (RuntimeException error) { toast("No browser can open this link."); } }
    @Override public void fullscreen(View view, WebChromeClient.CustomViewCallback callback) {
        if (fullscreen != null) { callback.onCustomViewHidden(); return; } fullscreen = view; fullscreenCallback = callback; screen.setVisibility(View.GONE); tools.setVisibility(View.GONE); main.removeCallbacks(revealTools); root.setPadding(0, 0, 0, 0); root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 30) { getWindow().getInsetsController().hide(WindowInsets.Type.systemBars()); getWindow().getInsetsController().setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE); }
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
    @Override public void exitFullscreen() {
        if (fullscreen == null) return; root.removeView(fullscreen); fullscreen = null; screen.setVisibility(View.VISIBLE); tools.setVisibility(View.VISIBLE); setToolsHidden(false); getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 30) getWindow().getInsetsController().show(WindowInsets.Type.systemBars()); else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden(); fullscreenCallback = null; root.requestApplyInsets();
    }
    private void back() { if (fullscreen != null) exitFullscreen(); else if (libraryVisible) { showVideo(); } else if (engine != null && engine.web.canGoBack()) engine.web.goBack(); else finish(); }
    @Override public void onBackPressed() { back(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if ("downloads".equals(intent.getAction())) showLibrary(); else { String target = BrowserEngine.youtubeUrl(intent.getData()); if (engine != null && target != null) { showVideo(); engine.navigate(target); } } }
    @Override protected void onResume() { super.onResume(); resumed = true; if (engine != null) engine.resumeScreen(); if (libraryVisible) renderLibrary(); }
    @Override protected void onPause() { super.onPause(); }
    @Override protected void onStop() { resumed = false; if (engine != null) engine.suspendScreen(); super.onStop(); }
    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null); unregisterReceiver(downloadUpdate);
        for (Dialog dialog : new ArrayList<>(dialogs)) dialog.dismiss(); exitFullscreen();
        if (engine != null) { pane.removeView(engine.web); engine.detach(); }
        if (bound) unbindService(connection); super.onDestroy();
    }
}
