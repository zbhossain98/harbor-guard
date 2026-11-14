package app.harborguard.youtube;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.net.Uri;
import android.os.*;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

/** One cancellable download at a time; local muxing never re-encodes media. */
public final class DownloadService extends Service {
    public static final String UPDATE = "app.harborguard.youtube.DOWNLOAD_UPDATE";
    private static final String CHANNEL = "harbortube_downloads";
    private static final int NOTICE = 82;
    private static final long LIMIT = 2L * 1024 * 1024 * 1024;
    public static volatile boolean busy;
    public static volatile String status = "", currentTitle = "";
    public static volatile int percent = -1;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancel;
    private volatile HttpURLConnection connection;
    private long started, totalBytes, lastUpdate;
    private PowerManager.WakeLock wake;
    private String filename, mime, video, audio, agent;
    private Uri destination;
    private boolean ownDestination;
    private boolean webm;

    public static Intent request(Context context, DownloadCatalog.Option option, String userAgent, Uri destination) {
        Intent intent = new Intent(context, DownloadService.class).setAction("download")
            .putExtra("title", option.title).putExtra("filename", option.filename()).putExtra("video", option.video)
            .putExtra("audio", option.audio).putExtra("audioOnly", option.audioOnly).putExtra("webm", option.webm).putExtra("agent", userAgent);
        if (destination != null) intent.putExtra("destination", destination.toString());
        return intent;
    }
    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW));
        wake = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HarborTube:download");
        wake.setReferenceCounted(false);
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        if ("cancel".equals(intent.getAction())) {
            cancel = true; HttpURLConnection current = connection; if (current != null) current.disconnect();
            return START_NOT_STICKY;
        }
        if (busy) return START_NOT_STICKY;
        video = intent.getStringExtra("video"); audio = intent.getStringExtra("audio");
        boolean audioOnly = intent.getBooleanExtra("audioOnly", false);
        if (video == null || audio == null || (audioOnly ? !DownloadPolicy.allowed(audio) : !DownloadPolicy.allowed(video))
            || (!audio.isEmpty() && !DownloadPolicy.allowed(audio))) { stopSelf(); return START_NOT_STICKY; }
        currentTitle = intent.getStringExtra("title"); if (currentTitle == null) currentTitle = "HarborTube";
        webm = intent.getBooleanExtra("webm", false);
        filename = DownloadPolicy.filename(currentTitle, audioOnly, webm); mime = (audioOnly ? "audio/" : "video/") + (webm ? "webm" : "mp4");
        agent = intent.getStringExtra("agent"); if (agent == null) agent = "HarborTube/0.2.0";
        String target = intent.getStringExtra("destination"); destination = target == null ? null : Uri.parse(target);
        if (destination != null && !"content".equals(destination.getScheme())) { stopSelf(); return START_NOT_STICKY; }
        busy = true; cancel = false; status = "Preparing download"; percent = -1; started = SystemClock.elapsedRealtime(); totalBytes = 0;
        Notification notice = progressNotification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTICE, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTICE, notice);
        wake.acquire(30 * 60 * 1000L);
        worker.execute(() -> download(audioOnly)); broadcast();
        return START_NOT_STICKY;
    }
    private PendingIntent cancelAction() {
        return PendingIntent.getService(this, 82, new Intent(this, DownloadService.class).setAction("cancel"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    private Notification progressNotification() {
        PendingIntent open = PendingIntent.getActivity(this, 82, new Intent(this, MainActivity.class).setAction("downloads").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification).setColor(Ui.MINT)
            .setContentTitle(currentTitle).setContentText(status).setContentIntent(open).setOnlyAlertOnce(true).setOngoing(true)
            .setProgress(100, Math.max(0, percent), percent < 0)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Cancel", cancelAction()).build()).build();
    }
    private void broadcast() { sendBroadcast(new Intent(UPDATE).setPackage(getPackageName())); }
    private void progress(String value, int amount) {
        status = value.length() > 240 ? value.substring(0, 240) : value; percent = amount;
        long now = SystemClock.elapsedRealtime();
        if (now - lastUpdate < 1000) return;
        lastUpdate = now; getSystemService(NotificationManager.class).notify(NOTICE, progressNotification()); broadcast();
    }
    private void check() throws IOException {
        if (cancel || Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
        if (SystemClock.elapsedRealtime() - started > 30 * 60 * 1000L) throw new IOException("Download timed out. Try a lower quality.");
    }
    private File fetch(String value, int index, int count) throws Exception {
        String base = DownloadPolicy.completeUrl(value);
        if (base.isEmpty()) throw new IOException("This stream cannot be saved as a complete file.");
        long received = 0, total = DownloadRange.lengthHint(base);
        if (total > LIMIT) throw new IOException("Choose a smaller download (maximum 2 GB).");
        File file = File.createTempFile("harbortube-", ".part", getCacheDir());
        try (OutputStream output = new FileOutputStream(file)) {
            do {
                check();
                long end = received + DownloadRange.CHUNK - 1;
                if (total > 0) end = Math.min(end, total - 1);
                String full = base + (base.contains("?") ? "&" : "?") + "range=" + received + "-" + end;
                boolean fetched = false;
                for (int redirect = 0; redirect < 4; redirect++) {
                    check();
                    if (!DownloadPolicy.allowed(full)) throw new IOException("Unsupported download host");
                    HttpURLConnection request = (HttpURLConnection)new URL(full).openConnection(); connection = request;
                    try {
                        request.setInstanceFollowRedirects(false); request.setConnectTimeout(20000); request.setReadTimeout(30000);
                        request.setRequestProperty("User-Agent", agent); request.setRequestProperty("Accept-Encoding", "identity");
                        request.setRequestProperty("Range", "bytes=" + received + "-" + end);
                        String cookie = CookieManager.getInstance().getCookie(full); if (cookie != null) request.setRequestProperty("Cookie", cookie);
                        int code = request.getResponseCode();
                        if (code >= 300 && code < 400) {
                            String location = request.getHeaderField("Location");
                            full = location == null ? "" : new URL(new URL(full), location).toString(); continue;
                        }
                        if (code != 200 && code != 206) throw new IOException("YouTube rejected this stream (HTTP " + code + "). Reload the video and retry.");
                        DownloadRange range = DownloadRange.response(code, request.getHeaderField("Content-Range"), request.getContentLengthLong(), received, total);
                        total = range.total;
                        if (total > LIMIT) throw new IOException("Choose a smaller download (maximum 2 GB).");
                        long chunk = 0;
                        try (InputStream input = request.getInputStream()) {
                            byte[] bytes = new byte[131072]; int length;
                            while ((length = input.read(bytes)) != -1) {
                                check(); chunk += length; totalBytes += length;
                                if (totalBytes > LIMIT || range.length >= 0 && chunk > range.length) throw new IOException("Media exceeds the expected size");
                                output.write(bytes, 0, length);
                                int amount = total > 0 ? (int)((index + Math.min(1, (received + chunk) / (double)total)) * 88 / count) : -1;
                                progress("Downloading · " + (totalBytes / 1048576) + " MB", amount);
                            }
                        }
                        if (chunk == 0 || range.length >= 0 && chunk != range.length) throw new IOException("Incomplete download. Please retry.");
                        received += chunk; fetched = true;
                        break;
                    } finally { request.disconnect(); connection = null; }
                }
                if (!fetched) throw new IOException("Too many stream redirects");
            } while (total > 0 && received < total);
            return file;
        } catch (Exception error) { file.delete(); throw error; }
    }
    private int track(MediaExtractor extractor, String kind) {
        for (int i = 0; i < extractor.getTrackCount(); i++) {
            String type = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
            if (kind.equals(type)) return i;
        }
        return -1;
    }
    private File mux(File videoFile, File audioFile) throws Exception {
        File output = File.createTempFile("harbortube-", webm ? ".webm" : ".mp4", getCacheDir());
        MediaExtractor videoTrack = new MediaExtractor(), audioTrack = new MediaExtractor();
        MediaMuxer muxer = null; boolean success = false;
        try {
            videoTrack.setDataSource(videoFile.getAbsolutePath()); audioTrack.setDataSource(audioFile.getAbsolutePath());
            int v = track(videoTrack, webm ? "video/x-vnd.on2.vp9" : "video/avc"), a = audioTrack(audioTrack);
            if (v < 0 || a < 0) throw new IOException("This stream cannot be combined on this phone.");
            muxer = new MediaMuxer(output.getAbsolutePath(), webm ? MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM : MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int outV = muxer.addTrack(videoTrack.getTrackFormat(v)), outA = muxer.addTrack(audioTrack.getTrackFormat(a));
            muxer.start(); copyTrack(videoTrack, v, muxer, outV); copyTrack(audioTrack, a, muxer, outA); muxer.stop(); success = true;
            return output;
        } finally {
            videoTrack.release(); audioTrack.release(); if (muxer != null) muxer.release(); if (!success) output.delete();
        }
    }
    private void copyTrack(MediaExtractor extractor, int source, MediaMuxer muxer, int target) throws Exception {
        extractor.selectTrack(source);
        MediaFormat format = extractor.getTrackFormat(source);
        int size = format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) ? format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) : 8 * 1024 * 1024;
        if (size > 16 * 1024 * 1024) throw new IOException("Unsupported media frame size");
        ByteBuffer bytes = ByteBuffer.allocate(Math.max(size, 1024 * 1024)); MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (true) {
            check(); bytes.clear(); int length = extractor.readSampleData(bytes, 0); if (length < 0) break;
            info.set(0, length, extractor.getSampleTime(), (extractor.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0 ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0);
            muxer.writeSampleData(target, bytes, info); extractor.advance();
        }
    }
    private void validate(File file, boolean audioOnly) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(file.getAbsolutePath());
            if (audioTrack(extractor) < 0 || !audioOnly && track(extractor, webm ? "video/x-vnd.on2.vp9" : "video/avc") < 0) throw new IOException("The downloaded stream has no playable video/audio tracks.");
        } finally { extractor.release(); }
    }
    private int audioTrack(MediaExtractor extractor) {
        if (!webm) return track(extractor, "audio/mp4a-latm");
        int opus = track(extractor, "audio/opus"); return opus >= 0 ? opus : track(extractor, "audio/vorbis");
    }
    private void save(File file) throws Exception {
        check();
        if (Build.VERSION.SDK_INT >= 29 && destination == null) {
            ContentValues values = new ContentValues(); values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime); values.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/HarborTube");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            destination = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values); ownDestination = true;
        }
        if (destination == null) throw new IOException("No save location selected");
        try (InputStream input = new FileInputStream(file); OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
            if (output == null) throw new IOException("Cannot write to the save location");
            byte[] bytes = new byte[131072]; int length;
            while ((length = input.read(bytes)) != -1) { check(); output.write(bytes, 0, length); }
        }
        check();
        if (Build.VERSION.SDK_INT >= 29 && ownDestination) {
            ContentValues values = new ContentValues(); values.put(MediaStore.MediaColumns.IS_PENDING, 0); getContentResolver().update(destination, values, null, null);
        }
        JSONArray saved;
        try { saved = new JSONArray(getSharedPreferences("downloads", MODE_PRIVATE).getString("items", "[]")); } catch (Exception error) { saved = new JSONArray(); }
        JSONArray next = new JSONArray();
        next.put(new JSONObject().put("title", currentTitle).put("uri", destination.toString()).put("mime", mime).put("file", filename).put("date", System.currentTimeMillis()));
        for (int i = 0; i < Math.min(saved.length(), 49); i++) next.put(saved.get(i));
        getSharedPreferences("downloads", MODE_PRIVATE).edit().putString("items", next.toString()).apply();
    }
    private void download(boolean audioOnly) {
        File first = null, second = null, result = null; boolean complete = false;
        try {
            boolean combine = !audioOnly && !audio.isEmpty();
            first = fetch(audioOnly ? audio : video, 0, combine ? 2 : 1);
            if (combine) { second = fetch(audio, 1, 2); progress("Combining video + audio", 90); result = mux(first, second); }
            else result = first;
            validate(result, audioOnly); progress("Saving to Downloads", 96); save(result); complete = true; status = "Saved · " + filename; percent = 100;
        } catch (Exception error) {
            status = cancel ? "Download cancelled" : error.getMessage() == null ? "Download failed. Play the video and retry." : error.getMessage(); percent = -1;
            if (status.length() > 240) status = status.substring(0, 240);
            if (ownDestination && destination != null) try { getContentResolver().delete(destination, null, null); } catch (Exception ignored) { }
        } finally {
            HttpURLConnection current = connection; if (current != null) current.disconnect(); connection = null;
            if (first != null) first.delete(); if (second != null) second.delete(); if (result != null && result != first) result.delete();
            busy = false; if (wake.isHeld()) wake.release(); stopForeground(STOP_FOREGROUND_REMOVE);
            Notification.Builder done = new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification).setContentTitle(currentTitle).setContentText(status).setAutoCancel(true);
            if (complete) {
                Intent open = new Intent(Intent.ACTION_VIEW).setDataAndType(destination, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                done.setContentIntent(PendingIntent.getActivity(this, 83, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            }
            getSystemService(NotificationManager.class).notify(83, done.build()); broadcast(); stopSelf();
        }
    }
    @Override public void onTimeout(int startId, int type) { cancel = true; HttpURLConnection current = connection; if (current != null) current.disconnect(); stopSelf(); }
    @Override public void onDestroy() { cancel = true; worker.shutdownNow(); HttpURLConnection current = connection; if (current != null) current.disconnect(); if (wake.isHeld()) wake.release(); super.onDestroy(); }
}
