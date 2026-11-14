package app.harborguard.youtube;

import java.io.IOException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Validate contiguous CDN responses before appending them to the output. */
public final class DownloadRange {
    public static final long CHUNK = 1024 * 1024;
    public final long length, total;
    private DownloadRange(long length, long total) { this.length = length; this.total = total; }
    public static DownloadRange response(int code, String range, long length, long offset, long hint) throws IOException {
        if (range != null) {
            Matcher m = Pattern.compile("bytes ([0-9]+)-([0-9]+)/([0-9]+)").matcher(range);
            if (!m.matches()) throw new IOException("Invalid media range from server");
            try {
                long start = Long.parseLong(m.group(1)), end = Long.parseLong(m.group(2)), total = Long.parseLong(m.group(3));
                if (start != offset || end < start || end >= total || hint > 0 && hint != total
                    || length >= 0 && length != end - start + 1) throw new IOException("The server returned a different media range. Retry the video.");
                return new DownloadRange(end - start + 1, total);
            } catch (NumberFormatException e) { throw new IOException("Invalid media length", e); }
        }
        if (code == 206) throw new IOException("Partial media response has no range");
        // Googlevideo's unsigned range query can return HTTP 200 for a slice.
        // The signed URL's clen identifies the complete file length.
        if (hint > 0) {
            long remaining = hint - offset;
            if (remaining <= 0 || length > remaining || offset > 0 && length != Math.min(CHUNK, remaining)
                || offset == 0 && length > 0 && length != hint && length != Math.min(CHUNK, hint))
                throw new IOException("The server ignored the requested media range");
            return new DownloadRange(length < 0 ? remaining : length, hint);
        }
        if (offset != 0) throw new IOException("Cannot resume media without its total length");
        return new DownloadRange(length, length);
    }
    public static long lengthHint(String url) {
        try { long length = Long.parseLong(StreamFormat.parameter(url, "clen")); return length > 0 ? length : -1; }
        catch (NumberFormatException e) { return -1; }
    }
}
