package app.harborguard.youtube;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.*;

/** User-enabled foreground audio session; the same WebView keeps playing. */
public final class PlayerService extends Service {
    private static final int NOTIFICATION = 81;
    private static final String CHANNEL = "harbortube_playback";
    public final class LocalBinder extends Binder { public PlayerService service() { return PlayerService.this; } }
    private final LocalBinder binder = new LocalBinder();
    public BrowserEngine engine;
    private MediaSession session;
    private PowerManager.WakeLock wake;
    private boolean foreground;
    private final Handler main = new Handler(Looper.getMainLooper());
    private String lastNotification = "";
    private long renewWakeAt;
    private String lastMediaTitle = "";
    private long lastMediaDuration = -1;
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { if (engine != null) engine.action("pause", null); }
    };
    @Override public void onCreate() {
        super.onCreate();
        // Chromium already owns audio focus for the HTML video. A second focus
        // request from this service can cause Chromium to pause that same video.
        wake = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HarborTube:audio");
        wake.setReferenceCounted(false);
        session = new MediaSession(this, "HarborTube");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { if (engine != null) engine.action("play", null); }
            @Override public void onPause() { if (engine != null) engine.action("pause", null); }
            @Override public void onStop() { stopAudio(); }
            @Override public void onSeekTo(long position) { if (engine != null) engine.action("seek", position / 1000.0); }
        });
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Background music", NotificationManager.IMPORTANCE_LOW));
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED); else registerReceiver(noisy, filter);
    }
    @Override public IBinder onBind(Intent intent) { return binder; }
    public BrowserEngine initialize(Activity activity) {
        // Construct the WebView with a real window context, as in the working
        // 0.1 release. Retain it only while this bound/background service lives.
        if (engine == null) { engine = new BrowserEngine(activity); engine.mediaListener = this::updateMedia; }
        return engine;
    }
    public boolean setBackground(boolean enabled) {
        if (engine == null) return false;
        if (enabled && (!engine.bridgeReady || !engine.documentStart || engine.videoId.isEmpty())) return false;
        if (enabled) {
            engine.setBackground(true);
            Intent started = new Intent(this, PlayerService.class);
            startService(started); // Called from the visible Activity; foreground promotion follows immediately.
            Notification notification = notification();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIFICATION, notification);
            foreground = true; session.setActive(true); updateMedia();
        } else stopAudio(false);
        return true;
    }
    private PendingIntent action(String value) {
        return PendingIntent.getService(this, value.hashCode(), new Intent(this, PlayerService.class).setAction(value), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification).setColor(Ui.MINT)
            .setContentTitle(engine.title).setContentText(engine.playing ? "Playing in background" : "Paused · background audio")
            .setContentIntent(open).setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true).setOngoing(engine.playing)
            .addAction(new Notification.Action.Builder(engine.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                engine.playing ? "Pause" : "Play", action(engine.playing ? "pause" : "play")).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Stop", action("stop")).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1)).build();
    }
    private void updateMedia() {
        if (engine == null || !foreground) return;
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP;
        if (engine.duration > 0) actions |= PlaybackState.ACTION_SEEK_TO;
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
            .setState(engine.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, (long)(engine.position * 1000), engine.playing ? 1 : 0).build());
        long duration = (long)(engine.duration * 1000);
        if (!lastMediaTitle.equals(engine.title) || lastMediaDuration != duration) {
            lastMediaTitle = engine.title; lastMediaDuration = duration;
            session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, engine.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "HarborTube").putLong(MediaMetadata.METADATA_KEY_DURATION, duration).build());
        }
        if (foreground && engine.playing) {
            long now = SystemClock.elapsedRealtime();
            if (!wake.isHeld() || now >= renewWakeAt) { wake.acquire(10 * 60 * 1000L); renewWakeAt = now + 8 * 60 * 1000L; }
        }
        else if (wake.isHeld()) wake.release();
        if (foreground) {
            String key = engine.title + engine.playing;
            if (!key.equals(lastNotification)) { lastNotification = key; getSystemService(NotificationManager.class).notify(NOTIFICATION, notification()); }
        }
    }
    private void stopAudio() {
        stopAudio(true);
    }
    private void stopAudio(boolean pause) {
        if (engine != null) { engine.setBackground(false); if (pause) engine.action("pause", null); }
        foreground = false;
        stopForeground(STOP_FOREGROUND_REMOVE); session.setActive(false); lastNotification = "";
        if (wake.isHeld()) wake.release();
        stopSelf();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            if ("stop".equals(intent.getAction())) stopAudio();
            else if (engine != null && "play".equals(intent.getAction())) engine.action("play", null);
            else if (engine != null && "pause".equals(intent.getAction())) engine.action("pause", null);
            else if (engine == null) stopSelf();
        }
        return START_NOT_STICKY;
    }
    @Override public void onTaskRemoved(Intent intent) { stopAudio(); }
    @Override public void onDestroy() {
        main.removeCallbacksAndMessages(null); unregisterReceiver(noisy); session.release();
        if (wake.isHeld()) wake.release(); if (engine != null) engine.destroy(); super.onDestroy();
    }
}
