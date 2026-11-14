package app.harborguard.youtube;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;

public final class DownloadCatalog {
    public static final class Option {
        public final String title, label, video, audio, mime;
        public final boolean audioOnly, webm;
        public final int height;
        Option(String title, String label, String video, String audio, boolean audioOnly, int height, boolean webm) {
            this.title = title; this.label = label; this.video = video; this.audio = audio;
            this.audioOnly = audioOnly; this.height = height; this.webm = webm;
            this.mime = (audioOnly ? "audio/" : "video/") + (webm ? "webm" : "mp4");
        }
        public String filename() { return DownloadPolicy.filename(title, audioOnly, webm); }
    }
    public final String id, title;
    public final List<Option> options = new ArrayList<>();
    public DownloadCatalog(JSONObject json, int androidApi) {
        id = json.optString("id"); title = json.optString("title", "HarborTube");
        JSONArray formats = json.optJSONArray("formats");
        if (formats == null || !id.matches("[A-Za-z0-9_-]{11}")) return;
        JSONObject bestAudio = null, webAudio = null, muxAudio = null;
        for (int i = 0; i < Math.min(formats.length(), 40); i++) {
            JSONObject f = formats.optJSONObject(i);
            if (f == null || !f.optBoolean("resolved", true) || !DownloadPolicy.allowed(f.optString("url"))) continue;
            String mime = f.optString("mime");
            if (mime.startsWith("audio/mp4") && mime.contains("mp4a")
                && (bestAudio == null || f.optInt("bitrate") > bestAudio.optInt("bitrate"))) bestAudio = f;
            if (mime.startsWith("audio/webm") && (mime.contains("opus") || mime.contains("vorbis"))) {
                if (webAudio == null || f.optInt("bitrate") > webAudio.optInt("bitrate")) webAudio = f;
                // Android's WebM muxer gained Opus support in API 29. Direct
                // audio-only WebM does not require muxing on older phones.
                if ((androidApi >= 29 || mime.contains("vorbis")) && (muxAudio == null || f.optInt("bitrate") > muxAudio.optInt("bitrate"))) muxAudio = f;
            }
        }
        HashSet<String> heights = new HashSet<>();
        for (int i = 0; i < Math.min(formats.length(), 40); i++) {
            JSONObject f = formats.optJSONObject(i);
            if (f == null || !f.optBoolean("resolved", true) || !DownloadPolicy.allowed(f.optString("url"))) continue;
            int height = f.optInt("height"); String mime = f.optString("mime");
            boolean webm = mime.startsWith("video/webm") && (mime.contains("vp9") || mime.contains("vp09"));
            if (height < 1 || height > 2160 || !(webm || mime.startsWith("video/mp4") && mime.contains("avc1")) || heights.contains(height + ":" + webm)) continue;
            boolean combined = f.optBoolean("combined");
            JSONObject audio = webm ? muxAudio : bestAudio;
            if (combined || audio != null) {
                heights.add(height + ":" + webm);
                options.add(new Option(title, height + "p · " + (webm ? "WebM" : "MP4"), f.optString("url"), combined ? "" : audio.optString("url"), false, height, webm));
            }
        }
        options.sort(Comparator.comparingInt((Option o) -> o.height).reversed());
        if (bestAudio != null) options.add(new Option(title, "Audio only · M4A", "", bestAudio.optString("url"), true, 0, false));
        if (webAudio != null) options.add(new Option(title, "Audio only · WebM", "", webAudio.optString("url"), true, 0, true));
    }
}
