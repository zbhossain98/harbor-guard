package app.harborguard.youtube;

import android.content.Context;
import android.content.MutableContextWrapper;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.*;
import android.view.View;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashSet;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicInteger;

/** Service-owned WebView: attaching a screen never creates a second player. */
public final class BrowserEngine {
    public interface Listener {
        void changed();
        void external(Uri uri);
        void fullscreen(View view, WebChromeClient.CustomViewCallback callback);
        void exitFullscreen();
        void scrolled();
    }
    public interface MediaListener { void mediaChanged(); }
    public static final String HOME = "https://m.youtube.com/";
    private final Context context;
    private final MutableContextWrapper wrapper;
    private final SharedPreferences preferences;
    private final ExecutorService loader = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger blocked = new AtomicInteger();
    private volatile HostRules rules;
    private volatile String topHost = "m.youtube.com";
    private volatile boolean enabled, ads, trackers, helper;
    public boolean background, documentStart, bridgeReady, ready, playing, ad;
    public String title = "Ready when you are", videoId = "", error = "";
    public double position, duration;
    public int progress, catalogRevision;
    public Listener listener;
    public MediaListener mediaListener;
    public final WebView web;
    private ScriptHandler script;
    private JSONObject catalogData;
    private boolean catalogFromPlayer;
    private DownloadCatalog cachedCatalog;
    private int cachedRevision = -1;
    private boolean uiPending;
    private boolean destroyed;
    private long lastScroll;
    private final Runnable notifyUi = () -> { uiPending = false; if (!destroyed && listener != null) listener.changed(); };
    private final ArrayDeque<String> observedMedia = new ArrayDeque<>();
    private final HashSet<String> reportedMedia = new HashSet<>();
    private String playerSource = "", runtimeSource = "", domSource = "", mediaSource = "", initialUrl = HOME;
    public BrowserEngine(Context service) {
        context = service.getApplicationContext(); wrapper = new MutableContextWrapper(service);
        preferences = service.getSharedPreferences("protection", Context.MODE_PRIVATE);
        readSettings();
        web = new WebView(wrapper) {
            @Override protected void onWindowVisibilityChanged(int visibility) {
                super.onWindowVisibilityChanged(background ? View.VISIBLE : visibility);
            }
            @Override protected void onScrollChanged(int x, int y, int oldX, int oldY) {
                super.onScrollChanged(x, y, oldX, oldY);
                long now = SystemClock.uptimeMillis();
                if (listener != null && Math.abs(y - oldY) > 2 && now - lastScroll >= 80) { lastScroll = now; listener.scrolled(); }
            }
        };
        web.setBackgroundColor(Ui.BG);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Native play and notification buttons execute JavaScript outside a DOM
        // gesture. The page still controls when to start its own video.
        settings.setSafeBrowsingEnabled(true); settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "harborTube", new HashSet<>(Arrays.asList("https://youtube.com", "https://*.youtube.com")),
                (view, message, origin, mainFrame, reply) -> {
                    if (!mainFrame || !"https".equals(origin.getScheme()) || !HostRules.isYouTubeHost(origin.getHost())) return;
                    try {
                        String value = message.getData();
                        if (value == null || value.length() > 100000) return;
                        receive(new JSONObject(value));
                    } catch (Exception ignored) { }
                });
            bridgeReady = true;
        }
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                String target = youtubeUrl(request.getUrl());
                if (target != null) {
                    if (!target.equals(request.getUrl().toString())) { navigate(target); return true; }
                    return false;
                }
                if (listener != null && request.hasGesture() && "https".equals(request.getUrl().getScheme())) listener.external(request.getUrl());
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (DownloadPolicy.allowed(url)) main.post(() -> observeStream(url));
                HostRules current = rules;
                if (current != null && current.shouldBlock(url, topHost, request.isForMainFrame(), enabled, ads, trackers)) {
                    int count = blocked.incrementAndGet();
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                topHost = HostRules.hostOf(url); resetVideo(DownloadPolicy.videoId(url)); error = ""; progress = 1; changed();
            }
            @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                resetVideo(DownloadPolicy.videoId(url)); action("refresh", null); changed();
            }
            @Override public void onPageFinished(WebView view, String url) {
                progress = 100;
                if (!documentStart && HostRules.isYouTubeHost(topHost)) {
                    view.evaluateJavascript((enabled && helper ? domSource : "") + "\n" + mediaSource, null);
                }
                action("background", background); changed();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError failure) {
                if (request.isForMainFrame()) { error = "Connection interrupted. Open Tools → Settings → Reload video."; progress = 100; changed(); }
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Let Android recreate the service and screen instead of retaining a dead player.
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { progress = value; changed(); }
            @Override public void onReceivedTitle(WebView view, String value) {
                if (!videoId.isEmpty() && value != null) {
                    title = value.replaceFirst(" - YouTube$", ""); if (title.length() > 200) title = title.substring(0, 200);
                    changed();
                }
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (listener != null) listener.fullscreen(view, callback); else callback.onCustomViewHidden();
            }
            @Override public void onHideCustomView() { if (listener != null) listener.exitFullscreen(); }
        });
        loader.execute(() -> {
            try {
                rules = RuleStore.load(service.getAssets());
                runtimeSource = RuleStore.text(service.getAssets(), "youtube-runtime.js");
                playerSource = RuleStore.text(service.getAssets(), "youtube-player.js");
                domSource = RuleStore.text(service.getAssets(), "youtube-dom.js");
                mediaSource = RuleStore.text(service.getAssets(), "harbortube-media.js");
                main.post(() -> { if (!destroyed) { ready = true; installScript(); navigate(initialUrl); changed(); } });
            } catch (Exception failure) { main.post(() -> { error = "Could not load local filters. Reopen HarborTube."; changed(); }); }
        });
    }
    public void attach(Context activity, Listener target) { wrapper.setBaseContext(activity); listener = target; web.onResume(); changed(); }
    public void detach() { listener = null; wrapper.setBaseContext(context); }
    public int blocked() { return blocked.get(); }
    public boolean protectedNow() { return enabled; }
    public String status() { return !error.isEmpty() ? error : !ready ? "Preparing your player…" : !enabled ? "Protection paused" : "Shield on · " + blocked.get() + " blocked"; }
    private void changed() {
        if (destroyed || listener == null || uiPending) return;
        uiPending = true; main.postDelayed(notifyUi, 80);
    }
    public void setDetails(boolean value) { action("details", value); }
    public void readSettings() {
        enabled = preferences.getBoolean("enabled", true); ads = preferences.getBoolean("ads", true);
        trackers = preferences.getBoolean("trackers", true); helper = preferences.getBoolean("helper", true);
    }
    public void applyProtection(boolean[] values) {
        preferences.edit().putBoolean("enabled", values[0]).putBoolean("helper", values[1])
            .putBoolean("ads", values[2]).putBoolean("trackers", values[3]).apply();
        readSettings(); installScript(); if (ready) web.reload(); changed();
    }
    public boolean[] protection() { return new boolean[]{enabled, helper, ads, trackers}; }
    private void installScript() {
        if (script != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) { script.remove(); script = null; }
        documentStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        boolean active = enabled && helper;
        String code = "(()=>{if(location.protocol!=='https:'||!/(^|\\.)youtube\\.com$/.test(location.hostname))return;"
            + "window.__harborGuardYouTubeEnabled=" + active + ";" + runtimeSource + "\n" + playerSource + "\n"
            + (active ? domSource : "") + "\n" + mediaSource + "\nwindow.__harborTubeAction?.('background'," + background + ");})();";
        script = WebViewCompat.addDocumentStartJavaScript(web, code, new HashSet<>(Arrays.asList("https://youtube.com", "https://*.youtube.com")));
    }
    public static String youtubeUrl(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null
            || (uri.getPort() != -1 && uri.getPort() != 443)) return null;
        String host = HostRules.hostOf(uri.toString());
        if (host.equals("youtu.be")) {
            String id = uri.getLastPathSegment();
            return id != null && id.matches("[A-Za-z0-9_-]{11}") ? "https://m.youtube.com/watch?v=" + id : null;
        }
        return HostRules.isYouTubeHost(host) ? uri.toString() : null;
    }
    public void navigate(String url) {
        String target = youtubeUrl(Uri.parse(url));
        if (target == null) return;
        initialUrl = target;
        if (!ready) return;
        topHost = HostRules.hostOf(target); web.loadUrl(target);
    }
    public void action(String action, Object value) {
        if (!ready) return;
        String argument = value instanceof Boolean || value instanceof Number ? String.valueOf(value) : "null";
        web.evaluateJavascript("window.__harborTubeAction?.(" + JSONObject.quote(action) + "," + argument + ")", null);
    }
    private void receive(JSONObject json) {
        String type = json.optString("type"), id = json.optString("id");
        String current = DownloadPolicy.videoId(web.getUrl() == null ? "" : web.getUrl());
        if (!id.equals(current)) return;
        resetVideo(id);
        if ("formats".equals(type) && id.matches("[A-Za-z0-9_-]{11}")) {
            catalogData = json; catalogFromPlayer = true; catalogRevision++;
            for (String url : observedMedia) resolveStream(url);
            changed();
        }
        if ("state".equals(type)) {
            title = json.optString("title", "HarborTube"); if (title.length() > 200) title = title.substring(0, 200);
            if (catalogData != null && !title.equals(catalogData.optString("title"))) try { catalogData.put("title", title); catalogRevision++; } catch (Exception ignored) { }
            position = finite(json.optDouble("position")); duration = finite(json.optDouble("duration"));
            playing = !id.isEmpty() && json.optBoolean("playing"); ad = json.optBoolean("ad");
            if (mediaListener != null) mediaListener.mediaChanged(); changed();
        }
        if ("stream".equals(type) && !ad && id.matches("[A-Za-z0-9_-]{11}")) {
            String url = DownloadPolicy.completeUrl(json.optString("url"));
            if (url.isEmpty()) return;
            if (reportedMedia.contains(url)) return;
            if (reportedMedia.size() >= 40) reportedMedia.remove(reportedMedia.iterator().next()); reportedMedia.add(url);
            observeStream(url);
            addObservedFormat(url);
            changed();
        }
    }
    private void resetVideo(String id) {
        if (videoId.equals(id)) return;
        videoId = id; catalogData = null; catalogFromPlayer = false; catalogRevision++; observedMedia.clear(); reportedMedia.clear(); position = duration = 0; playing = ad = false;
    }
    private double finite(double value) { return Double.isFinite(value) && value >= 0 ? Math.min(value, 7 * 86400) : 0; }
    private void observeStream(String url) {
        String complete = DownloadPolicy.completeUrl(url);
        if (complete.isEmpty()) return;
        if (observedMedia.contains(complete)) return;
        if (observedMedia.size() >= 40) observedMedia.removeFirst(); observedMedia.addLast(complete);
        resolveStream(complete);
    }
    private void resolveStream(String url) {
        if (destroyed || catalogData == null || !videoId.equals(catalogData.optString("id"))) return;
        Uri observed = Uri.parse(url); String cdnId = observed.getQueryParameter("id"), itag = observed.getQueryParameter("itag");
        if (cdnId == null || itag == null) return;
        JSONArray formats = catalogData.optJSONArray("formats");
        if (formats == null) return;
        for (int i = 0; i < Math.min(formats.length(), 40); i++) {
            JSONObject format = formats.optJSONObject(i);
            if (format == null || !DownloadPolicy.allowed(format.optString("url"))) continue;
            Uri candidate = Uri.parse(format.optString("url"));
            if (cdnId.equals(candidate.getQueryParameter("id")) && itag.equals(candidate.getQueryParameter("itag"))) {
                if (format.optBoolean("resolved") && url.equals(format.optString("url"))) return;
                try { format.put("url", url); format.put("resolved", true); } catch (Exception ignored) { }
                catalogRevision++; changed();
            }
        }
    }
    private void addObservedFormat(String url) {
        StreamFormat descriptor = StreamFormat.observed(url);
        if (descriptor == null || videoId.isEmpty()) return;
        try {
            if (catalogData == null) catalogData = new JSONObject().put("id", videoId).put("title", title).put("formats", new JSONArray());
            JSONArray formats = catalogData.optJSONArray("formats");
            if (formats == null || formats.length() >= 40) return;
            String cdn = StreamFormat.parameter(url, "id"), tag = StreamFormat.parameter(url, "itag");
            // When player metadata exists it identifies the correct CDN media;
            // ignore trailing requests from a previous video or an advertisement.
            boolean knownCdn = !catalogFromPlayer || formats.length() == 0;
            for (int i = 0; i < formats.length(); i++) {
                JSONObject f = formats.optJSONObject(i); if (f == null) continue;
                String candidate = f.optString("url");
                if (cdn.equals(StreamFormat.parameter(candidate, "id"))) knownCdn = true;
                if (cdn.equals(StreamFormat.parameter(candidate, "id")) && tag.equals(StreamFormat.parameter(candidate, "itag"))) return;
            }
            if (!knownCdn) return;
            formats.put(new JSONObject().put("url", url).put("resolved", true).put("mime", descriptor.mime)
                .put("height", descriptor.height).put("bitrate", descriptor.bitrate).put("combined", descriptor.combined));
            catalogRevision++;
        } catch (Exception ignored) { }
    }
    public DownloadCatalog downloads() {
        if (catalogData == null || !videoId.equals(catalogData.optString("id"))) return null;
        if (cachedRevision != catalogRevision) { cachedRevision = catalogRevision; cachedCatalog = new DownloadCatalog(catalogData, android.os.Build.VERSION.SDK_INT); }
        return cachedCatalog;
    }
    public int formatCount() { return catalogData == null || catalogData.optJSONArray("formats") == null ? 0 : catalogData.optJSONArray("formats").length(); }
    public void setBackground(boolean value) { background = value; action("background", value); installScript(); changed(); }
    public void suspendScreen() { if (!background) { action("pause", null); web.onPause(); } }
    public void resumeScreen() { web.onResume(); }
    public void destroy() {
        destroyed = true; listener = null; mediaListener = null; loader.shutdownNow(); main.removeCallbacksAndMessages(null);
        if (script != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) script.remove();
        web.destroy();
    }
}
