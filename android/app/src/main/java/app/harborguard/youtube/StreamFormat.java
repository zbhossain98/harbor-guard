package app.harborguard.youtube;

import java.net.URI;
import java.net.URLDecoder;

/** Fallback descriptors for formats actually requested by the current player. */
public final class StreamFormat {
    public final String mime;
    public final int height, bitrate;
    public final boolean combined;
    private StreamFormat(String mime, int height, int bitrate, boolean combined) {
        this.mime = mime; this.height = height; this.bitrate = bitrate; this.combined = combined;
    }
    public static String parameter(String url, String name) {
        try {
            String query = URI.create(url).getRawQuery();
            if (query != null) for (String pair : query.split("&")) {
                String[] parts = pair.split("=", 2);
                if (URLDecoder.decode(parts[0], "UTF-8").equals(name)) return parts.length < 2 ? "" : URLDecoder.decode(parts[1], "UTF-8");
            }
        } catch (Exception ignored) { }
        return "";
    }
    public static StreamFormat observed(String url) {
        if (!DownloadPolicy.allowed(url) || !"youtube".equals(parameter(url, "source"))) return null;
        int tag;
        try { tag = Integer.parseInt(parameter(url, "itag")); } catch (NumberFormatException e) { return null; }
        switch (tag) {
            case 18: return new StreamFormat("video/mp4; codecs=avc1,mp4a", 360, 0, true);
            case 22: return new StreamFormat("video/mp4; codecs=avc1,mp4a", 720, 0, true);
            case 133: return avc(240);
            case 134: return avc(360);
            case 135: return avc(480);
            case 136: case 298: return avc(720);
            case 137: case 299: return avc(1080);
            case 160: return avc(144);
            case 140: return new StreamFormat("audio/mp4; codecs=mp4a", 0, 128000, false);
            case 139: return new StreamFormat("audio/mp4; codecs=mp4a", 0, 48000, false);
            case 141: return new StreamFormat("audio/mp4; codecs=mp4a", 0, 256000, false);
            case 242: return vp9(240);
            case 243: return vp9(360);
            case 244: return vp9(480);
            case 247: case 302: return vp9(720);
            case 248: case 303: return vp9(1080);
            case 271: case 308: return vp9(1440);
            case 272: case 313: case 315: return vp9(2160);
            case 278: return vp9(144);
            case 249: return opus(48000);
            case 250: return opus(64000);
            case 251: return opus(160000);
            case 171: return new StreamFormat("audio/webm; codecs=vorbis", 0, 128000, false);
            default: return null; // Never guess DRM, AV1 or live/segmented formats.
        }
    }
    private static StreamFormat avc(int h) { return new StreamFormat("video/mp4; codecs=avc1", h, 0, false); }
    private static StreamFormat vp9(int h) { return new StreamFormat("video/webm; codecs=vp9", h, 0, false); }
    private static StreamFormat opus(int b) { return new StreamFormat("audio/webm; codecs=opus", 0, b, false); }
}
