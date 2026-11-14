package app.harborguard.youtube;
import org.junit.Test;
import static org.junit.Assert.*;
public class DownloadPolicyTest {
    @Test public void onlyMediaCdnDownloadsAreAllowed() {
        assertTrue(DownloadPolicy.allowed("https://r1---sn-a.googlevideo.com/videoplayback?itag=18"));
        for (String url : new String[]{"http://r1.googlevideo.com/videoplayback", "https://r1.googlevideo.com.evil.test/videoplayback",
            "https://googlevideo.com/videoplayback", "https://r1.googlevideo.com:8443/videoplayback", "https://user@r1.googlevideo.com/videoplayback",
            "https://127.0.0.1/videoplayback", "file:///etc/passwd", "https://r1.googlevideo.com/other"}) assertFalse(url, DownloadPolicy.allowed(url));
    }
    @Test public void filenamesCannotEscapeDownloads() {
        assertEquals("hello world.mp4", DownloadPolicy.filename("../hello\\world", false));
        assertEquals("HarborTube.m4a", DownloadPolicy.filename("...", true));
        assertFalse(DownloadPolicy.filename("a\n/b", false).contains("/"));
    }
    @Test public void videoIdsStayScopedToYouTube() {
        assertEquals("abcdefghijk", DownloadPolicy.videoId("https://m.youtube.com/watch?v=abcdefghijk"));
        assertEquals("abcdefghijk", DownloadPolicy.videoId("https://www.youtube.com/shorts/abcdefghijk"));
        assertEquals("", DownloadPolicy.videoId("https://youtube.com.evil.test/watch?v=abcdefghijk"));
        assertEquals("", DownloadPolicy.videoId("https://m.youtube.com/watch?v=short"));
    }
    @Test public void onlyUnsignedChunkHintsCanBeRemoved() {
        assertEquals("https://r1.googlevideo.com/videoplayback?itag=18&sig=a%2Fb", DownloadPolicy.completeUrl("https://r1.googlevideo.com/videoplayback?itag=18&range=0-100&rn=4&sig=a%2Fb"));
        assertEquals("", DownloadPolicy.completeUrl("https://r1.googlevideo.com/videoplayback?range=0-100&sparams=id%2Crange"));
        assertEquals("", DownloadPolicy.completeUrl("https://elsewhere.example/file.mp4"));
    }
}
