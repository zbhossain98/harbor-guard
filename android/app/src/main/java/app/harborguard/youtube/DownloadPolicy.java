package app.harborguard.youtube;

import java.net.URI;
import java.net.URLDecoder;
import java.util.Locale;

/** Download URLs are untrusted page data: allow only HTTPS media CDN hosts. */
public final class DownloadPolicy {
    public static String completeUrl(String value) {
        if (!allowed(value)) return "";
        try {
            URI uri = URI.create(value);
            String query = uri.getRawQuery();
            if (query == null) return value;
            String signed = "";
            for (String pair : query.split("&")) {
                if (pair.startsWith("sparams=") || pair.startsWith("lsparams=")) signed += "," + URLDecoder.decode(pair.substring(pair.indexOf('=') + 1), "UTF-8") + ",";
            }
            StringBuilder clean = new StringBuilder();
            for (String pair : query.split("&")) {
                String key = pair.split("=", 2)[0];
                if (key.equals("range") || key.equals("rn") || key.equals("rbuf")) {
                    if (signed.contains("," + key + ",")) return "";
                    continue;
                }
                if (clean.length() > 0) clean.append('&'); clean.append(pair);
            }
            return "https://" + uri.getRawAuthority() + uri.getRawPath() + "?" + clean;
        } catch (Exception error) { return ""; }
    }
    public static boolean allowed(String value) {
        try {
            URI uri = URI.create(value);
            String host = uri.getHost();
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getRawUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443) && host != null
                && (host.toLowerCase(Locale.ROOT).endsWith(".googlevideo.com"))
                && "/videoplayback".equals(uri.getPath()) && value.length() < 12000;
        } catch (RuntimeException error) { return false; }
    }
    public static String filename(String title, boolean audio) {
        return filename(title, audio, false);
    }
    public static String filename(String title, boolean audio, boolean webm) {
        String clean = title.replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|]", " ").replaceAll("\\s+", " ").trim();
        while (clean.startsWith(".")) clean = clean.substring(1).trim();
        if (clean.isEmpty()) clean = "HarborTube";
        if (clean.length() > 100) clean = clean.substring(0, 100);
        return clean + (webm ? ".webm" : audio ? ".m4a" : ".mp4");
    }
    public static String videoId(String value) {
        try {
            URI uri = URI.create(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || !HostRules.isYouTubeHost(HostRules.hostOf(value))) return "";
            if (uri.getPath().startsWith("/shorts/")) {
                String id = uri.getPath().substring(8).split("/")[0];
                return id.matches("[A-Za-z0-9_-]{11}") ? id : "";
            }
            for (String item : (uri.getRawQuery() == null ? "" : uri.getRawQuery()).split("&")) {
                if (item.startsWith("v=") && item.substring(2).matches("[A-Za-z0-9_-]{11}")) return item.substring(2);
            }
        } catch (RuntimeException ignored) { }
        return "";
    }
}
